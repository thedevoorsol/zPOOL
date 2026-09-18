/// <reference lib="webworker" />
/** Web Worker entry: runs the Groth16 prover off the main thread. Bundlers resolve it via new URL('./prover.worker.js', import.meta.url). */
import { fullProve, type Artifacts, type CircuitInput } from './prover.js';
self.onmessage = async (ev: MessageEvent<{ input: CircuitInput; artifacts: Artifacts }>) => {
  try {
    const result = await fullProve(ev.data.input, ev.data.artifacts);
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (e) {
    (self as unknown as Worker).postMessage({ ok: false, error: (e as Error).message });
  }
};
