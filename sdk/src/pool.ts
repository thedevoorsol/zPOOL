/**
 * High-level client: unlock, sync notes, deposit (wallet signs), withdraw / send (relayer signs).
 */
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { AddressLookupTableAccount, Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import { FIELD_SIZE_BIG, bytesToHex, hexToBytes, poseidonReady } from './crypto';
import { extDataHash, type ExtData } from './extdata';
import { keyDerivationMessage, keysFromSignature, parseShieldedAddress, shieldedAddress, type ShieldKeys } from './keys';
import { encryptNote, tryDecryptNote } from './notes';
import { PROGRAM_ID, ata, computeBudgetIx, createPoolIx, getProgram, nullifierAccounts, transactSolIx, transactSplIx } from './program';
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
    if (total < needed) throw new Error('insufficient shielded balance');
    if (notes.length && notes[0].amount >= needed) return [notes[0]];
    if (notes.length >= 2 && notes[0].amount + notes[1].amount >= needed) return [notes[0], notes[1]];
    throw new Error('balance is split across several notes; consolidate first');
  }

  // ---------- fees ----------
  /** Protocol fee taken out of a deposit: the note you receive is amount minus this. */
  async depositFee(amount: bigint): Promise<bigint> {
    const cfg = await this.config();
    return (amount * BigInt(cfg.depositFeeBps ?? 0)) / 10000n;
  }
  async withdrawFee(mint: PublicKey, amount: bigint): Promise<bigint> {
    const cfg = await this.config();
    const pool = await this.requirePool(mint);
    let fee = (amount * BigInt(cfg.withdrawFeeBps)) / 10000n;
    if (mint.equals(SOL_MINT)) fee += BigInt(cfg.solFlatLamports);
    if (fee < BigInt(pool.minFee)) fee = BigInt(pool.minFee);
    return fee;
  }
  async sendFee(mint: PublicKey, amount: bigint): Promise<bigint> {
    const cfg = await this.config();
    const pool = await this.requirePool(mint);
    let fee = (amount * BigInt(cfg.sendFeeBps)) / 10000n;
    if (fee < BigInt(pool.minFee)) fee = BigInt(pool.minFee);
    return fee;
  }

  // ---------- operations ----------
  /**
   * Deposit: returns a transaction for the wallet to sign and send. Wallet pays gas.
   * SPL deposits use the pool's lookup table (v0); SOL deposits are legacy.
   */
  async buildDepositTx(mint: PublicKey, amount: bigint, signer: PublicKey, onProgress?: ProgressCb): Promise<VersionedTransaction> {
    if (!this.keys) throw new Error('locked');
    const cfg = await this.config();
    const pool = await this.requirePool(mint);
    const feeRecipient = new PublicKey(cfg.feeRecipient);
    onProgress?.({ step: 'proving', detail: 'generating zero-knowledge proof' });
    const depositFee = await this.depositFee(amount);
    if (amount <= depositFee) throw new Error('amount too small to cover the fee');
    const out = newUtxo({ amount: amount - depositFee, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    const change = newUtxo({ amount: 0n, pubkey: this.keys.utxoPubkey, privkey: this.keys.utxoPrivkey, mint });
    // the program hashes the TOKEN ACCOUNTS (not the wallets) for SPL pools
    const isSol = mint.equals(SOL_MINT);
    const tokenProgramPk = isSol ? SOL_MINT : new PublicKey(pool.tokenProgram);
    const { proof, enc1, enc2 } = await this.buildProof({
      mint,
      inputs: [],
      outputs: [out, change],
      outputEncPubs: [this.keys.encPub, this.keys.encPub],
      extAmount: amount,
      fee: depositFee,
      recipient: isSol ? signer : ata(signer, mint, tokenProgramPk),
      feeRecipient: isSol ? feeRecipient : ata(feeRecipient, mint, tokenProgramPk),
    });
    onProgress?.({ step: 'building', detail: 'assembling transaction' });
    const ixs = [computeBudgetIx()];
    let alt: AddressLookupTableAccount[] = [];
    if (mint.equals(SOL_MINT)) {
      ixs.push(await transactSolIx(this.program, { proof, extAmount: amount, fee: depositFee, encryptedOutput1: enc1, encryptedOutput2: enc2, signer, recipient: signer, feeRecipient }));
    } else {
      const tokenProgram = new PublicKey(pool.tokenProgram);
      ixs.push(
        await transactSplIx(this.program, {
          proof,
          extAmount: amount,
          fee: depositFee,
          encryptedOutput1: enc1,
          encryptedOutput2: enc2,
          signer,
          recipient: signer,
          feeRecipient,
          mint,
          tokenProgram,
          signerTokenAccount: ata(signer, mint, tokenProgram),
        }),
      );
    }
    if (pool.alt) {
      // a freshly extended lookup table becomes usable one slot later; retry briefly instead of failing
      for (let i = 0; i < 6 && !alt.length; i++) {
        const res = await this.connection.getAddressLookupTable(new PublicKey(pool.alt));
        if (res.value && res.value.state.addresses.length > 0) alt = [res.value];
        else await new Promise((r) => setTimeout(r, 1500));
      }
    }
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt);
    return new VersionedTransaction(msg);
  }

  /** Withdraw to any wallet. The relayer pays gas and pre-creates the token account. */
  async withdraw(mint: PublicKey, amount: bigint, recipient: PublicKey, onProgress?: ProgressCb): Promise<string> {
    if (!this.keys) throw new Error('locked');
    const cfg = await this.config();
    const fee = await this.withdrawFee(mint, amount);
    await this.sync(mint);
    const inputs = this.selectInputs(mint, amount + fee);
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
    const inputs = this.selectInputs(mint, amount + fee);
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
