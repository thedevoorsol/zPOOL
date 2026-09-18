/**
 * Note encryption to a recipient's x25519 key (works for self too).
 * layout: [0x02][ephemeral pub 32][nonce 12][AES-256-GCM(amount u64 LE ‖ blinding 31 ‖ mint 32) 71+16]
 */
import { gcm } from '@noble/ciphers/aes';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey } from '@solana/web3.js';
import { bigToBytes32BE, bytesToBigBE, concat } from './crypto.js';
import type { Utxo } from './utxo.js';

const VERSION = 0x02;
const INFO = new TextEncoder().encode('shieldpool-note-v2');
export const NOTE_CIPHERTEXT_LEN = 1 + 32 + 12 + 71 + 16;

function sessionKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(ephPub, recipientPub), INFO, 32);
}

export function encryptNote(u: Utxo, recipientEncPub: Uint8Array): Uint8Array {
  const ephPriv = new Uint8Array(32);
  crypto.getRandomValues(ephPriv);
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientEncPub);
  const key = sessionKey(shared, ephPub, recipientEncPub);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, u.amount, true);
  const plain = concat(amount, bigToBytes32BE(u.blinding).slice(1), u.mint.toBytes());
  const ct = gcm(key, nonce).encrypt(plain);
  return concat(new Uint8Array([VERSION]), ephPub, nonce, ct);
}

/** Returns the note fields or null if this ciphertext is not for us. */
export function tryDecryptNote(data: Uint8Array, encPriv: Uint8Array, encPub: Uint8Array): { amount: bigint; blinding: bigint; mint: PublicKey } | null {
  if (data.length !== NOTE_CIPHERTEXT_LEN || data[0] !== VERSION) return null;
  const ephPub = data.slice(1, 33);
  const nonce = data.slice(33, 45);
  const ct = data.slice(45);
  try {
    const shared = x25519.getSharedSecret(encPriv, ephPub);
    const key = sessionKey(shared, ephPub, encPub);
    const plain = gcm(key, nonce).decrypt(ct);
    const amount = new DataView(plain.buffer, plain.byteOffset, 8).getBigUint64(0, true);
    const blinding = bytesToBigBE(plain.slice(8, 39));
    const mint = new PublicKey(plain.slice(39, 71));
    return { amount, blinding, mint };
  } catch {
    return null;
  }
}
