/**
 * shieldpool relayer + indexer.
 *  - indexes CommitmentData / SplCommitmentData / PoolCreated events into SQLite and in-memory Merkle trees
 *  - serves notes, Merkle paths and nullifier status to clients
 *  - submits withdrawals and in-pool payments on behalf of users (pays gas, pre-creates token accounts)
 *  - per pool keeps a fee token account and an address lookup table so wallet-signed deposits fit in a v0 tx
 */
import fs from 'node:fs';
import http from 'node:http';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getTokenMetadata,
  unpackMint,
} from '@solana/spl-token';
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { poseidonReady } from '../../sdk/src/crypto';
import { MerkleTree } from '../../sdk/src/merkle';
import { IDL, PROGRAM_ID, ata, computeBudgetIx, fetchGlobalConfig, getProgram, hookAccounts, nullifierAccounts, pdaGlobalConfig, pdaPoolTree, pdaSolTree, pdaTreeToken, transactSolIx, transactSplIx, vaultAta } from '../../sdk/src/program';
import type { OnchainProof } from '../../sdk/src/prover';
import { SOL_MINT } from '../../sdk/src/utxo';
import { Db, type PoolRow } from './db.ts';
import { displayNames, flatFeeInToken, imageFromUri, refreshPrices, searchTokens, tokensByMint, usdPrice } from './tokens.ts';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PORT = Number(process.env.PORT ?? 8787);
// Prefer a mounted volume when it exists (Railway: /data), otherwise fall back to a temp file and re-index from chain.
const DB_PATH = (() => {
  const want = process.env.DB_PATH ?? './relayer.sqlite';
  const dir = want.slice(0, want.lastIndexOf('/')) || '.';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return want;
  } catch {
    console.warn(`DB_PATH ${want} not writable, using /tmp/relayer.sqlite (state re-indexed from chain on restart)`);
    return '/tmp/relayer.sqlite';
  }
})();
const CHAIN = process.env.CHAIN ?? 'solana:localnet';
const WITHDRAW_FEE_BPS = Number(process.env.WITHDRAW_FEE_BPS ?? 30);
const SOL_FLAT_LAMPORTS = BigInt(process.env.SOL_FLAT_LAMPORTS ?? 2_000_000);
/**
 * Relayer-paid operations charge a FLAT fee worth this much SOL, converted into the pool's token at market price.
 * A percentage fee on a private send would leak the amount (fee / rate = amount); a flat fee says nothing.
 * Withdrawals keep the on-chain percentage but never go below the flat amount, so tiny withdrawals cannot drain gas.
 */
const SEND_FLAT_SOL = Number(process.env.SEND_FLAT_SOL ?? 0.002);
const WITHDRAW_FLAT_SOL = Number(process.env.WITHDRAW_FLAT_SOL ?? 0.003);
/** On mainnet a token without a market price gets no gasless service (it would be a free way to drain the relayer). */
const REQUIRE_PRICE = (process.env.REQUIRE_PRICE ?? (process.env.CHAIN?.endsWith('mainnet') ? '1' : '0')) === '1';
const MAX_BODY = 256 * 1024;
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
/** 1 = 4,096-byte transaction v1 (default, live on mainnet since epoch 1035); 0 = v0 + lookup table fallback */
const RELAY_TX_VERSION = Number(process.env.RELAY_TX_VERSION ?? 1);
// RELAYER_SECRET (JSON array, for hosted deployments) takes precedence over a keypair file.
const relayer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.RELAYER_SECRET ?? fs.readFileSync(process.env.RELAYER_KEYPAIR ?? '../../keys/pool/relayer.json', 'utf8'))),
);

const connection = new Connection(RPC_URL, 'confirmed');
const kitRpc = createSolanaRpc(RPC_URL);
let kitSigner: KeyPairSigner | null = null;
const program = getProgram(connection);
const db = new Db(DB_PATH);
const trees = new Map<string, MerkleTree>();
const altCache = new Map<string, AddressLookupTableAccount>();
const coder = new BorshCoder(IDL);
const eventParser = new EventParser(PROGRAM_ID, coder);
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- pools
function tree(mint: string): MerkleTree {
  let t = trees.get(mint);
  if (!t) {
    t = new MerkleTree(26, db.allCommitments(mint).map((h) => BigInt('0x' + h).toString()));
    trees.set(mint, t);
  }
  return t;
}

