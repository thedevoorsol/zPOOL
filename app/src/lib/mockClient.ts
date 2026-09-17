import type { PoolClient, PoolClientFactory, Progress, ProgressCb, ShieldedBalance, TokenInfo } from './pool-types';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LOGOS = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet';

const KNOWN: TokenInfo[] = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', decimals: 9, logoUri: `${LOGOS}/So11111111111111111111111111111111111111112/logo.png`, tokenProgram: TOKEN_PROGRAM, enabled: true },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoUri: `${LOGOS}/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png`, tokenProgram: TOKEN_PROGRAM, enabled: true },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD', decimals: 6, logoUri: `${LOGOS}/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg`, tokenProgram: TOKEN_PROGRAM, enabled: true },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6, tokenProgram: TOKEN_PROGRAM, enabled: true },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5, tokenProgram: TOKEN_PROGRAM, enabled: true },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', name: 'Marinade staked SOL', decimals: 9, tokenProgram: TOKEN_PROGRAM, enabled: true },
  { mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', symbol: 'PYUSD', name: 'PayPal USD', decimals: 6, tokenProgram: TOKEN_2022, enabled: false },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', name: 'Pyth Network', decimals: 6, tokenProgram: TOKEN_PROGRAM, enabled: false },
];

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const isBase58 = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randomBase58(len: number, seed?: number): string {
  let x = seed ?? Math.floor(Math.random() * 2 ** 31);
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += BASE58[x % BASE58.length];
  }
  return out;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * In-memory pool client with realistic delays. Balances live for the page session.
 * Demo hooks: an amount of exactly 13 (in whole tokens) makes the relayer "reject" the action
 * so the error state can be exercised; unknown 32-44 char base58 strings resolve to an
 * unlisted, not-yet-enabled token.
 */
