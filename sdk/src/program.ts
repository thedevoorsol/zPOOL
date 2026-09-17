/** Anchor program bindings: PDAs and instruction builders for shieldpool. */
import { AnchorProvider, BN, Program, type Idl } from '@coral-xyz/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import idlJson from '../../program/target/idl/shieldpool.json' with { type: 'json' };
import type { OnchainProof } from './prover';
import { SOL_MINT } from './utxo';

export const IDL = idlJson as Idl;
export const PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);
export const COMPUTE_UNITS = 1_000_000;
export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SOL_MINT };

export function getProgram(connection: Connection, programId = PROGRAM_ID): Program {
  const dummy = {
    publicKey: PublicKey.default,
    signTransaction: async <T>(t: T) => t,
    signAllTransactions: async <T>(t: T) => t,
  };
  const provider = new AnchorProvider(connection, dummy as never, { commitment: 'confirmed' });
  const idl = { ...(IDL as object), address: programId.toBase58() } as Idl;
  return new Program(idl, provider);
}

export function pdaGlobalConfig(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('global_config')], programId)[0];
}
export function pdaSolTree(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('merkle_tree')], programId)[0];
}
export function pdaTreeToken(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('tree_token')], programId)[0];
}
export function pdaPoolTree(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  if (mint.equals(SOL_MINT)) return pdaSolTree(programId);
  return PublicKey.findProgramAddressSync([Buffer.from('merkle_tree'), mint.toBuffer()], programId)[0];
}
export function pdaNullifier(prefix: 'nullifier0' | 'nullifier1', nullifier: number[] | Uint8Array, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(prefix), Buffer.from(nullifier)], programId)[0];
}
export function nullifierAccounts(proof: OnchainProof, programId = PROGRAM_ID) {
  return {
    nullifier0: pdaNullifier('nullifier0', proof.inputNullifiers[0], programId),
    nullifier1: pdaNullifier('nullifier1', proof.inputNullifiers[1], programId),
    nullifier2: pdaNullifier('nullifier0', proof.inputNullifiers[1], programId),
    nullifier3: pdaNullifier('nullifier1', proof.inputNullifiers[0], programId),
  };
}
export function vaultAta(mint: PublicKey, tokenProgram: PublicKey, programId = PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, pdaGlobalConfig(programId), true, tokenProgram);
}
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

function proofArg(p: OnchainProof) {
  return {
    proofA: p.proofA,
    proofB: p.proofB,
    proofC: p.proofC,
    root: p.root,
    publicAmount: p.publicAmount,
    extDataHash: p.extDataHash,
    inputNullifiers: p.inputNullifiers,
    outputCommitments: p.outputCommitments,
  };
}

export type TransactArgs = {
  proof: OnchainProof;
  extAmount: bigint;
  fee: bigint;
  encryptedOutput1: Uint8Array;
  encryptedOutput2: Uint8Array;
  signer: PublicKey;
  /** where withdrawn funds go: a wallet (SOL) or the owner of the destination token account (SPL) */
  recipient: PublicKey;
  feeRecipient: PublicKey;
};

export function computeBudgetIx(units = COMPUTE_UNITS): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units });
}

export async function transactSolIx(program: Program, a: TransactArgs): Promise<TransactionInstruction> {
  const programId = program.programId;
  const n = nullifierAccounts(a.proof, programId);
  return program.methods
    .transact(proofArg(a.proof), { extAmount: new BN(a.extAmount.toString()), fee: new BN(a.fee.toString()) }, Buffer.from(a.encryptedOutput1), Buffer.from(a.encryptedOutput2))
    .accountsStrict({
      treeAccount: pdaSolTree(programId),
      nullifier0: n.nullifier0,
      nullifier1: n.nullifier1,
      nullifier2: n.nullifier2,
      nullifier3: n.nullifier3,
      treeTokenAccount: pdaTreeToken(programId),
      globalConfig: pdaGlobalConfig(programId),
      recipient: a.recipient,
      feeRecipientAccount: a.feeRecipient,
      signer: a.signer,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function transactSplIx(
  program: Program,
  a: TransactArgs & { mint: PublicKey; tokenProgram: PublicKey; signerTokenAccount: PublicKey; remainingAccounts?: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] },
): Promise<TransactionInstruction> {
  const programId = program.programId;
  const n = nullifierAccounts(a.proof, programId);
  return program.methods
    .transactSpl(proofArg(a.proof), { extAmount: new BN(a.extAmount.toString()), fee: new BN(a.fee.toString()) }, Buffer.from(a.encryptedOutput1), Buffer.from(a.encryptedOutput2))
    .accountsStrict({
      treeAccount: pdaPoolTree(a.mint, programId),
      nullifier0: n.nullifier0,
      nullifier1: n.nullifier1,
      nullifier2: n.nullifier2,
      nullifier3: n.nullifier3,
      globalConfig: pdaGlobalConfig(programId),
      signer: a.signer,
      mint: a.mint,
      signerTokenAccount: a.signerTokenAccount,
      recipient: a.recipient,
      recipientTokenAccount: ata(a.recipient, a.mint, a.tokenProgram),
      treeAta: vaultAta(a.mint, a.tokenProgram, programId),
      feeRecipientAta: ata(a.feeRecipient, a.mint, a.tokenProgram),
      tokenProgram: a.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(a.remainingAccounts ?? [])
    .instruction();
}

export async function createPoolIx(program: Program, mint: PublicKey, tokenProgram: PublicKey, payer: PublicKey): Promise<TransactionInstruction> {
  const programId = program.programId;
  return program.methods
    .createPool()
    .accountsStrict({
      treeAccount: pdaPoolTree(mint, programId),
      mint,
      globalConfig: pdaGlobalConfig(programId),
      vault: vaultAta(mint, tokenProgram, programId),
      payer,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function initializeIx(program: Program, authority: PublicKey, withdrawalFeeBps: number): Promise<TransactionInstruction> {
  const programId = program.programId;
  return program.methods
    .initialize(withdrawalFeeBps)
    .accountsStrict({
      treeAccount: pdaSolTree(programId),
      treeTokenAccount: pdaTreeToken(programId),
      globalConfig: pdaGlobalConfig(programId),
      authority,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function updateGlobalConfigIx(
  program: Program,
  authority: PublicKey,
  v: { depositFeeBps?: number; withdrawalFeeBps?: number; feeErrorMarginBps?: number; feeRecipient?: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .updateGlobalConfig(v.depositFeeBps ?? null, v.withdrawalFeeBps ?? null, v.feeErrorMarginBps ?? null, v.feeRecipient ?? null)
    .accountsStrict({ globalConfig: pdaGlobalConfig(program.programId), authority })
    .instruction();
}

export type GlobalConfigState = { authority: PublicKey; feeRecipient: PublicKey; depositFeeRate: number; withdrawalFeeRate: number; feeErrorMargin: number };
export async function fetchGlobalConfig(program: Program): Promise<GlobalConfigState | null> {
  const acc = await (program.account as never as { globalConfig: { fetchNullable: (k: PublicKey) => Promise<GlobalConfigState | null> } }).globalConfig.fetchNullable(pdaGlobalConfig(program.programId));
  return acc;
}