async function tokenMeta(mint: PublicKey, tokenProgram: PublicKey): Promise<{ symbol: string; name: string; logoUri: string | null; decimals: number }> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error('mint not found');
  const m = unpackMint(mint, info, tokenProgram);
  let symbol = mint.toBase58().slice(0, 4);
  let name = mint.toBase58();
  let logoUri: string | null = null;
  // Jupiter knows most traded tokens and serves a real image, not a metadata JSON.
  try {
    const j = (await tokensByMint([mint.toBase58()])).get(mint.toBase58());
    if (j && j.decimals === m.decimals) return { symbol: j.symbol || symbol, name: j.name || name, logoUri: j.logoUri, decimals: m.decimals };
  } catch {
    /* fall through to on-chain metadata */
  }
  try {
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      const md = await getTokenMetadata(connection, mint, 'confirmed', tokenProgram);
      if (md) {
        symbol = md.symbol || symbol;
        name = md.name || name;
        logoUri = md.uri || null;
      }
    } else {
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX);
      const acc = await connection.getAccountInfo(pda);
      if (acc) {
        const d = acc.data;
        let o = 1 + 32 + 32;
        const rd = () => {
          const len = d.readUInt32LE(o);
          o += 4;
          const s = d.subarray(o, o + len).toString('utf8').replace(/\0+$/, '');
          o += len;
          return s;
        };
        name = rd() || name;
        symbol = rd() || symbol;
        logoUri = rd() || null;
      }
    }
  } catch {
    /* metadata is optional */
  }
  const dn = displayNames(symbol, name, mint.toBase58());
  return { symbol: dn.symbol, name: dn.name, logoUri: await imageFromUri(logoUri), decimals: m.decimals };
}

/** Pools registered before icons were resolved may hold a metadata JSON url or nothing: fix them once. */
async function refreshLogos(): Promise<void> {
  for (const p of db.pools()) {
    const looksLikeImage = p.logo_uri && /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(p.logo_uri);
    if (looksLikeImage) continue;
    try {
      const meta = p.mint === SOL_MINT.toBase58()
        ? { symbol: 'SOL', name: 'Solana', logoUri: (await tokensByMint([p.mint])).get(p.mint)?.logoUri ?? null, decimals: 9 }
        : await tokenMeta(new PublicKey(p.mint), new PublicKey(p.token_program));
      if (meta.logoUri && meta.logoUri !== p.logo_uri) {
        db.upsertPool({ ...p, symbol: meta.symbol, name: meta.name, logo_uri: meta.logoUri });
        log('logo resolved', meta.symbol, meta.logoUri);
      }
    } catch (e) {
      log('logo refresh failed', p.symbol, (e as Error).message);
    }
  }
}

async function priceLoop(): Promise<void> {
  for (;;) {
    try {
      await refreshPrices(db.pools().map((p) => p.mint));
    } catch (e) {
      log('price refresh failed', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

let gcCache: { at: number; value: Awaited<ReturnType<typeof fetchGlobalConfig>> } | null = null;
async function globalConfig(): Promise<Awaited<ReturnType<typeof fetchGlobalConfig>>> {
  if (gcCache && Date.now() - gcCache.at < 30_000) return gcCache.value;
  const value = await fetchGlobalConfig(program);
  gcCache = { at: Date.now(), value };
  return value;
}

async function ensureSolPool(): Promise<void> {
  const gc = await fetchGlobalConfig(program);
  if (!gc) {
    log('program not initialized yet (no global config)');
    return;
  }
  if (!db.pool(SOL_MINT.toBase58())) {
    // lookup table so wallet-signed SOL deposits fit in a v0 transaction
    const slot = await connection.getSlot('finalized');
    const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: relayer.publicKey, payer: relayer.publicKey, recentSlot: slot });
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: altAddr,
      authority: relayer.publicKey,
      payer: relayer.publicKey,
      addresses: [PROGRAM_ID, pdaGlobalConfig(), pdaSolTree(), pdaTreeToken(), gc.feeRecipient, SystemProgram.programId, ComputeBudgetProgram.programId],
    });
    await sendLegacy([createIx, extendIx]);
    db.upsertPool({
      mint: SOL_MINT.toBase58(),
      token_program: SOL_MINT.toBase58(),
      decimals: 9,
      symbol: 'SOL',
      name: 'Solana',
      logo_uri: null,
      tree: pdaSolTree().toBase58(),
      vault: pdaTreeToken().toBase58(),
      alt: altAddr.toBase58(),
      fee_ata: gc.feeRecipient.toBase58(),
      min_fee: SOL_FLAT_LAMPORTS.toString(),
    });
    log('SOL pool registered');
  }
}