export const createMockClient: PoolClientFactory = ({ walletAddress, signMessage, signAndSend }) => {
  const seed = hashSeed(walletAddress);
  let unlocked = false;
  const tokens: TokenInfo[] = KNOWN.map((t) => ({ ...t }));
  const publicBal = new Map<string, bigint>([
    ['So11111111111111111111111111111111111111112', 12_4831_00000n],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 2_530_000000n],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 410_000000n],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 1_920_500000n],
    ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 48_000_000_00000n],
    ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 3_050000000n],
    ['2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 100_000000n],
    ['HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', 0n],
  ]);
  const shieldedBal = new Map<string, bigint>([
    ['So11111111111111111111111111111111111111112', 4_200000000n],
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1_000_000000n],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 250_000000n],
  ]);
  const shieldedAddr = `sp${randomBase58(86, seed)}`;

  const requireUnlocked = () => {
    if (!unlocked) throw new Error('Unlock first');
  };
  const findToken = (mint: string) => tokens.find((t) => t.mint === mint);
  const requireEnabled = (mint: string) => {
    const t = findToken(mint);
    if (!t) throw new Error('Unknown token');
    if (!t.enabled) throw new Error(`${t.symbol} is not enabled in the pool yet`);
    return t;
  };
  const isCursed = (t: TokenInfo, amount: bigint) => amount === 13n * 10n ** BigInt(t.decimals);
  const fakeSig = () => randomBase58(88);
  const emit = (cb: ProgressCb | undefined, p: Progress) => cb?.(p);

  async function run(cb: ProgressCb | undefined, steps: Array<{ step: string; detail?: string; ms: number }>, sig: string) {
    for (const s of steps) {
      emit(cb, { step: s.step, detail: s.detail });
      await sleep(s.ms);
    }
    emit(cb, { step: 'Confirmed', signature: sig });
  }

  const client: PoolClient = {
    wallet: walletAddress,

    async unlock() {
      const msg = new TextEncoder().encode(`zPOOL\nUnlock shielded keys for ${walletAddress}\nThis signature never leaves your browser.`);
      await signMessage(msg);
      await sleep(350);
      unlocked = true;
    },
    isUnlocked: () => unlocked,
    shieldedAddress() {
      requireUnlocked();
      return shieldedAddr;
    },

    async tokens(query) {
      await sleep(120);
      const q = (query ?? '').trim();
      if (!q) return tokens.map((t) => ({ ...t }));
      const lower = q.toLowerCase();
      const hits = tokens.filter((t) => t.symbol.toLowerCase().includes(lower) || t.name.toLowerCase().includes(lower) || t.mint === q);
      if (hits.length === 0 && isBase58(q)) {
        // An unlisted mint pasted by the user: resolve it as a not-yet-enabled token.
        const t: TokenInfo = { mint: q, symbol: q.slice(0, 4).toUpperCase(), name: `Unlisted token ${q.slice(0, 4)}…${q.slice(-4)}`, decimals: 6, tokenProgram: TOKEN_PROGRAM, enabled: false };
        tokens.push(t);
        publicBal.set(q, 0n);
        return [{ ...t }];
      }
      return hits.map((t) => ({ ...t }));
    },

    async enableToken(mint, onProgress) {
      const t = findToken(mint);
      if (!t) throw new Error('Unknown token');
      const sig = fakeSig();
      emit(onProgress, { step: 'Signing', detail: 'Approve in your wallet' });
      await signAndSend(new Uint8Array([1, 2, 3]));
      await run(onProgress, [{ step: 'Creating pool vault', ms: 1100 }], sig);
      t.enabled = true;
      return { signature: sig };
    },

    async publicBalance(mint) {
      await sleep(150);
      return publicBal.get(mint) ?? 0n;
    },
    async shieldedBalances(): Promise<ShieldedBalance[]> {
      requireUnlocked();
      await sleep(200);
      return [...shieldedBal.entries()].filter(([, a]) => a > 0n).map(([mint, amount]) => ({ mint, amount }));
    },

    async deposit(mint, amount, onProgress) {
      requireUnlocked();
      const t = requireEnabled(mint);
      if (amount <= 0n) throw new Error('Enter an amount');
      if ((publicBal.get(mint) ?? 0n) < amount) throw new Error('Insufficient balance');
      emit(onProgress, { step: 'Building note', detail: 'Encrypting the deposit to your keys' });
      await sleep(700);
      emit(onProgress, { step: 'Signing', detail: 'Approve in your wallet' });
      await signAndSend(new Uint8Array([1]));
      const sig = fakeSig();
      await run(onProgress, [{ step: 'Sending', ms: 900 }], sig);
      if (isCursed(t, amount)) throw new Error('Transaction dropped by the network');
      publicBal.set(mint, (publicBal.get(mint) ?? 0n) - amount);
      shieldedBal.set(mint, (shieldedBal.get(mint) ?? 0n) + amount);
      return { signature: sig };
    },

    async withdraw(mint, amount, recipient, onProgress) {
      requireUnlocked();
      const t = requireEnabled(mint);
      if (amount <= 0n) throw new Error('Enter an amount');
      if (!isBase58(recipient)) throw new Error('Not a valid wallet address');
      if ((shieldedBal.get(mint) ?? 0n) < amount) throw new Error('Insufficient shielded balance');
      emit(onProgress, { step: 'Proving', detail: 'Generating the zero-knowledge proof in your browser' });
      await sleep(1600);
      emit(onProgress, { step: 'Relaying', detail: 'A relayer submits it and pays the gas' });
      await sleep(900);
      if (isCursed(t, amount)) throw new Error('Relayer rejected the proof (simulated)');
      const sig = fakeSig();
      await run(onProgress, [{ step: 'Sending', ms: 700 }], sig);
      shieldedBal.set(mint, (shieldedBal.get(mint) ?? 0n) - amount);
      return { signature: sig };
    },

    async send(mint, amount, shieldedAddress, onProgress) {
      requireUnlocked();
      const t = requireEnabled(mint);
      if (amount <= 0n) throw new Error('Enter an amount');
      if (!/^sp[1-9A-HJ-NP-Za-km-z]{80,92}$/.test(shieldedAddress)) throw new Error('Not a shielded address (expected sp…)');
      if (shieldedAddress === shieldedAddr) throw new Error('That is your own address');
      if ((shieldedBal.get(mint) ?? 0n) < amount) throw new Error('Insufficient shielded balance');
      emit(onProgress, { step: 'Proving', detail: 'Generating the zero-knowledge proof in your browser' });
      await sleep(1600);
      emit(onProgress, { step: 'Relaying', detail: 'Nobody sees the sender, receiver or amount' });
      await sleep(700);
      if (isCursed(t, amount)) throw new Error('Relayer rejected the proof (simulated)');
      const sig = fakeSig();
      await run(onProgress, [{ step: 'Sending', ms: 700 }], sig);
      shieldedBal.set(mint, (shieldedBal.get(mint) ?? 0n) - amount);
      return { signature: sig };
    },

    async fees() {
      await sleep(80);
      return { depositBps: 50, withdrawBps: 30, relayerFlatLamports: 6_000_000n };
    },
  };
  return client;
};
