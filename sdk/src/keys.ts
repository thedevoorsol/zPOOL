/**
 * All user keys derive from ONE wallet signature over a fixed message, so nothing is ever stored.
 *   utxo private key  -> Poseidon pubkey (what the circuit uses)
 *   x25519 key        -> receiving encrypted notes (shielded address)
 * Shielded address = "sp" + base58(utxoPubkey[32] || x25519Pub[32]).
 */
import { sha256 } from '@noble/hashes/sha2';
import { x25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { FIELD_SIZE_BIG, bigToBytes32BE, bytesToBigBE, concat, poseidon } from './crypto';

export const KEY_MESSAGE_PREFIX = 'shieldpool/v1: derive my shielded keys for wallet ';

export type ShieldKeys = {
  utxoPrivkey: bigint;
  utxoPubkey: bigint;
  encPriv: Uint8Array;
  encPub: Uint8Array;
  wallet: string;
};

export function keyDerivationMessage(wallet: string): Uint8Array {
  return new TextEncoder().encode(KEY_MESSAGE_PREFIX + wallet);
}

export function keysFromSignature(wallet: string, signature: Uint8Array): ShieldKeys {
  const seed = sha256(signature);
  const enc = new TextEncoder();
  const utxoPrivkey = bytesToBigBE(sha256(concat(seed, enc.encode('utxo')))) % FIELD_SIZE_BIG;
  const utxoPubkey = BigInt(poseidon([utxoPrivkey]));
  const encPriv = sha256(concat(seed, enc.encode('x25519')));
  const encPub = x25519.getPublicKey(encPriv);
  return { utxoPrivkey, utxoPubkey, encPriv, encPub, wallet };
}

export function shieldedAddress(keys: { utxoPubkey: bigint; encPub: Uint8Array }): string {
  return 'sp' + bs58.encode(concat(bigToBytes32BE(keys.utxoPubkey), keys.encPub));
}

export function parseShieldedAddress(addr: string): { utxoPubkey: bigint; encPub: Uint8Array } {
  if (!addr.startsWith('sp')) throw new Error('not a shielded address (expected sp…)');
  const raw = bs58.decode(addr.slice(2));
  if (raw.length !== 64) throw new Error('malformed shielded address');
  return { utxoPubkey: bytesToBigBE(raw.slice(0, 32)), encPub: raw.slice(32) };
}

export function isShieldedAddress(addr: string): boolean {
  try {
    parseShieldedAddress(addr);
    return true;
  } catch {
    return false;
  }
}