/** After a pool exists on chain: make sure our fee token account and the lookup table exist. */
async function provisionPool(mint: PublicKey): Promise<PoolRow> {
  const key = mint.toBase58();
  const existing = db.pool(key);
  if (existing?.alt && existing.fee_ata) return existing;
  const treeInfo = await connection.getAccountInfo(pdaPoolTree(mint));
  if (!treeInfo) throw new Error('pool not created on chain');
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error('mint not found');
  const tokenProgram = mintInfo.owner;
  const meta = await tokenMeta(mint, tokenProgram);
  const gc = await fetchGlobalConfig(program);
  if (!gc) throw new Error('program not initialized');
  const feeAta = ata(gc.feeRecipient, mint, tokenProgram);
  const vault = vaultAta(mint, tokenProgram);

  const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, feeAta, gc.feeRecipient, mint, tokenProgram)];
  let altAddr = existing?.alt ? new PublicKey(existing.alt) : null;
  if (!altAddr) {
    const slot = await connection.getSlot('finalized');
    const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: relayer.publicKey, payer: relayer.publicKey, recentSlot: slot });
    // transfer-hook mints: the hook program and its static extra accounts go in the table too, so wallet-signed
    // deposits on such mints still fit in 1,232 bytes
    const hookExtra = (await hookAccounts(connection, mint, tokenProgram, vault, feeAta, pdaGlobalConfig(), 1n).catch(() => [])).map((k) => k.pubkey);
    const addresses = [PROGRAM_ID, pdaGlobalConfig(), mint, pdaPoolTree(mint), vault, feeAta, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, ComputeBudgetProgram.programId, ...hookExtra].filter((a, i, arr) => arr.findIndex((b) => b.equals(a)) === i).slice(0, 256);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: address,
      authority: relayer.publicKey,
      payer: relayer.publicKey,
      addresses,
    });
    ixs.push(createIx, extendIx);
    altAddr = address;
  }
  await sendLegacy(ixs);
  const row: PoolRow = {
    mint: key,
    token_program: tokenProgram.toBase58(),
    decimals: meta.decimals,
    symbol: meta.symbol,
    name: meta.name,
    logo_uri: meta.logoUri,
    tree: pdaPoolTree(mint).toBase58(),
    vault: vault.toBase58(),
    alt: altAddr.toBase58(),
    fee_ata: feeAta.toBase58(),
    min_fee: '0',
  };
  db.upsertPool(row);
  log('pool provisioned', meta.symbol, key, 'alt', row.alt);
  // quote fees for the new pool right away instead of waiting for the next price cycle
  refreshPrices([key]).catch((e) => log('price refresh failed', key, e.message));
  return row;
}

/** The fee recipient can change on chain: make sure every pool has its token account and lookup-table entry. */
async function syncFeeRecipient(): Promise<void> {
  const gc = await fetchGlobalConfig(program);
  if (!gc) return;
  for (const p of db.pools()) {
    if (p.mint === SOL_MINT.toBase58()) {
      if (p.fee_ata !== gc.feeRecipient.toBase58() && p.alt) {
        await sendLegacy([AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(p.alt), authority: relayer.publicKey, payer: relayer.publicKey, addresses: [gc.feeRecipient] })]);
        db.setPoolAlt(p.mint, p.alt, gc.feeRecipient.toBase58());
        altCache.delete(p.alt);
        log('SOL pool: fee recipient added to lookup table', gc.feeRecipient.toBase58());
      }
      continue;
    }
    const mint = new PublicKey(p.mint);
    const tokenProgram = new PublicKey(p.token_program);
    const feeAta = ata(gc.feeRecipient, mint, tokenProgram);
    if (p.fee_ata === feeAta.toBase58()) continue;
    const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, feeAta, gc.feeRecipient, mint, tokenProgram)];
    if (p.alt) ixs.push(AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(p.alt), authority: relayer.publicKey, payer: relayer.publicKey, addresses: [feeAta] }));
    await sendLegacy(ixs);
    if (p.alt) { db.setPoolAlt(p.mint, p.alt, feeAta.toBase58()); altCache.delete(p.alt); }
    log('pool', p.symbol, 'fee account updated for', gc.feeRecipient.toBase58());
  }
}

