import { useState } from 'react';
import type { TokenInfo } from '../lib/pool-types';

export function TokenLogo({ token, size = 24 }: { token: TokenInfo | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (!token) return <span className="logo logo-empty" style={style} />;
  if (token.logoUri && !broken) return <img className="logo" src={token.logoUri} alt="" style={style} onError={() => setBroken(true)} />;
  // Deterministic hue from the mint so unlisted tokens still look distinct.
  let h = 0;
  for (let i = 0; i < token.mint.length; i++) h = (h * 31 + token.mint.charCodeAt(i)) % 360;
  return (
    <span className="logo logo-fallback" style={{ ...style, background: `hsl(${h} 30% 22%)`, color: `hsl(${h} 60% 80%)` }}>
      {token.symbol.slice(0, 1)}
    </span>
  );
}
