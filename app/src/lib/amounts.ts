/** Raw bigint -> human string using the token's decimals. No floats anywhere. */
export function formatAmount(raw: bigint, decimals: number, maxFrac = decimals): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  let frac = s.slice(s.length - decimals).slice(0, Math.max(0, maxFrac)).replace(/0+$/, '');
  const intGrouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${intGrouped}${frac ? `.${frac}` : ''}`;
}

/** Compact display: up to 6 fractional digits for wide-decimal tokens. */
export function formatCompact(raw: bigint, decimals: number): string {
  return formatAmount(raw, decimals, Math.min(decimals, 6));
}

/** Strict parse of user text -> raw bigint. Throws with a short human message. */
export function parseAmount(text: string, decimals: number): bigint {
  const t = text.trim().replace(/,/g, '');
  if (t === '' || t === '.') throw new Error('Enter an amount');
  if (!/^\d*(\.\d*)?$/.test(t)) throw new Error('Digits only');
  const [i, f = ''] = t.split('.');
  if (f.length > decimals) throw new Error(`Max ${decimals} decimals`);
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Keep only characters that can form a valid decimal number as the user types. */
export function sanitizeAmountInput(text: string, decimals: number): string {
  let out = text.replace(/[^\d.]/g, '');
  const firstDot = out.indexOf('.');
  if (firstDot !== -1) out = out.slice(0, firstDot + 1) + out.slice(firstDot + 1).replace(/\./g, '');
  if (decimals === 0) out = out.replace(/\./g, '');
  const [i, f] = out.split('.');
  if (f !== undefined && f.length > decimals) out = `${i}.${f.slice(0, decimals)}`;
  return out;
}

export function lamportsToSol(lamports: bigint): string {
  return formatAmount(lamports, 9, 4);
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function short(addr: string, n = 4): string {
  return addr.length <= n * 2 + 1 ? addr : `${addr.slice(0, n)}…${addr.slice(-n)}`;
}
