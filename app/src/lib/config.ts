const env = import.meta.env as Record<string, string | undefined>;

export const config = {
  /** solana:mainnet | solana:devnet */
  chain: (env.VITE_CHAIN || 'solana:mainnet') as `solana:${string}`,
  /** VITE_MOCK=1 uses the in-browser mock pool client. */
  mock: env.VITE_MOCK === '1' || env.VITE_MOCK === 'true',
};

export function explorerTx(sig: string): string {
  const cluster = config.chain.replace('solana:', '');
  return `https://solscan.io/tx/${sig}${cluster === 'mainnet' ? '' : `?cluster=${cluster}`}`;
}
