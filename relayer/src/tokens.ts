/**
 * Token metadata + prices, sourced from Jupiter's public token API with on-chain fallbacks.
 *  - icons for the picker (the on-chain "uri" is usually a JSON file, not an image)
 *  - USD prices so relayer-paid operations can charge a FLAT fee in the token instead of a percentage
 *    (a percentage fee on a private send would reveal the amount sent: fee / rate = amount)
 */
const JUP = 'https://lite-api.jup.ag';
const SOL = 'So11111111111111111111111111111111111111112';
const NATIVE = '11111111111111111111111111111112'; // = SOL_MINT in the SDK

export type JupToken = { mint: string; symbol: string; name: string; decimals: number; logoUri: string | null; tokenProgram: string | null; usdPrice: number | null; liquidity: number | null };

const searchCache = new Map<string, { at: number; value: JupToken[] }>();
const SEARCH_TTL = 60_000;

/** Strip characters that render as nothing (Hangul filler, zero-width, braille blank, BOM) so "blank" names are caught. */
const INVISIBLE = /[\u3164\u115f\u1160\u200b-\u200f\u2028\u2029\u202f\u2060-\u206f\u2800\ufeff\u00a0]/g;
export function visible(text: string | null | undefined): string {
  return (text ?? '').replace(INVISIBLE, '').trim();
}
/** Symbol and name a human can read; falls back to the mint when the metadata is empty or invisible. */
export function displayNames(symbol: string | null | undefined, name: string | null | undefined, mint: string): { symbol: string; name: string } {
  const sym = visible(symbol);
  const nm = visible(name);
  return { symbol: sym || mint.slice(0, 4).toUpperCase(), name: nm || `Unnamed token ${mint.slice(0, 4)}…${mint.slice(-4)}` };
}

function norm(x: Record<string, unknown>): JupToken {
  const mint = String(x.id);
  const dn = displayNames(String(x.symbol ?? ''), String(x.name ?? ''), mint);
  return {
    mint,
    symbol: dn.symbol,
    name: dn.name,
    decimals: Number(x.decimals ?? 0),
    logoUri: typeof x.icon === 'string' && x.icon ? x.icon : null,
    tokenProgram: typeof x.tokenProgram === 'string' ? x.tokenProgram : null,
    usdPrice: typeof x.usdPrice === 'number' ? x.usdPrice : null,
    liquidity: typeof x.liquidity === 'number' ? x.liquidity : null,
  };
}

async function getJson(url: string, timeoutMs = 6000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Free-text or mint search (mints may be comma separated). Cached for a minute. */
export async function searchTokens(query: string): Promise<JupToken[]> {
  const q = query.trim().replace(/^11111111111111111111111111111112$/, SOL);
  if (!q) return [];
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.value;
  const raw = (await getJson(`${JUP}/tokens/v2/search?query=${encodeURIComponent(q)}`)) as Record<string, unknown>[];
  const value = (Array.isArray(raw) ? raw : []).map(norm).map((t) => (t.mint === SOL ? { ...t, mint: NATIVE, symbol: 'SOL', name: 'Solana' } : t));
  searchCache.set(q, { at: Date.now(), value });
  if (searchCache.size > 2000) searchCache.delete(searchCache.keys().next().value!);
  return value;
}

/** Metadata for a list of mints, in one call (Jupiter accepts up to 100 comma separated). Unknown mints are omitted. */
export async function tokensByMint(mints: string[]): Promise<Map<string, JupToken>> {
  const out = new Map<string, JupToken>();
  const uniq = [...new Set(mints.map((m) => (m === NATIVE ? SOL : m)))];
  for (let i = 0; i < uniq.length; i += 100) {
    const chunk = uniq.slice(i, i + 100);
    try {
      for (const t of await searchTokens(chunk.join(','))) out.set(t.mint, t);
    } catch {
      /* Jupiter down: caller falls back to on-chain metadata */
    }
  }
  return out;
}

/** Resolve an image URL from a metadata URI that may point at JSON ({ image }) or directly at an image. */
export async function imageFromUri(uri: string | null): Promise<string | null> {
  if (!uri) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(uri, { signal: ctl.signal });
    clearTimeout(t);
    const ct = r.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) return uri;
    const j = (await r.json()) as { image?: string };
    return typeof j.image === 'string' && j.image ? j.image : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- prices
const prices = new Map<string, { usd: number; at: number }>();
const PRICE_TTL = 5 * 60_000;

/** USD prices for the given mints (SOL included), refreshed at most every 5 minutes. Missing = no market. */
export async function refreshPrices(mints: string[]): Promise<void> {
  const ids = [...new Set([SOL, ...mints.map((m) => (m === NATIVE ? SOL : m))])];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const raw = (await getJson(`${JUP}/price/v3?ids=${chunk.join(',')}`)) as Record<string, { usdPrice?: number; liquidity?: number }>;
    for (const id of chunk) {
      const p = raw?.[id];
      // ignore markets too thin to price honestly
      if (p && typeof p.usdPrice === 'number' && p.usdPrice > 0 && (p.liquidity ?? 0) >= 1000) prices.set(id === SOL ? NATIVE : id, { usd: p.usdPrice, at: Date.now() });
      else prices.delete(id === SOL ? NATIVE : id);
    }
  }
}

export function usdPrice(mint: string): number | null {
  const p = prices.get(mint);
  return p && Date.now() - p.at < PRICE_TTL * 3 ? p.usd : null;
}

/** Round to two significant digits so the fee is the same for everyone in a price window (no fingerprinting). */
function round2sig(x: number): number {
  if (x <= 0) return 0;
  const e = Math.floor(Math.log10(x)) - 1;
  const m = 10 ** e;
  return Math.ceil(x / m) * m;
}

/**
 * Flat fee in raw token units worth `sol` SOL at current prices, or null when the token has no price.
 * The same value is charged for every send in the pool, so it says nothing about the amount moved.
 */
export function flatFeeInToken(mint: string, decimals: number, sol: number): bigint | null {
  if (mint === NATIVE) return BigInt(Math.round(sol * 1e9));
  const tok = usdPrice(mint);
  const solUsd = usdPrice(NATIVE);
  if (!tok || !solUsd) return null;
  const units = round2sig((sol * solUsd) / tok);
  return BigInt(Math.round(units * 10 ** decimals));
}
