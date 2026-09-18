/** HTTP client for the relayer / indexer. */
export type RelayerConfig = {
  programId: string;
  relayer: string;
  feeRecipient: string;
  depositFeeBps: number;
  withdrawFeeBps: number;
  /** always 0: private sends charge a flat per-pool fee (PoolInfo.sendFee) so the fee cannot reveal the amount */
  sendFeeBps: number;
  sendFlatSol?: number;
  withdrawFlatSol?: number;
  solFlatLamports: string;
  chain: string;
};
export type PoolInfo = {
  mint: string;
  tokenProgram: string;
  decimals: number;
  symbol: string;
  name: string;
  logoUri?: string;
  tree: string;
  vault: string;
  alt: string | null;
  feeAta: string | null;
  /** relayer's minimum fee for this token, raw units */
  minFee: string;
  /** flat fee for a private send, raw units; identical for every send in the pool at a given time */
  sendFee?: string;
  /** withdrawals pay max(percentage, this), raw units */
  withdrawMinFee?: string;
  usdPrice?: number | null;
  /** false = the relayer has no market price for this token and will not relay for it */
  priced?: boolean;
  leaves: number;
};
export type SearchToken = { mint: string; symbol: string; name: string; decimals: number; logoUri: string | null; tokenProgram: string | null; usdPrice: number | null; hasPool: boolean };
export type UtxoRow = { index: number; commitment: string; encryptedOutput: string; signature: string };
export type RelayRequest = {
  kind: 'withdraw' | 'send';
  mint: string;
  proof: import('./prover.js').OnchainProof;
  extAmount: string;
  fee: string;
  recipient: string;
  encryptedOutput1: string; // base64
  encryptedOutput2: string; // base64
};

export class RelayerApi {
  constructor(readonly baseUrl: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(this.baseUrl + path);
    if (!r.ok) throw new Error(`relayer ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`relayer ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }

  config(): Promise<RelayerConfig> {
    return this.get('/config');
  }
  pools(): Promise<PoolInfo[]> {
    return this.get('/pools');
  }
  pool(mint: string): Promise<PoolInfo | null> {
    return this.get(`/pools/${mint}`);
  }
  /** resolve token metadata for any mint (creates no pool) */
  token(mint: string): Promise<Omit<PoolInfo, 'tree' | 'vault' | 'alt' | 'feeAta' | 'minFee' | 'leaves'> & { hasPool: boolean }> {
    return this.get(`/token/${mint}`);
  }
  /** search by name, symbol or mint (Jupiter-backed, with icons) */
  search(q: string): Promise<SearchToken[]> {
    return this.get(`/tokens/search?q=${encodeURIComponent(q)}`);
  }
  /** metadata for many mints at once; null for unknown ones */
  meta(mints: string[]): Promise<(SearchToken | null)[]> {
    return this.get(`/tokens/meta?mints=${mints.join(',')}`);
  }
  utxos(mint: string, start = 0): Promise<{ utxos: UtxoRow[]; nextIndex: number; root: string }> {
    return this.get(`/utxos?mint=${mint}&start=${start}`);
  }
  nullifiers(hexes: string[]): Promise<{ spent: boolean[] }> {
    return this.post('/nullifiers', { nullifiers: hexes });
  }
  merklePath(mint: string, index: number): Promise<{ pathElements: string[]; pathIndices: number; root: string }> {
    return this.get(`/merkle/path?mint=${mint}&index=${index}`);
  }
  merkleRoot(mint: string): Promise<{ root: string; leaves: number }> {
    return this.get(`/merkle/root?mint=${mint}`);
  }
  relay(req: RelayRequest): Promise<{ signature: string }> {
    return this.post('/relay', req);
  }
  /** ask the relayer to set up its side of a pool (fee ATA + lookup table) once the on-chain pool exists */
  registerPool(mint: string): Promise<PoolInfo> {
    return this.post('/pools', { mint });
  }
}
