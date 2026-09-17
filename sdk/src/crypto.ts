/** Poseidon (BN254) via Light Protocol's WASM hasher, plus field helpers. Works in Node and browsers. */
import { WasmFactory, type LightWasm } from '@lightprotocol/hasher.rs';
import BN from 'bn.js';

export const FIELD_SIZE = new BN('21888242871839275222246405745257275088548364400416034343698204186575808495617');
export const FIELD_SIZE_BIG = BigInt(FIELD_SIZE.toString());

let wasm: LightWasm | null = null;
export async function poseidonReady(): Promise<LightWasm> {
  if (!wasm) wasm = await WasmFactory.getInstance();
  return wasm;
}

/** Poseidon over decimal-string field elements, returns a decimal string. */
export function poseidon(inputs: (string | bigint | BN | number)[]): string {
  if (!wasm) throw new Error('call poseidonReady() first');
  return wasm.poseidonHashString(inputs.map((x) => x.toString()));
}

export function bigToBytes32BE(x: bigint | string | BN): Uint8Array {
  const n = BigInt(x.toString());
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToBigBE(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

export function randomFieldBelow(bytes = 31): bigint {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToBigBE(buf) % FIELD_SIZE_BIG;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
