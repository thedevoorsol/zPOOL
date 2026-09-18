/**
 * High-level client: unlock, sync notes, deposit (wallet signs), withdraw / send (relayer signs).
 */
import { TOKEN_2022_PROGRAM_ID, calculateEpochFee, getTransferFeeConfig, unpackMint, type TransferFeeConfig } from '@solana/spl-token';
import { AddressLookupTableAccount, Connection, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import {
  AccountRole,
  address as kitAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  type Instruction,
} from '@solana/kit';
import type { Program } from '@coral-xyz/anchor';
import { FIELD_SIZE_BIG, bytesToHex, hexToBytes, poseidonReady } from './crypto';
import { extDataHash, type ExtData } from './extdata';
import { keyDerivationMessage, keysFromSignature, parseShieldedAddress, shieldedAddress, type ShieldKeys } from './keys';
import { encryptNote, tryDecryptNote } from './notes';
import { PROGRAM_ID, ata, computeBudgetIx, createPoolIx, getProgram, hookAccounts, nullifierAccounts, transactSolIx, transactSplIx } from './program';
import { fieldHashToDecimal, prove, publicAmountField, type Artifacts, type CircuitInput, type OnchainProof } from './prover';
import { RelayerApi, type PoolInfo, type RelayerConfig } from './relayerApi';
import { SOL_MINT, commitment, mintField, newUtxo, nullifier, type Utxo } from './utxo';

export type Progress = { step: string; detail?: string; signature?: string };
export type ProgressCb = (p: Progress) => void;

export type OwnedNote = Utxo & { index: number; spent: boolean; nullifierHex: string };

export class ShieldPool {
  readonly connection: Connection;
  readonly relayer: RelayerApi;
  readonly program: Program;
  readonly artifacts: Artifacts;
  keys: ShieldKeys | null = null;
  private notes = new Map<string, OwnedNote[]>();
  private scanned = new Map<string, number>();
  private cfg: RelayerConfig | null = null;
  private transferFees = new Map<string, { at: number; cfg: TransferFeeConfig | null; epoch: bigint }>();

  constructor(opts: { connection: Connection; relayerUrl: string; artifacts: Artifacts; programId?: PublicKey }) {
    this.connection = opts.connection;
    this.relayer = new RelayerApi(opts.relayerUrl);
    this.program = getProgram(opts.connection, opts.programId ?? PROGRAM_ID);
    this.artifacts = opts.artifacts;
  }

  static async init(opts: ConstructorParameters<typeof ShieldPool>[0]): Promise<ShieldPool> {
    await poseidonReady();
    return new ShieldPool(opts);
  }

  // ---------- keys ----------
  async unlock(wallet: PublicKey, signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<ShieldKeys> {
    const sig = await signMessage(keyDerivationMessage(wallet.toBase58()));
    this.keys = keysFromSignature(wallet.toBase58(), sig);
    this.notes.clear();
    this.scanned.clear();
    return this.keys;
  }
  isUnlocked(): boolean {
    return this.keys !== null;
  }
  shieldedAddress(): string {
    if (!this.keys) throw new Error('locked');
    return shieldedAddress(this.keys);
  }

  // ---------- config / pools ----------
  async config(): Promise<RelayerConfig> {
    if (!this.cfg) this.cfg = await this.relayer.config();
    return this.cfg;
  }
  async pool(mint: PublicKey): Promise<PoolInfo | null> {
    return this.relayer.pool(mint.toBase58());
  }
  async requirePool(mint: PublicKey): Promise<PoolInfo> {
    const p = await this.pool(mint);
    if (!p) throw new Error(`no pool for ${mint.toBase58()} yet`);
    return p;
  }

  /** Transaction that opens the pool for a mint. Anyone can pay it. Legacy format, wallet-signable. */
  async createPoolTx(mint: PublicKey, payer: PublicKey): Promise<VersionedTransaction> {
    const tokenProgram = await this.tokenProgramOf(mint);
    const ix = await createPoolIx(this.program, mint, tokenProgram, payer);
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToLegacyMessage();
    return new VersionedTransaction(msg);
  }

  /**
   * The token account a wallet should deposit from: its associated account when that holds the most,
   * otherwise the largest other account for the mint (DEX routers often leave coins in an auxiliary account).
   */
  async tokenAccountFor(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Promise<{ address: PublicKey; amount: bigint }> {
    const assoc = ata(owner, mint, tokenProgram);
    let best: { address: PublicKey; amount: bigint } = { address: assoc, amount: 0n };
    try {
      const res = await this.connection.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed');
      for (const { pubkey, account } of res.value) {
        const amount = BigInt(account.data.parsed?.info?.tokenAmount?.amount ?? '0');
        if (amount > best.amount || (amount === best.amount && pubkey.equals(assoc))) best = { address: pubkey, amount };
      }
    } catch {
      /* fall back to the associated account */
    }
    return best;
  }

  async tokenProgramOf(mint: PublicKey): Promise<PublicKey> {
    if (mint.equals(SOL_MINT)) return SOL_MINT;
    const info = await this.connection.getAccountInfo(mint);
    if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
    return info.owner;
  }

  // ---------- notes ----------
  /** Pull new encrypted outputs for a pool, trial-decrypt, refresh spent flags. */
  async sync(mint: PublicKey): Promise<OwnedNote[]> {
    if (!this.keys) throw new Error('locked');
    const key = mint.toBase58();
    const mine = this.notes.get(key) ?? [];
    let start = this.scanned.get(key) ?? 0;
    for (;;) {
      const page = await this.relayer.utxos(key, start);
      for (const row of page.utxos) {
        const enc = Uint8Array.from(Buffer.from(row.encryptedOutput, 'base64'));
        const dec = tryDecryptNote(enc, this.keys.encPriv, this.keys.encPub);
        if (!dec || !dec.mint.equals(mint)) continue;
        const u = newUtxo({ amount: dec.amount, blinding: dec.blinding, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint, index: row.index });
        if (bytesToHex(hexToBytes(row.commitment)) !== bytesToHex(bigToBytes(commitment(u)))) continue; // not ours after all
        if (u.amount === 0n) continue;
        const n = nullifier(u);
        mine.push({ ...u, index: row.index, spent: false, nullifierHex: bytesToHex(bigToBytes(n)) });
      }
      start = page.nextIndex;
      if (page.utxos.length === 0) break;
    }
    this.scanned.set(key, start);
    const unspentCandidates = mine.filter((n) => !n.spent);
    if (unspentCandidates.length) {
      const { spent } = await this.relayer.nullifiers(unspentCandidates.map((n) => n.nullifierHex));
      unspentCandidates.forEach((n, i) => (n.spent = spent[i]));
    }
    this.notes.set(key, mine);
    return mine;
  }

  balance(mint: PublicKey): bigint {
    return (this.notes.get(mint.toBase58()) ?? []).filter((n) => !n.spent).reduce((s, n) => s + n.amount, 0n);
  }
  unspent(mint: PublicKey): OwnedNote[] {
    return (this.notes.get(mint.toBase58()) ?? []).filter((n) => !n.spent).sort((a, b) => (a.amount > b.amount ? -1 : 1));
  }

  // ---------- proof building ----------
  private async buildProof(args: {
    mint: PublicKey;
    inputs: Utxo[];
    outputs: [Utxo, Utxo];
    outputEncPubs: [Uint8Array, Uint8Array];
    extAmount: bigint;
    fee: bigint;
    recipient: PublicKey;
    feeRecipient: PublicKey;
  }): Promise<{ proof: OnchainProof; enc1: Uint8Array; enc2: Uint8Array; ext: ExtData }> {
    if (!this.keys) throw new Error('locked');
    const { mint } = args;
    const ins: Utxo[] = [...args.inputs];
    while (ins.length < 2) ins.push(newUtxo({ amount: 0n, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint, index: 0 }));
    if (ins.length > 2) throw new Error('at most 2 inputs');

    const paths = await Promise.all(
      ins.map(async (u) => (u.amount === 0n ? { pathElements: new Array(26).fill('0') as string[], pathIndices: 0 } : this.relayer.merklePath(mint.toBase58(), u.index))),
    );
    const { root } = await this.relayer.merkleRoot(mint.toBase58());

    const enc1 = encryptNote(args.outputs[0], args.outputEncPubs[0]);
    const enc2 = encryptNote(args.outputs[1], args.outputEncPubs[1]);
    const ext: ExtData = {
      recipient: args.recipient,
      extAmount: args.extAmount,
      encryptedOutput1: enc1,
      encryptedOutput2: enc2,
      fee: args.fee,
      feeRecipient: args.feeRecipient,
      mint,
    };
    const hash = extDataHash(ext);

    const input: CircuitInput = {
      root,
      publicAmount: publicAmountField(args.extAmount, args.fee, FIELD_SIZE_BIG),
      extDataHash: fieldHashToDecimal(hash, FIELD_SIZE_BIG),
      mintAddress: mintField(mint),
      inputNullifier: ins.map((u) => nullifier(u)),
      inAmount: ins.map((u) => u.amount.toString()),
      inPrivateKey: ins.map((u) => u.privkey!.toString()),
      inBlinding: ins.map((u) => u.blinding.toString()),
      inPathIndices: paths.map((p) => p.pathIndices),
      inPathElements: paths.map((p) => p.pathElements),
      outputCommitment: args.outputs.map((u) => commitment(u)),
      outAmount: args.outputs.map((u) => u.amount.toString()),
      outPubkey: args.outputs.map((u) => u.pubkey.toString()),
      outBlinding: args.outputs.map((u) => u.blinding.toString()),
    };
    const proof = await prove(input, this.artifacts);
    return { proof, enc1, enc2, ext };
  }

  /** Pick up to two unspent notes covering `needed`. Throws if the balance is fragmented. */
  private selectInputs(mint: PublicKey, needed: bigint): OwnedNote[] {
    const notes = this.unspent(mint);
    const total = notes.reduce((s, n) => s + n.amount, 0n);
    if (total < needed) throw new Error('amount plus fee exceeds your shielded balance');
    if (notes.length && notes[0].amount >= needed) return [notes[0]];
    if (notes.length >= 2 && notes[0].amount + notes[1].amount >= needed) return [notes[0], notes[1]];
    throw Object.assign(new Error('balance is split across several notes'), { fragmented: true });
  }

  /**
   * The most that one send / withdrawal can move right now, after the fee, from the two largest notes
   * (a proof spends at most two). `fragmented` = more value exists in smaller notes; send()/withdraw() merge
   * notes automatically when the amount needs them, one flat fee per merge.
   */
  async spendable(mint: PublicKey, kind: 'send' | 'withdraw'): Promise<{ max: bigint; fee: bigint; fragmented: boolean; notes: number }> {
    const notes = this.unspent(mint);
    const top = notes.slice(0, 2).reduce((s, n) => s + n.amount, 0n);
    const total = notes.reduce((s, n) => s + n.amount, 0n);
    let fee = kind === 'send' ? await this.sendFee(mint) : 0n;
    let max = top - fee;
    if (kind === 'withdraw') {
      // the withdrawal fee depends on the amount: iterate to a fixed point
      for (let i = 0; i < 4 && max > 0n; i++) {
        fee = await this.withdrawFee(mint, max);
        max = top - fee;
      }
    }
    if (max < 0n) max = 0n;
    return { max, fee, fragmented: total > top, notes: notes.length };
  }

  /** Pick inputs; if the balance is spread over more than two notes, merge notes until two of them cover `needed`. */
  private async selectInputsMerging(mint: PublicKey, needed: bigint, onProgress?: ProgressCb): Promise<OwnedNote[]> {
    for (let round = 0; round < 6; round++) {
      try {
        return this.selectInputs(mint, needed);
      } catch (e) {
        if (!(e as { fragmented?: boolean }).fragmented) throw e;
        onProgress?.({ step: 'merging notes', detail: `your balance is in ${this.unspent(mint).length} notes; merging two (one flat fee)` });
        await this.consolidate(mint);
        await new Promise((r) => setTimeout(r, 1500));
        await this.sync(mint);
      }
    }
    throw new Error('could not gather enough notes; try a smaller amount');
  }

  // ---------- token transfer fees (Token-2022) ----------
  /** The mint's own transfer fee on `amount` (0 for SPL and fee-less mints). Cached for a minute. */
  async tokenTransferFee(mint: PublicKey, amount: bigint): Promise<bigint> {
    if (mint.equals(SOL_MINT) || amount <= 0n) return 0n;
    const key = mint.toBase58();
    let entry = this.transferFees.get(key);
    if (!entry || Date.now() - entry.at > 60_000) {
      const info = await this.connection.getAccountInfo(mint);
      if (!info) throw new Error(`mint ${key} not found`);
      let cfg: TransferFeeConfig | null = null;
      if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) cfg = getTransferFeeConfig(unpackMint(mint, info, TOKEN_2022_PROGRAM_ID));
      const epoch = cfg ? BigInt((await this.connection.getEpochInfo()).epoch) : 0n;
      entry = { at: Date.now(), cfg, epoch };
      this.transferFees.set(key, entry);
    }
    return entry.cfg ? calculateEpochFee(entry.cfg, entry.epoch, amount) : 0n;
  }
  async transferFeeBps(mint: PublicKey): Promise<number> {
    await this.tokenTransferFee(mint, 1n);
    const e = this.transferFees.get(mint.toBase58());
    if (!e?.cfg) return 0;
    const f = e.epoch >= BigInt(e.cfg.newerTransferFee.epoch) ? e.cfg.newerTransferFee : e.cfg.olderTransferFee;
    return f.transferFeeBasisPoints;
  }

  // ---------- fees ----------
  /** Protocol fee taken out of a deposit: the note you receive is amount minus this. */
  async depositFee(amount: bigint): Promise<bigint> {
    const cfg = await this.config();
    return (amount * BigInt(cfg.depositFeeBps ?? 0)) / 10000n;
  }
  /**
   * What happens to `amount` (raw units) taken from the wallet: the mint's own transfer fee comes off first
   * (Token-2022), then the protocol fee; `credited` is the shielded note you end up with.
   * Entering your full balance therefore always works: nothing is grossed up.
   */
  async depositPreview(mint: PublicKey, amount: bigint): Promise<{ tokenFee: bigint; net: bigint; protocolFee: bigint; credited: bigint }> {
    const tokenFee = await this.tokenTransferFee(mint, amount);
    let net = amount - tokenFee;
    // the program re-derives the gross from `net`; make sure that gross never exceeds what the wallet sends
    const e = this.transferFees.get(mint.toBase58());
    if (e?.cfg && net > 0n) {
      const f = e.epoch >= BigInt(e.cfg.newerTransferFee.epoch) ? e.cfg.newerTransferFee : e.cfg.olderTransferFee;
      const bps = BigInt(f.transferFeeBasisPoints);
      const maxFee = f.maximumFee;
      const preFee = (n: bigint) => {
        if (bps === 0n) return n;
        const raw = (n * 10000n + (10000n - bps) - 1n) / (10000n - bps);
        return raw - n >= maxFee ? n + maxFee : raw;
      };
      while (net > 0n && preFee(net) > amount) net -= 1n;
    }
    const protocolFee = await this.depositFee(net);
    return { tokenFee, net, protocolFee, credited: net - protocolFee };
  }
  async withdrawFee(mint: PublicKey, amount: bigint): Promise<bigint> {
    const cfg = await this.config();
    const pool = await this.requirePool(mint);
    if (pool.priced === false) throw new Error(`${pool.symbol} has no market price yet, so the relayer cannot cover gas for it`);
    let fee = (amount * BigInt(cfg.withdrawFeeBps)) / 10000n;
    if (mint.equals(SOL_MINT)) fee += BigInt(cfg.solFlatLamports);
    const floor = BigInt(pool.withdrawMinFee ?? pool.minFee);
    if (fee < floor) fee = floor;
    return fee;
  }
  /** What the recipient wallet ends up with after the protocol fee and the mint's own transfer fee. */
  async withdrawPreview(mint: PublicKey, amount: bigint): Promise<{ protocolFee: bigint; tokenFee: bigint; received: bigint }> {
    const protocolFee = await this.withdrawFee(mint, amount);
    const tokenFee = await this.tokenTransferFee(mint, amount);
    return { protocolFee, tokenFee, received: amount - tokenFee };
  }
  /**
   * Flat relayer fee for a private send. It is the same for everyone in the pool at a given time and does not
   * depend on the amount, so the on-chain fee transfer reveals nothing about what was sent.
   */
  async sendFee(mint: PublicKey, _amount?: bigint): Promise<bigint> {
    const pool = await this.requirePool(mint);
    if (pool.priced === false) throw new Error(`${pool.symbol} has no market price yet, so the relayer cannot cover gas for it`);
    return BigInt(pool.sendFee ?? pool.minFee);
  }

  // ---------- operations ----------
  /** Largest wallet-signed transaction Solana accepts in the legacy / v0 format. */
  static readonly MAX_V0_BYTES = 1232;

  /**
   * Instructions for a deposit. `walletAmount` is what leaves the wallet; for a Token-2022 mint with a transfer fee
   * the vault receives amount minus that fee and that net figure is what the proof commits to (so shielding a full
   * balance works). The source is whichever token account holds the coins, which also stands in as the
   * recipient account (a deposit never pays anyone out), keeping the transaction one key smaller.
   */
  private async depositInstructions(mint: PublicKey, walletAmount: bigint, signer: PublicKey, onProgress?: ProgressCb, opts: { signerTokenAccount?: PublicKey } = {}): Promise<{ ixs: TransactionInstruction[]; alt: string | null }> {
    if (!this.keys) throw new Error('locked');
    const cfg = await this.config();
    const pool = await this.requirePool(mint);
    const feeRecipient = new PublicKey(cfg.feeRecipient);
    const isSol = mint.equals(SOL_MINT);
    const tokenProgram = isSol ? SOL_MINT : new PublicKey(pool.tokenProgram);
    const source = isSol ? signer : opts.signerTokenAccount ?? (await this.tokenAccountFor(signer, mint, tokenProgram)).address;
    onProgress?.({ step: 'proving', detail: 'generating zero-knowledge proof' });
    const preview = await this.depositPreview(mint, walletAmount);
    const amount = preview.net;
    const depositFee = preview.protocolFee;
    if (amount <= depositFee) throw new Error('amount too small to cover the fee');
    const out = newUtxo({ amount: amount - depositFee, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    const change = newUtxo({ amount: 0n, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    // the program hashes the TOKEN ACCOUNTS (not the wallets) for SPL pools
    const { proof, enc1, enc2 } = await this.buildProof({
      mint,
      inputs: [],
      outputs: [out, change],
      outputEncPubs: [this.keys.encPub, this.keys.encPub],
      extAmount: amount,
      fee: depositFee,
      recipient: source,
      feeRecipient: isSol ? feeRecipient : ata(feeRecipient, mint, tokenProgram),
    });
    onProgress?.({ step: 'building', detail: 'assembling transaction' });
    const ixs: TransactionInstruction[] = [computeBudgetIx()];
    if (isSol) {
      ixs.push(await transactSolIx(this.program, { proof, extAmount: amount, fee: depositFee, encryptedOutput1: enc1, encryptedOutput2: enc2, signer, recipient: signer, feeRecipient }));
    } else {
      const vault = (await import('./program')).vaultAta(mint, tokenProgram, this.program.programId);
      const remainingAccounts = await hookAccounts(this.connection, mint, tokenProgram, source, vault, signer, amount);
      ixs.push(
        await transactSplIx(this.program, {
          proof,
          extAmount: amount,
          fee: depositFee,
          encryptedOutput1: enc1,
          encryptedOutput2: enc2,
          signer,
          recipient: signer,
          recipientTokenAccount: source,
          feeRecipient,
          mint,
          tokenProgram,
          signerTokenAccount: source,
          remainingAccounts,
        }),
      );
    }
    return { ixs, alt: pool.alt };
  }

  private async loadAlt(alt: string | null): Promise<AddressLookupTableAccount[]> {
    if (!alt) return [];
    // a freshly extended lookup table becomes usable one slot later; retry briefly instead of failing
    for (let i = 0; i < 6; i++) {
      const res = await this.connection.getAddressLookupTable(new PublicKey(alt));
      if (res.value && res.value.state.addresses.length > 0) return [res.value];
      await new Promise((r) => setTimeout(r, 1500));
    }
    return [];
  }

  /**
   * Deposit as a v0 transaction (lookup table) for the wallet to sign and send. Wallet pays gas.
   * Throws before asking the wallet when the result would not fit the 1,232-byte limit.
   */
  async buildDepositTx(mint: PublicKey, walletAmount: bigint, signer: PublicKey, onProgress?: ProgressCb, opts: { signerTokenAccount?: PublicKey } = {}): Promise<VersionedTransaction> {
    const { ixs, alt } = await this.depositInstructions(mint, walletAmount, signer, onProgress, opts);
    const tables = await this.loadAlt(alt);
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables);
    const tx = new VersionedTransaction(msg);
    const size = tx.serialize().length;
    if (size > ShieldPool.MAX_V0_BYTES) {
      throw new Error(`this deposit needs ${size} bytes, above the ${ShieldPool.MAX_V0_BYTES}-byte limit wallets can sign today (${tables.length ? 'lookup table in use' : 'lookup table unavailable'}). A wallet that signs transaction v1 lifts the limit to 4,096 bytes.`);
    }
    return tx;
  }

  /**
   * Deposit as wire bytes for a wallet-standard `signAndSendTransaction`. `version: 1` builds the 4,096-byte
   * format (no lookup table needed) for wallets that advertise it; 0 builds the v0 form and checks the size first.
   */
  async buildDepositBytes(mint: PublicKey, walletAmount: bigint, signer: PublicKey, onProgress?: ProgressCb, opts: { version?: 0 | 1; signerTokenAccount?: PublicKey } = {}): Promise<{ bytes: Uint8Array; version: 0 | 1; size: number }> {
    if ((opts.version ?? 0) === 0) {
      const tx = await this.buildDepositTx(mint, walletAmount, signer, onProgress, opts);
      const bytes = tx.serialize();
      return { bytes, version: 0, size: bytes.length };
    }
    const { ixs } = await this.depositInstructions(mint, walletAmount, signer, onProgress, opts);
    const { value: bh } = await (await import('@solana/kit')).createSolanaRpc(this.connection.rpcEndpoint).getLatestBlockhash({ commitment: 'confirmed' }).send();
    const toKit = (ix: TransactionInstruction): Instruction => ({
      programAddress: kitAddress(ix.programId.toBase58()),
      accounts: ix.keys.map((k) => ({
        address: kitAddress(k.pubkey.toBase58()),
        role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
      data: new Uint8Array(ix.data),
    });
    const msg = pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayer(kitAddress(signer.toBase58()), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(ixs.slice(1).map(toKit), m), // compute budget lives in the v1 header
      (m) => setTransactionMessageComputeUnitLimit(1_400_000, m),
      (m) => setTransactionMessageLoadedAccountsDataSizeLimit(16_000_000, m),
    );
    const bytes = new Uint8Array(getTransactionEncoder().encode(compileTransaction(msg)));
    return { bytes, version: 1, size: bytes.length };
  }

  /** Withdraw to any wallet. The relayer pays gas and pre-creates the token account. */
  async withdraw(mint: PublicKey, amount: bigint, recipient: PublicKey, onProgress?: ProgressCb): Promise<string> {
    if (!this.keys) throw new Error('locked');
    const cfg = await this.config();
    const fee = await this.withdrawFee(mint, amount);
    await this.sync(mint);
    const inputs = await this.selectInputsMerging(mint, amount + fee, onProgress);
    const inSum = inputs.reduce((s, n) => s + n.amount, 0n);
    const change = newUtxo({ amount: inSum - amount - fee, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    const dummy = newUtxo({ amount: 0n, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    onProgress?.({ step: 'proving', detail: 'generating zero-knowledge proof' });
    const { proof, enc1, enc2 } = await this.buildProof({
      mint,
      inputs,
      outputs: [change, dummy],
      outputEncPubs: [this.keys.encPub, this.keys.encPub],
      extAmount: -amount,
      fee,
      recipient: mint.equals(SOL_MINT) ? recipient : ata(recipient, mint, new PublicKey((await this.requirePool(mint)).tokenProgram)),
      feeRecipient: mint.equals(SOL_MINT) ? new PublicKey(cfg.feeRecipient) : ata(new PublicKey(cfg.feeRecipient), mint, new PublicKey((await this.requirePool(mint)).tokenProgram)),
    });
    onProgress?.({ step: 'relaying', detail: 'relayer is submitting' });
    const { signature } = await this.relayer.relay({
      kind: 'withdraw',
      mint: mint.toBase58(),
      proof,
      extAmount: (-amount).toString(),
      fee: fee.toString(),
      recipient: recipient.toBase58(),
      encryptedOutput1: Buffer.from(enc1).toString('base64'),
      encryptedOutput2: Buffer.from(enc2).toString('base64'),
    });
    inputs.forEach((n) => (n.spent = true));
    onProgress?.({ step: 'confirmed', signature });
    return signature;
  }

  /** In-pool payment to a shielded address. Amount, sender and receiver stay hidden. */
  async send(mint: PublicKey, amount: bigint, toShielded: string, onProgress?: ProgressCb): Promise<string> {
    if (!this.keys) throw new Error('locked');
    const cfg = await this.config();
    const to = parseShieldedAddress(toShielded);
    const fee = await this.sendFee(mint, amount);
    await this.sync(mint);
    const inputs = await this.selectInputsMerging(mint, amount + fee, onProgress);
    const inSum = inputs.reduce((s, n) => s + n.amount, 0n);
    const pay = newUtxo({ amount, pubkey: to.utxoPubkey, mint });
    const change = newUtxo({ amount: inSum - amount - fee, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    const pool = await this.requirePool(mint);
    const feeRecipient = mint.equals(SOL_MINT) ? new PublicKey(cfg.feeRecipient) : ata(new PublicKey(cfg.feeRecipient), mint, new PublicKey(pool.tokenProgram));
    onProgress?.({ step: 'proving', detail: 'generating zero-knowledge proof' });
    const { proof, enc1, enc2 } = await this.buildProof({
      mint,
      inputs,
      outputs: [pay, change],
      outputEncPubs: [to.encPub, this.keys.encPub],
      extAmount: 0n,
      fee,
      // recipient is unused for in-pool payments; the program still needs a valid token account for SPL
      recipient: mint.equals(SOL_MINT) ? new PublicKey(cfg.relayer) : ata(new PublicKey(cfg.feeRecipient), mint, new PublicKey(pool.tokenProgram)),
      feeRecipient,
    });
    onProgress?.({ step: 'relaying', detail: 'relayer is submitting' });
    const { signature } = await this.relayer.relay({
      kind: 'send',
      mint: mint.toBase58(),
      proof,
      extAmount: '0',
      fee: fee.toString(),
      recipient: mint.equals(SOL_MINT) ? cfg.relayer : cfg.feeRecipient,
      encryptedOutput1: Buffer.from(enc1).toString('base64'),
      encryptedOutput2: Buffer.from(enc2).toString('base64'),
    });
    inputs.forEach((n) => (n.spent = true));
    onProgress?.({ step: 'confirmed', signature });
    return signature;
  }

  /** Merge the two largest notes into one (a send to self). */
  async consolidate(mint: PublicKey, onProgress?: ProgressCb): Promise<string> {
    const notes = this.unspent(mint);
    if (notes.length < 2) throw new Error('nothing to consolidate');
    const sum = notes[0].amount + notes[1].amount;
    const fee = await this.sendFee(mint, sum);
    return this.send(mint, sum - fee, this.shieldedAddress(), onProgress);
  }

  nullifierPdas(proof: OnchainProof) {
    return nullifierAccounts(proof, this.program.programId);
  }
}

function bigToBytes(x: string | bigint): Uint8Array {
  const n = BigInt(x);
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export { TOKEN_2022_PROGRAM_ID };
