/** Groth16 proving with snarkjs, output formatted for the on-chain verifier (big-endian, G2 limbs swapped). */
import { groth16 } from 'snarkjs';
import { bigToBytes32BE } from './crypto';

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

export async function prove(input: CircuitInput, artifacts: Artifacts): Promise<OnchainProof> {
  const wasm = typeof artifacts.wasm === 'string' ? artifacts.wasm : { type: 'mem', data: artifacts.wasm };
  const zkey = typeof artifacts.zkey === 'string' ? artifacts.zkey : { type: 'mem', data: artifacts.zkey };
  const { proof, publicSignals } = await groth16.fullProve(input as never, wasm as never, zkey as never);
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
