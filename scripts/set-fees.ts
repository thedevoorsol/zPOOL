/** Authority only: set fee rates and the protocol fee recipient on chain.
 *   RPC_URL=... DEPLOYER=keys/pool/mainnet-deployer.json DEPOSIT_BPS=50 WITHDRAW_BPS=50 FEE_RECIPIENT=<pubkey> npx tsx scripts/set-fees.ts */
import fs from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { fetchGlobalConfig, getProgram, updateGlobalConfigIx } from '../sdk/src/program';
const connection = new Connection(process.env.RPC_URL!, 'confirmed');
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOYER!, 'utf8'))));
const program = getProgram(connection);
const ix = await updateGlobalConfigIx(program, deployer.publicKey, {
  depositFeeBps: Number(process.env.DEPOSIT_BPS),
  withdrawalFeeBps: Number(process.env.WITHDRAW_BPS),
  feeRecipient: new PublicKey(process.env.FEE_RECIPIENT!),
});
console.log('update_global_config', await sendAndConfirmTransaction(connection, new Transaction().add(ix), [deployer]));
const gc = (await fetchGlobalConfig(program))!;
console.log('deposit bps', gc.depositFeeRate, 'withdraw bps', gc.withdrawalFeeRate, 'fee recipient', gc.feeRecipient.toBase58());
