/**
 * Local end-to-end: init program -> create pools (legacy SPL, Token-2022 with transfer fee, SOL) ->
 * alice deposits -> alice pays bob privately -> bob withdraws to a fresh wallet -> SOL round trip.
 *   RPC_URL=http://127.0.0.1:8899 RELAYER_URL=http://127.0.0.1:8787 npx tsx scripts/e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
  ExtensionType,
  getAccount,
} from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { ShieldPool } from '../sdk/src/pool';
import { fetchGlobalConfig, getProgram, initializeIx, updateGlobalConfigIx } from '../sdk/src/program';
import { SOL_MINT } from '../sdk/src/utxo';

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const RELAYER_URL = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';
const KEYS = process.env.KEYS_DIR ?? path.resolve(here, '../../keys/pool'); // deployer.json + relayer.json live outside the repo
const artifacts = { wasm: path.resolve(here, '../circuits/transaction2.wasm'), zkey: path.resolve(here, '../circuits/transaction2.zkey') };

const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, f), 'utf8'))));
const connection = new Connection(RPC_URL, 'confirmed');
const deployer = load('deployer.json');
const relayerKp = load('relayer.json');
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const signMessageWith = (kp: Keypair) => async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey);

async function airdrop(pk: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
}

async function sendTx(tx: Transaction, signers: Keypair[]) {
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
}

async function createMint(kind: 'spl' | 't22fee', decimals: number): Promise<{ mint: PublicKey; program: PublicKey }> {
  const mint = Keypair.generate();
  if (kind === 'spl') {
    const lamports = await connection.getMinimumBalanceForRentExemption(getMintLen([]));
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: mint.publicKey, space: getMintLen([]), lamports, programId: TOKEN_PROGRAM_ID }),
      createInitializeMintInstruction(mint.publicKey, decimals, deployer.publicKey, null, TOKEN_PROGRAM_ID),
    );
    await sendTx(tx, [deployer, mint]);
    return { mint: mint.publicKey, program: TOKEN_PROGRAM_ID };
  }
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(len);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferFeeConfigInstruction(mint.publicKey, deployer.publicKey, deployer.publicKey, 100, 1_000_000_000n, TOKEN_2022_PROGRAM_ID), // 1% fee
    createInitializeMintInstruction(mint.publicKey, decimals, deployer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendTx(tx, [deployer, mint]);
  return { mint: mint.publicKey, program: TOKEN_2022_PROGRAM_ID };
}

async function mintTo(mint: PublicKey, program: PublicKey, owner: PublicKey, amount: bigint) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, program);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata, owner, mint, program),
    createMintToInstruction(mint, ata, deployer.publicKey, amount, [], program),
  );
  await sendTx(tx, [deployer]);
}

async function tokenBalance(mint: PublicKey, program: PublicKey, owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, false, program), 'confirmed', program)).amount;
  } catch {
    return 0n;
  }
}

async function signAndSendV(tx: VersionedTransaction, kp: Keypair): Promise<string> {
  tx.sign([kp]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function waitRelayerPool(pool: ShieldPool, mint: PublicKey) {
  for (let i = 0; i < 40; i++) {
    const p = await pool.pool(mint);
    if (p && (mint.equals(SOL_MINT) || p.alt)) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('relayer never provisioned pool ' + mint.toBase58());
}

async function main() {
  // 0. program init (idempotent)
  const program = getProgram(connection);
  if (!(await fetchGlobalConfig(program))) {
    const tx = new Transaction().add(await initializeIx(program, deployer.publicKey, 30));
    await sendTx(tx, [deployer]);
    const tx2 = new Transaction().add(await updateGlobalConfigIx(program, deployer.publicKey, { feeRecipient: relayerKp.publicKey }));
    await sendTx(tx2, [deployer]);
    log('program initialized, fee recipient = relayer', relayerKp.publicKey.toBase58());
  }
  // make sure the relayer is up
  const health = await fetch(RELAYER_URL + '/health').then((r) => r.json());
  log('relayer', health);

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const fresh = Keypair.generate(); // bob's brand-new wallet, never funded
  await airdrop(alice.publicKey, 20);
  await airdrop(bob.publicKey, 5);

  const A = await ShieldPool.init({ connection, relayerUrl: RELAYER_URL, artifacts });
  const B = await ShieldPool.init({ connection, relayerUrl: RELAYER_URL, artifacts });
  await A.unlock(alice.publicKey, signMessageWith(alice));
  await B.unlock(bob.publicKey, signMessageWith(bob));
  log('alice shielded address', A.shieldedAddress());
  log('bob shielded address  ', B.shieldedAddress());

  for (const kind of ['spl', 't22fee'] as const) {
    log(`=== ${kind === 'spl' ? 'legacy SPL token' : 'Token-2022 with 1% transfer fee'} ===`);
    const { mint, program: tokenProgram } = await createMint(kind, 6);
    const unit = 1_000_000n;
    await mintTo(mint, tokenProgram, alice.publicKey, 1_000_000n * unit);

    // 1. anyone opens the pool (alice pays)
    const createTx = await A.createPoolTx(mint, alice.publicKey);
    await signAndSendV(createTx, alice);
    await A.relayer.registerPool(mint.toBase58());
    const info = await waitRelayerPool(A, mint);
    log('pool created', info.symbol, 'alt', info.alt);

    // 2. alice deposits 1000
    const depositTx = await A.buildDepositTx(mint, 1000n * unit, alice.publicKey, (p) => log('  ', p.step, p.detail ?? ''));
    const depSig = await signAndSendV(depositTx, alice);
    log('deposit tx', depSig, 'size', depositTx.serialize().length, 'bytes');
    await new Promise((r) => setTimeout(r, 2500));
    await A.sync(mint);
    log('alice shielded balance', A.balance(mint) / unit, '| public', (await tokenBalance(mint, tokenProgram, alice.publicKey)) / unit);
    if (A.balance(mint) !== 1000n * unit) throw new Error('deposit not credited');

    // 3. alice pays bob 250 privately
    const sendSig = await A.send(mint, 250n * unit, B.shieldedAddress(), (p) => log('  ', p.step, p.detail ?? p.signature ?? ''));
    log('private send tx', sendSig);
    await new Promise((r) => setTimeout(r, 1500));
    await A.sync(mint);
    await B.sync(mint);
    const sendFee = await A.sendFee(mint, 250n * unit);
    log('alice shielded', A.balance(mint) / unit, '| bob shielded', B.balance(mint) / unit, '| fee', sendFee);
    if (B.balance(mint) !== 250n * unit) throw new Error('bob did not receive');
    if (A.balance(mint) !== 1000n * unit - 250n * unit - sendFee) throw new Error('alice change wrong');

    // 4. bob withdraws 100 to a fresh wallet (relayer pays gas + creates the token account)
    const wSig = await B.withdraw(mint, 100n * unit, fresh.publicKey, (p) => log('  ', p.step, p.detail ?? p.signature ?? ''));
    log('withdraw tx', wSig);
    await new Promise((r) => setTimeout(r, 1500));
    await B.sync(mint);
    const freshBal = await tokenBalance(mint, tokenProgram, fresh.publicKey);
    const wFee = await B.withdrawFee(mint, 100n * unit);
    log('fresh wallet public balance', freshBal, '(expected', kind === 't22fee' ? '99 after the mint\'s own 1% fee' : '100', ') | bob shielded', B.balance(mint) / unit, '| fee', wFee);
    const expected = kind === 't22fee' ? 99n * unit : 100n * unit;
    if (freshBal !== expected) throw new Error(`fresh wallet got ${freshBal}, expected ${expected}`);
    if (B.balance(mint) !== 250n * unit - 100n * unit - wFee) throw new Error('bob change wrong');
    const relayerFeeBal = await tokenBalance(mint, tokenProgram, relayerKp.publicKey);
    log('protocol fee balance', relayerFeeBal, '(send fee + withdraw fee', sendFee + wFee, ')');
  }

  log('=== native SOL ===');
  await waitRelayerPool(A, SOL_MINT);
  const depositTx = await A.buildDepositTx(SOL_MINT, 2n * BigInt(LAMPORTS_PER_SOL), alice.publicKey);
  const depSig = await signAndSendV(depositTx, alice);
  log('SOL deposit', depSig, 'size', depositTx.serialize().length);
  await new Promise((r) => setTimeout(r, 2500));
  await A.sync(SOL_MINT);
  log('alice shielded SOL', Number(A.balance(SOL_MINT)) / LAMPORTS_PER_SOL);
  const fresh2 = Keypair.generate();
  await A.withdraw(SOL_MINT, BigInt(LAMPORTS_PER_SOL), fresh2.publicKey, (p) => log('  ', p.step, p.detail ?? p.signature ?? ''));
  await new Promise((r) => setTimeout(r, 1000));
  const bal = await connection.getBalance(fresh2.publicKey);
  log('fresh wallet SOL', bal / LAMPORTS_PER_SOL);
  if (bal !== LAMPORTS_PER_SOL) throw new Error('SOL withdraw wrong');

  log('E2E OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('E2E FAILED', e?.message ?? e);
  if (e?.logs) console.error(e.logs.join('\n'));
  process.exit(1);
});