async function sendLegacy(ixs: TransactionInstruction[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  tx.sign([relayer]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

function toKitIx(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  };
}

/** Relayer-signed transaction in the v1 format: no lookup tables, 4,096 bytes, resource limits in the header. */
async function sendV1(ixs: TransactionInstruction[]): Promise<string> {
  if (!kitSigner) kitSigner = await createKeyPairSignerFromBytes(relayer.secretKey);
  const signer = kitSigner;
  const { value: bh } = await kitRpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs.map(toKitIx), m),
    (m) => setTransactionMessageComputeUnitLimit(1_400_000, m),
    (m) => setTransactionMessageLoadedAccountsDataSizeLimit(16_000_000, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  const wire = getBase64EncodedWireTransaction(tx);
  await kitRpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3n }).send();
  await connection.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: Number(bh.lastValidBlockHeight) }, 'confirmed');
  log('v1 tx', sig, `${Math.ceil((wire.length * 3) / 4)} bytes`);
  return sig;
}

async function loadAlt(addr: string): Promise<AddressLookupTableAccount> {
  const cached = altCache.get(addr);
  if (cached) return cached;
  const res = await connection.getAddressLookupTable(new PublicKey(addr));
  if (!res.value) throw new Error('lookup table missing');
  altCache.set(addr, res.value);
  return res.value;
}

// ---------------------------------------------------------------- indexer
type LeafEvent = { mint: string; idx: number; commitment: string; encrypted: string; signature: string; slot: number };

/** Decode a transaction's events. Returns leaf events; pool creations are provisioned as a side effect. */
async function decodeSignature(sig: string, slot: number): Promise<LeafEvent[]> {
  // Kit reads every transaction version, including v1 (4 KB) ones the relayer itself sends.
  const tx = await kitRpc.getTransaction(sig as never, { maxSupportedTransactionVersion: 1 as never, commitment: 'confirmed', encoding: 'json' }).send();
  if (!tx || tx.meta?.err) return [];
  const logs = (tx.meta?.logMessages ?? []) as string[];
  const out: LeafEvent[] = [];
  for (const ev of eventParser.parseLogs(logs)) {
    const d = ev.data as Record<string, unknown>;
    const field = <T,>(camel: string, snake: string): T => (d[camel] ?? d[snake]) as T;
    if (ev.name === 'poolCreated' || ev.name === 'PoolCreated') {
      const mint = field<PublicKey>('mint', 'mint').toBase58();
      log('PoolCreated', mint);
      provisionPool(new PublicKey(mint)).catch((e) => log('provision failed', mint, e.message));
      continue;
    }
    const isSpl = ev.name === 'splCommitmentData' || ev.name === 'SplCommitmentData';
    const isSol = ev.name === 'commitmentData' || ev.name === 'CommitmentData';
    if (!isSpl && !isSol) continue;
    out.push({
      mint: isSpl ? field<PublicKey>('mintAddress', 'mint_address').toBase58() : SOL_MINT.toBase58(),
      idx: Number(field<{ toString(): string }>('index', 'index').toString()),
      commitment: Buffer.from(field<number[]>('commitment', 'commitment')).toString('hex'),
      encrypted: Buffer.from(field<number[] | Buffer>('encryptedOutput', 'encrypted_output')).toString('base64'),
      signature: sig,
      slot,
    });
  }
  return out;
}

/** Insert leaves in index order per pool. A leaf we already hold is skipped; a leaf beyond the next index means missing history. */
function applyLeaves(events: LeafEvent[]): void {
  const byMint = new Map<string, LeafEvent[]>();
  for (const e of events) (byMint.get(e.mint) ?? byMint.set(e.mint, []).get(e.mint)!).push(e);
  for (const [mint, list] of byMint) {
    list.sort((a, b) => a.idx - b.idx);
    const t = tree(mint);
    for (const e of list) {
      if (e.idx < t.size) continue;
      if (e.idx > t.size) {
        throw new Error(`missing leaves for pool ${mint}: have ${t.size}, next seen ${e.idx}. The RPC's transaction history is incomplete (pruned local ledger?); re-sync from an archive RPC.`);
      }
      if (db.insertLeaf({ mint, idx: e.idx, commitment: e.commitment, encrypted: e.encrypted, signature: e.signature, slot: e.slot })) t.insert(BigInt('0x' + e.commitment).toString());
    }
  }
}

async function indexSignature(sig: string, slot: number): Promise<void> {
  if (db.seen(sig)) return;
  applyLeaves(await decodeSignature(sig, slot));
  db.markSeen(sig);
}

