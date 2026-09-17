/** Tornado-Nova style notes. Commitment = Poseidon(amount, pubkey, blinding, mintField). */
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { bytesToBigBE, poseidon, randomFieldBelow } from './crypto';

export const SOL_MINT = new PublicKey('11111111111111111111111111111112');

/** Field representation of a mint: SOL is its base58 string (accidentally all digits), SPL = first 31 bytes. */
export function mintField(mint: PublicKey): string {
  const s = mint.toBase58();
  if (s === SOL_MINT.toBase58()) return s;
  return new BN(mint.toBytes().slice(0, 31), 'be').toString();
}

export type Utxo = {
  amount: bigint;
  blinding: bigint;
  pubkey: bigint;
  /** present only for notes we own */
  privkey?: bigint;
  mint: PublicKey;
  /** leaf index in the pool's tree; -1 for unspent-yet-to-be-inserted outputs */
  index: number;
};

export function newUtxo(args: { amount: bigint; pubkey: bigint; mint: PublicKey; privkey?: bigint; blinding?: bigint; index?: number }): Utxo {
  return {
    amount: args.amount,
    blinding: args.blinding ?? randomFieldBelow(31),
    pubkey: args.pubkey,
    privkey: args.privkey,
    mint: args.mint,
    index: args.index ?? -1,
  };
}

export function commitment(u: Utxo): string {
  return poseidon([u.amount, u.pubkey, u.blinding, mintField(u.mint)]);
}

export function nullifier(u: Utxo): string {
  if (u.privkey === undefined) throw new Error('cannot nullify a note we do not own');
  const c = commitment(u);
  const idx = u.index < 0 ? 0 : u.index;
  const sig = poseidon([u.privkey, c, idx]);
  return poseidon([c, idx, sig]);
}

export function commitmentBytes(u: Utxo): Uint8Array {
  const n = BigInt(commitment(u));
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function sameCommitment(a: Uint8Array, b: Uint8Array): boolean {
  return bytesToBigBE(a) === bytesToBigBE(b);
}
