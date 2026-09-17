/**
 * One-time protocol setup on a cluster: initialize (SOL tree + global config), point fees at the relayer,
 * cap SOL deposits, fund the relayer. Idempotent.
 *   RPC_URL=... DEPLOYER=keys/pool/mainnet-deployer.json RELAYER=keys/pool/relayer.json npx tsx scripts/init-mainnet.ts
 */
import fs from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { fetchGlobalConfig, getProgram, initializeIx, pdaSolTree, updateGlobalConfigIx } from '../sdk/src/program';

const RPC_URL = process.env.RPC_URL!;
const WITHDRAW_FEE_BPS = Number(process.env.WITHDRAW_FEE_BPS ?? 30);
const SOL_DEPOSIT_CAP = BigInt(process.env.SOL_DEPOSIT_CAP_LAMPORTS ?? 5 * LAMPORTS_PER_SOL);
const RELAYER_FUND = BigInt(process.env.RELAYER_FUND_LAMPORTS ?? 0.3 * LAMPORTS_PER_SOL);
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
const deployer = load(process.env.DEPLOYER!);
const relayer = load(process.env.RELAYER!);
const connection = new Connection(RPC_URL, 'confirmed');
const program = getProgram(connection);

const gc = await fetchGlobalConfig(program);
if (!gc) {
  const tx = new Transaction().add(await initializeIx(program, deployer.publicKey, WITHDRAW_FEE_BPS));
  console.log('initialize', await sendAndConfirmTransaction(connection, tx, [deployer]));
} else console.log('already initialized; authority', gc.authority.toBase58(), 'fee recipient', gc.feeRecipient.toBase58());

const gc2 = (await fetchGlobalConfig(program))!;
if (!gc2.feeRecipient.equals(relayer.publicKey)) {
  const tx = new Transaction().add(await updateGlobalConfigIx(program, deployer.publicKey, { feeRecipient: relayer.publicKey }));
  console.log('fee recipient -> relayer', await sendAndConfirmTransaction(connection, tx, [deployer]));
}

// SOL deposit cap (per deposit) while the program is unaudited; lift with update_deposit_limit later
const tree = await (program.account as never as { merkleTreeAccount: { fetch: (k: unknown) => Promise<{ maxDepositAmount: { toString(): string } }> } }).merkleTreeAccount.fetch(pdaSolTree());
if (BigInt(tree.maxDepositAmount.toString()) !== SOL_DEPOSIT_CAP) {
  const ix = await program.methods.updateDepositLimit(new (await import('@coral-xyz/anchor')).BN(SOL_DEPOSIT_CAP.toString())).accountsStrict({ treeAccount: pdaSolTree(), authority: deployer.publicKey }).instruction();
  console.log('SOL deposit cap', SOL_DEPOSIT_CAP.toString(), await sendAndConfirmTransaction(connection, new Transaction().add(ix), [deployer]));
}

const bal = BigInt(await connection.getBalance(relayer.publicKey));
if (bal < RELAYER_FUND) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: relayer.publicKey, lamports: RELAYER_FUND - bal }));
  console.log('fund relayer', await sendAndConfirmTransaction(connection, tx, [deployer]));
}
console.log('relayer', relayer.publicKey.toBase58(), 'balance', Number(await connection.getBalance(relayer.publicKey)) / LAMPORTS_PER_SOL, 'SOL');
console.log('done');
