// Create a plain SPL mint with Metaplex-less metadata and mint 5,000 tokens to a wallet (local testing helper).
import fs from 'node:fs';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMintInstruction, createMintToInstruction, getAssociatedTokenAddressSync, getMintLen } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
const connection = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PAYER!, 'utf8'))));
const owner = new PublicKey(process.argv[2]);
const mint = Keypair.generate();
(async () => {
const lamports = await connection.getMinimumBalanceForRentExemption(getMintLen([]));
const ata = getAssociatedTokenAddressSync(mint.publicKey, owner);
const tx = new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: getMintLen([]), lamports, programId: TOKEN_PROGRAM_ID }),
  createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint.publicKey),
  createMintToInstruction(mint.publicKey, ata, payer.publicKey, 5_000n * 1_000_000n),
);
  await sendAndConfirmTransaction(connection, tx, [payer, mint]);
  console.log(mint.publicKey.toBase58());
})();
