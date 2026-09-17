/** PoolClient backed by the shieldpool SDK: proofs in the browser, relayer for gasless withdraw/send. */
import { Connection, PublicKey } from '@solana/web3.js';
import { ShieldPool } from '../../../sdk/src/pool';
import { SOL_MINT } from '../../../sdk/src/utxo';
import type { PoolClient, PoolClientFactory, ProgressCb, ShieldedBalance, TokenInfo, TxResult } from './pool-types';

const env = import.meta.env as Record<string, string | undefined>;
const RPC_URL = env.VITE_RPC_URL || 'https://api.mainnet-beta.solana.com';
const RELAYER_URL = env.VITE_RELAYER_URL || 'http://127.0.0.1:8787';
const artifacts = { wasm: '/circuits/transaction2.wasm', zkey: '/circuits/transaction2.zkey' };

let shared: Promise<ShieldPool> | null = null;
function pool(): Promise<ShieldPool> {
  if (!shared) shared = ShieldPool.init({ connection: new Connection(RPC_URL, 'confirmed'), relayerUrl: RELAYER_URL, artifacts });
  return shared;
}

export const createRealClient: PoolClientFactory = ({ walletAddress, signMessage, signAndSend }) => {
  const wallet = new PublicKey(walletAddress);
  let unlocked = false;
  let cachedAddress: string | null = null;

  const toInfo = (p: { mint: string; tokenProgram: string; decimals: number; symbol: string; name: string; logoUri?: string; alt?: string | null; hasPool?: boolean }): TokenInfo => ({
    mint: p.mint,
    tokenProgram: p.tokenProgram,
    decimals: p.decimals,
    symbol: p.symbol,
    name: p.name,
    logoUri: p.logoUri,
    enabled: p.mint === SOL_MINT.toBase58() ? true : p.hasPool !== undefined ? p.hasPool : !!p.alt,
  });

  const client: PoolClient = {
    wallet: walletAddress,
    async unlock() {
      const p = await pool();
      await p.unlock(wallet, signMessage);
      cachedAddress = p.shieldedAddress();
      unlocked = true;
    },
    isUnlocked: () => unlocked,
    shieldedAddress() {
      if (!cachedAddress) throw new Error('locked');
      return cachedAddress;
    },
    async tokens(query?: string) {
      const p = await pool();
      const pools = await p.relayer.pools();
      const list = pools.map(toInfo);
      const q = (query ?? '').trim();
      if (q.length >= 32 && q.length <= 44 && !list.some((t) => t.mint === q)) {
        try {
          const t = await p.relayer.token(q);
          list.unshift(toInfo(t));
        } catch {
          /* not a mint */
        }
      }
      if (!q) return list;
      const ql = q.toLowerCase();
      return list.filter((t) => t.mint === q || t.symbol.toLowerCase().includes(ql) || t.name.toLowerCase().includes(ql));
    },
    async enableToken(mint, onProgress) {
      const p = await pool();
      onProgress?.({ step: 'building', detail: 'opening the pool for this token' });
      const tx = await p.createPoolTx(new PublicKey(mint), wallet);
      onProgress?.({ step: 'signing', detail: 'approve in your wallet' });
      const signature = await signAndSend(tx.serialize());
      onProgress?.({ step: 'confirming', signature });
      await waitConfirmed(p, signature);
      onProgress?.({ step: 'relayer', detail: 'relayer is setting up fee account and lookup table' });
      await p.relayer.registerPool(mint);
      for (let i = 0; i < 30; i++) {
        const info = await p.pool(new PublicKey(mint));
        if (info?.alt) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      await new Promise((r) => setTimeout(r, 2500)); // let the new lookup table settle before the first deposit
      onProgress?.({ step: 'confirmed', signature });
      return { signature };
    },
    async publicBalance(mint) {
      const p = await pool();
      const m = new PublicKey(mint);
      if (m.equals(SOL_MINT)) return BigInt(await p.connection.getBalance(wallet, 'confirmed'));
      const info = await p.pool(m);
      const tokenProgram = info ? new PublicKey(info.tokenProgram) : await p.tokenProgramOf(m);
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const ata = getAssociatedTokenAddressSync(m, wallet, false, tokenProgram);
      try {
        const bal = await p.connection.getTokenAccountBalance(ata, 'confirmed');
        return BigInt(bal.value.amount);
      } catch {
        return 0n;
      }
    },
    async shieldedBalances(): Promise<ShieldedBalance[]> {
      if (!unlocked) return [];
      const p = await pool();
      const pools = await p.relayer.pools();
      const out: ShieldedBalance[] = [];
      for (const info of pools) {
        if (info.leaves === 0) continue;
        const m = new PublicKey(info.mint);
        await p.sync(m);
        out.push({ mint: info.mint, amount: p.balance(m) });
      }
      return out;
    },
    async deposit(mint, amount, onProgress): Promise<TxResult> {
      const p = await pool();
      const tx = await p.buildDepositTx(new PublicKey(mint), amount, wallet, onProgress);
      onProgress?.({ step: 'signing', detail: 'approve in your wallet' });
      const signature = await signAndSend(tx.serialize());
      onProgress?.({ step: 'confirming', signature });
      await waitConfirmed(p, signature);
      await new Promise((r) => setTimeout(r, 1500));
      await p.sync(new PublicKey(mint));
      onProgress?.({ step: 'confirmed', signature });
      return { signature };
    },
    async withdraw(mint, amount, recipient, onProgress): Promise<TxResult> {
      const p = await pool();
      const signature = await p.withdraw(new PublicKey(mint), amount, new PublicKey(recipient), onProgress);
      return { signature };
    },
    async send(mint, amount, shieldedAddress, onProgress): Promise<TxResult> {
      const p = await pool();
      const signature = await p.send(new PublicKey(mint), amount, shieldedAddress, onProgress);
      return { signature };
    },
    async fees() {
      const p = await pool();
      const c = await p.config();
      return { depositBps: c.depositFeeBps ?? 0, withdrawBps: c.withdrawFeeBps, relayerFlatLamports: BigInt(c.solFlatLamports) };
    },
  };

  return client;
};

async function waitConfirmed(p: ShieldPool, signature: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const st = await p.connection.getSignatureStatuses([signature]);
    const s = st.value[0];
    if (s?.err) throw new Error('transaction failed: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timed out waiting for confirmation');
}

export type { ProgressCb };
