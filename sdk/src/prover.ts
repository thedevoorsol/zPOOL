/** Groth16 proving with snarkjs, output formatted for the on-chain verifier (big-endian, G2 limbs swapped). */
import { groth16 } from 'snarkjs';
import { bigToBytes32BE } from './crypto.js';

export type Artifacts = { wasm: string | Uint8Array; zkey: string | Uint8Array };

export type CircuitInput = {
  root: string;
  publicAmount: string;
  extDataHash: string;
  mintAddress: string;
  inputNullifier: string[];
  inAmount: string[];
  inPrivateKey: string[];
  inBlinding: string[];
  inPathIndices: number[];
  inPathElements: string[][];
  outputCommitment: string[];
  outAmount: string[];
  outPubkey: string[];
  outBlinding: string[];
};

export type OnchainProof = {
  proofA: number[];
  proofB: number[];
  proofC: number[];
  root: number[];
  publicAmount: number[];
  extDataHash: number[];
  inputNullifiers: number[][];
  outputCommitments: number[][];
};

function be(x: string): number[] {
  return Array.from(bigToBytes32BE(BigInt(x)));
}

const artifactCache = new Map<string, Uint8Array>();
/** In Node, snarkjs treats a string as a file path; fetch http(s) artifacts into memory once. Browsers fetch URLs natively. */
async function resolveArtifact(a: string | Uint8Array): Promise<string | { type: 'mem'; data: Uint8Array }> {
  if (typeof a !== 'string') return { type: 'mem', data: a };
  const isUrl = /^https?:\/\//.test(a);
  if (!isUrl || typeof window !== 'undefined') return a;
  let data = artifactCache.get(a);
  if (!data) {
    const r = await fetch(a);
    if (!r.ok) throw new Error(`artifact ${a}: ${r.status}`);
    data = new Uint8Array(await r.arrayBuffer());
    artifactCache.set(a, data);
  }
  return { type: 'mem', data };
}

/** Raw snarkjs call; used on the main thread and inside the worker. */
export async function fullProve(input: CircuitInput, artifacts: Artifacts): Promise<{ proof: unknown; publicSignals: string[] }> {
  const wasm = await resolveArtifact(artifacts.wasm);
  const zkey = await resolveArtifact(artifacts.zkey);
  const r = await groth16.fullProve(input as never, wasm as never, zkey as never);
  return { proof: r.proof, publicSignals: r.publicSignals as string[] };
}

/** Proving takes a few seconds of CPU. In browsers it runs in a Web Worker so the UI never freezes; set to false to force the main thread. */
export let useWorker = true;
export function setUseWorker(v: boolean): void { useWorker = v; }
let workerFailed = false;

function proveInWorker(input: CircuitInput, artifacts: Artifacts): Promise<{ proof: unknown; publicSignals: string[] }> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./prover.worker.js', import.meta.url), { type: 'module' });
    } catch (e) { reject(e); return; }
    const done = (fn: () => void) => { w.terminate(); fn(); };
    w.onmessage = (ev: MessageEvent<{ ok: boolean; result?: { proof: unknown; publicSignals: string[] }; error?: string }>) => done(() => (ev.data.ok && ev.data.result ? resolve(ev.data.result) : reject(new Error(ev.data.error ?? 'proof failed'))));
    w.onerror = (ev) => done(() => reject(new Error(ev.message || 'worker error')));
    // string artifacts are URLs: make them absolute for the worker
    const abs = (a: string | Uint8Array) => (typeof a === 'string' && typeof location !== 'undefined' ? new URL(a, location.href).toString() : a);
    w.postMessage({ input, artifacts: { wasm: abs(artifacts.wasm), zkey: abs(artifacts.zkey) } });
  });
}

export async function prove(input: CircuitInput, artifacts: Artifacts): Promise<OnchainProof> {
  let r: { proof: unknown; publicSignals: string[] };
  if (useWorker && !workerFailed && typeof Worker !== 'undefined' && typeof window !== 'undefined') {
    try { r = await proveInWorker(input, artifacts); } catch { workerFailed = true; r = await fullProve(input, artifacts); }
  } else r = await fullProve(input, artifacts);
  const { proof, publicSignals } = r as { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] };
  const a = proof.pi_a as string[];
  const b = proof.pi_b as string[][];
  const c = proof.pi_c as string[];
  const ps = publicSignals as string[];
  return {
    proofA: [...be(a[0]), ...be(a[1])],
    // upstream: for each G2 coordinate pair, LE bytes of both limbs concatenated then reversed == BE(limb1) ‖ BE(limb0)
    proofB: [...be(b[0][1]), ...be(b[0][0]), ...be(b[1][1]), ...be(b[1][0])],
    proofC: [...be(c[0]), ...be(c[1])],
    root: be(ps[0]),
    publicAmount: be(ps[1]),
    extDataHash: be(ps[2]),
    inputNullifiers: [be(ps[3]), be(ps[4])],
    outputCommitments: [be(ps[5]), be(ps[6])],
  };
}

/** publicAmount as a field element: deposits positive, withdrawals/fees negative (mod p). */
export function publicAmountField(extAmount: bigint, fee: bigint, fieldSize: bigint): string {
  const v = extAmount - fee;
  return ((v % fieldSize) + fieldSize) % fieldSize + '';
}

export function fieldHashToDecimal(hash: Uint8Array, fieldSize: bigint): string {
  // program compares Fr::from_le_bytes_mod_order(hash) with the proof's extDataHash public input
  let n = 0n;
  for (let i = hash.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(hash[i]);
  return (n % fieldSize).toString();
}
