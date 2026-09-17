export type TokenInfo = { mint: string; symbol: string; name: string; decimals: number; logoUri?: string; tokenProgram: string; enabled: boolean };
export type ShieldedBalance = { mint: string; amount: bigint };
export type TxResult = { signature: string };
export type Progress = { step: string; detail?: string; signature?: string };
export type ProgressCb = (p: Progress) => void;
export interface PoolClient {
  readonly wallet: string | null;                 // connected wallet address
  unlock(): Promise<void>;                        // one wallet signature -> keys; required before shielded ops
  isUnlocked(): boolean;
  shieldedAddress(): string;                      // this user's receiving address for private payments
  tokens(query?: string): Promise<TokenInfo[]>;   // known tokens; query may be a symbol or a full mint address
  enableToken(mint: string, onProgress?: ProgressCb): Promise<TxResult>; // one-time per token, anyone can do it
  publicBalance(mint: string): Promise<bigint>;
  shieldedBalances(): Promise<ShieldedBalance[]>;
  deposit(mint: string, amount: bigint, onProgress?: ProgressCb): Promise<TxResult>;
  withdraw(mint: string, amount: bigint, recipient: string, onProgress?: ProgressCb): Promise<TxResult>;
  send(mint: string, amount: bigint, shieldedAddress: string, onProgress?: ProgressCb): Promise<TxResult>;
  fees(): Promise<{ depositBps: number; withdrawBps: number; relayerFlatLamports: bigint }>;
}
export type PoolClientFactory = (args: { walletAddress: string; signMessage: (bytes: Uint8Array) => Promise<Uint8Array>; signAndSend: (tx: Uint8Array) => Promise<string> }) => PoolClient;