async function poll(): Promise<void> {
  const cur = db.cursor();
  // collect everything newer than the cursor, oldest first
  const all: { signature: string; slot: number }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(PROGRAM_ID, { until: cur.last_signature ?? undefined, before, limit: 1000 }, 'confirmed');
    if (!page.length) break;
    all.push(...page.map((s) => ({ signature: s.signature, slot: s.slot })));
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  all.reverse();
  // decode the whole batch first so leaves from the same slot can be ordered by index
  const fresh = all.filter((s) => !db.seen(s.signature));
  const events: LeafEvent[] = [];
  for (const s of fresh) events.push(...(await decodeSignature(s.signature, s.slot)));
  applyLeaves(events);
  for (const s of fresh) db.markSeen(s.signature);
  if (all.length) db.setCursor(all[all.length - 1].signature, all[all.length - 1].slot);
}

async function indexerLoop(): Promise<void> {
  for (;;) {
    try {
      if (!db.pool(SOL_MINT.toBase58())) await ensureSolPool();
      await poll();
    } catch (e) {
      log('indexer error', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------------------------------------------------------------- relay
type RelayBody = { kind: 'withdraw' | 'send'; mint: string; proof: OnchainProof; extAmount: string; fee: string; recipient: string; encryptedOutput1: string; encryptedOutput2: string };

let onchainWithdrawBps = WITHDRAW_FEE_BPS;
/** Flat fees quoted for a pool right now, raw token units. null = token has no market price. */
function flatFees(pool: PoolRow): { send: bigint | null; withdraw: bigint | null } {
  if (pool.mint === SOL_MINT.toBase58()) return { send: BigInt(Math.round(SEND_FLAT_SOL * 1e9)), withdraw: SOL_FLAT_LAMPORTS };
  return { send: flatFeeInToken(pool.mint, pool.decimals, SEND_FLAT_SOL), withdraw: flatFeeInToken(pool.mint, pool.decimals, WITHDRAW_FLAT_SOL) };
}
function minFee(kind: 'withdraw' | 'send', pool: PoolRow, amountAbs: bigint): bigint {
  const flat = flatFees(pool)[kind];
  if (flat === null && REQUIRE_PRICE) throw new Error(`${pool.symbol} has no market price yet, so the relayer cannot quote a fee for it`);
  if (kind === 'send') {
    // flat only: the fee must not depend on the amount, or it would reveal it
    return ((flat ?? 0n) * 80n) / 100n; // 20% tolerance for a price refresh between quote and relay
  }
  let fee = (amountAbs * BigInt(onchainWithdrawBps)) / 10000n;
  if (pool.mint === SOL_MINT.toBase58()) fee += SOL_FLAT_LAMPORTS;
  // tolerate the on-chain 5% error margin so rounding never rejects
  fee = (fee * 95n) / 100n;
  const floor = ((flat ?? BigInt(pool.min_fee)) * 80n) / 100n;
  return fee > floor ? fee : floor;
}

async function relay(body: RelayBody): Promise<string> {
  const gcNow = await globalConfig();
  if (gcNow) onchainWithdrawBps = gcNow.withdrawalFeeRate;
  const pool = db.pool(body.mint);
  if (!pool) throw new Error('unknown pool');
  const mint = new PublicKey(body.mint);
  const extAmount = BigInt(body.extAmount);
  const fee = BigInt(body.fee);
  if (body.kind === 'withdraw' && extAmount >= 0n) throw new Error('withdraw needs a negative extAmount');
  if (body.kind === 'send' && extAmount !== 0n) throw new Error('send needs extAmount 0');
  const amountAbs = extAmount < 0n ? -extAmount : 0n;
  const required = minFee(body.kind, pool, amountAbs);
  if (fee < required) throw new Error(`fee too low: need at least ${required}`);

  const n = nullifierAccounts(body.proof);
  const infos = await connection.getMultipleAccountsInfo([n.nullifier0, n.nullifier1, n.nullifier2, n.nullifier3]);
  if (infos.some((i) => i)) throw new Error('note already spent');

  const gc = await globalConfig();
  if (!gc) throw new Error('program not initialized');
  const recipient = new PublicKey(body.recipient);
  const enc1 = Uint8Array.from(Buffer.from(body.encryptedOutput1, 'base64'));
  const enc2 = Uint8Array.from(Buffer.from(body.encryptedOutput2, 'base64'));
  const ixs: TransactionInstruction[] = [computeBudgetIx()];
  let alts: AddressLookupTableAccount[] = [];

  if (mint.equals(SOL_MINT)) {
    ixs.push(await transactSolIx(program, { proof: body.proof, extAmount, fee, encryptedOutput1: enc1, encryptedOutput2: enc2, signer: relayer.publicKey, recipient, feeRecipient: gc.feeRecipient }));
  } else {
    const tokenProgram = new PublicKey(pool.token_program);
    const recipientAta = ata(recipient, mint, tokenProgram);
    if (body.kind === 'withdraw') ixs.push(createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, recipientAta, recipient, mint, tokenProgram));
    // transfer hooks: extra accounts for vault -> recipient and vault -> fee account (union, deduped)
    const vault = vaultAta(mint, tokenProgram);
    const feeAta = ata(gc.feeRecipient, mint, tokenProgram);
    const hookOut = body.kind === 'withdraw' ? await hookAccounts(connection, mint, tokenProgram, vault, recipientAta, pdaGlobalConfig(), amountAbs).catch(() => []) : [];
    const hookFee = fee > 0n ? await hookAccounts(connection, mint, tokenProgram, vault, feeAta, pdaGlobalConfig(), fee).catch(() => []) : [];
    const remainingAccounts = [...hookOut, ...hookFee].filter((k, i, arr) => arr.findIndex((x) => x.pubkey.equals(k.pubkey)) === i);
    ixs.push(
      await transactSplIx(program, {
        proof: body.proof,
        extAmount,
        fee,
        encryptedOutput1: enc1,
        encryptedOutput2: enc2,
        signer: relayer.publicKey,
        recipient,
        feeRecipient: gc.feeRecipient,
        mint,
        tokenProgram,
        // the relayer never deposits, but the account must be a valid token account it owns
        signerTokenAccount: await relayerTokenAccount(mint, tokenProgram),
        remainingAccounts,
      }),
    );
    if (pool.alt) alts = [await loadAlt(pool.alt)];
  }
  let sig: string;
  if (RELAY_TX_VERSION === 1) {
    sig = await sendV1(ixs.slice(1)); // compute budget instruction is a no-op in v1; limits live in the header
  } else {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([relayer]);
    sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  }
  log(body.kind, pool.symbol, 'fee', fee.toString(), sig);
  // index right away so the client sees its change note
  const st = await connection.getSignatureStatuses([sig]);
  await indexSignature(sig, st.value[0]?.slot ?? 0);
  return sig;
}

const relayerAtas = new Map<string, PublicKey>();
async function relayerTokenAccount(mint: PublicKey, tokenProgram: PublicKey): Promise<PublicKey> {
  const key = mint.toBase58();
  const cached = relayerAtas.get(key);
  if (cached) return cached;
  const a = getAssociatedTokenAddressSync(mint, relayer.publicKey, false, tokenProgram);
  const info = await connection.getAccountInfo(a);
  if (!info) await sendLegacy([createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, a, relayer.publicKey, mint, tokenProgram)]);
  relayerAtas.set(key, a);
  return a;
}

// ---------------------------------------------------------------- http
function poolJson(p: PoolRow) {
  const flat = flatFees(p);
  const dn = displayNames(p.symbol, p.name, p.mint);
  return {
    sendFee: (flat.send ?? 0n).toString(),
    withdrawMinFee: (flat.withdraw ?? BigInt(p.min_fee)).toString(),
    usdPrice: usdPrice(p.mint),
    priced: flat.send !== null || !REQUIRE_PRICE,
    mint: p.mint,
    tokenProgram: p.token_program,
    decimals: p.decimals,
    symbol: dn.symbol,
    name: dn.name,
    logoUri: p.logo_uri ?? undefined,
    tree: p.tree,
    vault: p.vault,
    alt: p.alt,
    feeAta: p.fee_ata,
    minFee: p.min_fee,
    leaves: db.leafCount(p.mint),
  };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// ---------------------------------------------------------------- rate limiting (per client IP, token bucket)
type Bucket = { tokens: number; at: number };
const buckets = new Map<string, Bucket>();
const LIMITS: Record<string, { perSec: number; burst: number }> = {
  '/rpc': { perSec: 15, burst: 60 },
  '/relay': { perSec: 0.2, burst: 6 },
  '/tokens/search': { perSec: 3, burst: 15 },
  '*': { perSec: 30, burst: 120 },
};
function allow(ip: string, path: string): boolean {
  const key = path === '/rpc' || path === '/relay' || path === '/tokens/search' ? path : '*';
  const lim = LIMITS[key];
  const id = `${key}|${ip}`;
  const now = Date.now();
  let b = buckets.get(id);
  if (!b) buckets.set(id, (b = { tokens: lim.burst, at: now }));
  b.tokens = Math.min(lim.burst, b.tokens + ((now - b.at) / 1000) * lim.perSec);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
}, 60_000).unref();
function clientIp(req: http.IncomingMessage): string {
  // Railway's edge writes the real client address FIRST and keeps anything the client supplied after it
  // (measured: 300 requests with distinct spoofed headers were all keyed to one bucket with this rule,
  // and all slipped through when the last entry was used instead).
  const xf = req.headers['x-forwarded-for'];
  const parts = (Array.isArray(xf) ? xf.join(',') : xf ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts[0] || req.socket.remoteAddress || 'unknown';
}

async function route(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<unknown> {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/config') {
    const gc = await globalConfig();
    res.setHeader('cache-control', 'public, max-age=30');
    return {
      programId: PROGRAM_ID.toBase58(),
      relayer: relayer.publicKey.toBase58(),
      feeRecipient: gc?.feeRecipient.toBase58() ?? relayer.publicKey.toBase58(),
      depositFeeBps: gc?.depositFeeRate ?? 0,
      withdrawFeeBps: gc?.withdrawalFeeRate ?? WITHDRAW_FEE_BPS,
      /** private sends charge a flat fee per pool (see /pools sendFee), never a percentage */
      sendFeeBps: 0,
      sendFlatSol: SEND_FLAT_SOL,
      withdrawFlatSol: WITHDRAW_FLAT_SOL,
      solFlatLamports: SOL_FLAT_LAMPORTS.toString(),
      chain: CHAIN,
    };
  }
  if (req.method === 'GET' && p === '/tokens/search') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 64);
    if (!q) return [];
    res.setHeader('cache-control', 'public, max-age=60');
    const list = await searchTokens(q);
    return list.slice(0, 25).map((t) => ({ ...t, hasPool: !!db.pool(t.mint) }));
  }
  if (req.method === 'GET' && p === '/tokens/meta') {
    const mints = (url.searchParams.get('mints') ?? '').split(',').map((m) => m.trim()).filter(Boolean).slice(0, 100);
    res.setHeader('cache-control', 'public, max-age=300');
    const found = await tokensByMint(mints);
    return mints.map((m) => {
      const t = found.get(m);
      return t ? { ...t, hasPool: !!db.pool(m) } : null;
    });
  }
  if (req.method === 'GET' && p === '/pools') {
    const unpriced = db.pools().filter((x) => x.mint !== SOL_MINT.toBase58() && usdPrice(x.mint) === null).map((x) => x.mint);
    if (unpriced.length) await refreshPrices(unpriced).catch(() => undefined);
    return db.pools().map(poolJson);
  }
  if (req.method === 'GET' && p.startsWith('/pools/')) {
    const row = db.pool(p.slice('/pools/'.length));
    return row ? poolJson(row) : null;
  }
  if (req.method === 'POST' && p === '/pools') {
    const { mint } = (await readJson(req)) as { mint: string };
    return poolJson(await provisionPool(new PublicKey(mint)));
  }
  if (req.method === 'GET' && p.startsWith('/token/')) {
    const mintStr = p.slice('/token/'.length);
    if (mintStr === SOL_MINT.toBase58()) return { mint: mintStr, tokenProgram: mintStr, decimals: 9, symbol: 'SOL', name: 'Solana', hasPool: !!db.pool(mintStr) };
    const mint = new PublicKey(mintStr);
    const info = await connection.getAccountInfo(mint);
    if (!info) throw new Error('mint not found');
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('not a token mint');
    const meta = await tokenMeta(mint, info.owner);
    return { mint: mintStr, tokenProgram: info.owner.toBase58(), decimals: meta.decimals, symbol: meta.symbol, name: meta.name, logoUri: meta.logoUri ?? undefined, hasPool: !!db.pool(mintStr) };
  }
  if (req.method === 'GET' && p === '/utxos') {
    const mint = url.searchParams.get('mint')!;
    const start = Number(url.searchParams.get('start') ?? 0);
    const rows = db.leaves(mint, start, 5000);
    // a full page never changes (leaves are append-only): let browsers and the CDN keep it
    res.setHeader('cache-control', rows.length === 5000 ? 'public, max-age=86400, immutable' : 'no-store');
    return { utxos: rows.map((r) => ({ index: r.idx, commitment: r.commitment, encryptedOutput: r.encrypted, signature: r.signature })), nextIndex: rows.length ? rows[rows.length - 1].idx + 1 : start, root: tree(mint).root() };
  }
  if (req.method === 'POST' && p === '/nullifiers') {
    const { nullifiers } = (await readJson(req)) as { nullifiers: string[] };
    const pdas = nullifiers.map((h) => PublicKey.findProgramAddressSync([Buffer.from('nullifier0'), Buffer.from(h, 'hex')], PROGRAM_ID)[0]);
    const spent: boolean[] = [];
    for (let i = 0; i < pdas.length; i += 100) {
      const infos = await connection.getMultipleAccountsInfo(pdas.slice(i, i + 100));
      spent.push(...infos.map((x) => !!x));
    }
    // a note can also be spent as the second input (nullifier1 prefix)
    const pdas1 = nullifiers.map((h) => PublicKey.findProgramAddressSync([Buffer.from('nullifier1'), Buffer.from(h, 'hex')], PROGRAM_ID)[0]);
    for (let i = 0; i < pdas1.length; i += 100) {
      const infos = await connection.getMultipleAccountsInfo(pdas1.slice(i, i + 100));
      infos.forEach((x, j) => {
        if (x) spent[i + j] = true;
      });
    }
    return { spent };
  }
  if (req.method === 'GET' && p === '/merkle/path') {
    const mint = url.searchParams.get('mint')!;
    const index = Number(url.searchParams.get('index'));
    const t = tree(mint);
    return { ...t.path(index), root: t.root() };
  }
  if (req.method === 'GET' && p === '/merkle/root') {
    const mint = url.searchParams.get('mint')!;
    const t = tree(mint);
    return { root: t.root(), leaves: t.size };
  }
  if (req.method === 'POST' && p === '/relay') {
    const body = (await readJson(req)) as RelayBody;
    return { signature: await relay(body) };
  }
  if (req.method === 'GET' && p === '/health') return { ok: true, relayer: relayer.publicKey.toBase58(), pools: db.pools().length };
  if (req.method === 'POST' && p === '/rpc') {
    // JSON-RPC passthrough so the browser never needs its own RPC key. Read-only methods + sendTransaction only.
    const body = (await readJson(req)) as { method?: string } | { method?: string }[];
    const calls = Array.isArray(body) ? body : [body];
    const allowed = new Set(['getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getTokenAccountBalance', 'getTokenAccountsByOwner', 'getLatestBlockhash', 'getSignatureStatuses', 'getAddressLookupTable', 'getMinimumBalanceForRentExemption', 'sendTransaction', 'simulateTransaction', 'getSlot', 'getBlockHeight', 'getEpochInfo', 'getTransaction', 'getRecentPrioritizationFees', 'getFeeForMessage', 'getVersion', 'getGenesisHash', 'getHealth', 'isBlockhashValid']);
    for (const c of calls) if (!c.method || !allowed.has(c.method)) throw new Error(`rpc method not allowed: ${c.method}`);
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  }
  throw Object.assign(new Error('not found'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, solana-client, authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!allow(clientIp(req), url.pathname)) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ error: 'too many requests' }));
    return;
  }
  try {
    const out = await route(req, url, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out ?? null));
  } catch (e) {
    const err = e as Error & { status?: number };
    res.writeHead(err.status ?? 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    if (!err.status) log('request failed', url.pathname, err.message);
  }
});

// ---------------------------------------------------------------- main
(async () => {
  await poseidonReady();
  log('relayer', relayer.publicKey.toBase58(), 'program', PROGRAM_ID.toBase58(), 'rpc', new URL(RPC_URL).host);
  await ensureSolPool();
  for (const p of db.pools()) tree(p.mint);
  await poll();
  await refreshPrices(db.pools().map((p) => p.mint)).catch((e) => log('price refresh failed', e.message));
  await syncFeeRecipient().catch((e) => log('fee recipient sync failed', e.message));
  void refreshLogos();
  void priceLoop();
  setInterval(() => syncFeeRecipient().catch((e) => log('fee recipient sync failed', e.message)), 60_000);
  server.listen(PORT, () => log(`listening on :${PORT}`));
  void indexerLoop();
})();
