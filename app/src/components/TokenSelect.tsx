import { useEffect, useRef, useState } from 'react';
import type { PoolClient, TokenInfo } from '../lib/pool-types';
import type { Mode } from './Card';
import { formatCompact, short } from '../lib/amounts';
import { Modal } from './Modal';
import { TokenLogo } from './TokenLogo';
import { Lock, Search } from './Icons';

export function TokenSelect({ client, mode, unlocked, shielded, onClose, onPick }: {
  client: PoolClient;
  mode: Mode;
  unlocked: boolean;
  shielded: Map<string, bigint>;
  onClose: () => void;
  onPick: (t: TokenInfo) => void;
}) {
  const [query, setQuery] = useState('');
  const [list, setList] = useState<TokenInfo[] | null>(null);
  const [publicBal, setPublicBal] = useState<Map<string, bigint>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    let live = true;
    const h = setTimeout(async () => {
      try {
        const ts = await client.tokens(query.trim() || undefined);
        if (!live) return;
        setList(ts);
        if (mode === 'shield') {
          const entries = await Promise.all(ts.slice(0, 12).map(async (t) => [t.mint, await client.publicBalance(t.mint)] as const));
          if (live) setPublicBal(new Map(entries));
        }
      } catch {
        if (live) setList([]);
      }
    }, query ? 160 : 0);
    return () => { live = false; clearTimeout(h); };
  }, [client, query, mode]);

  const balanceOf = (t: TokenInfo) => (mode === 'shield' ? publicBal.get(t.mint) : shielded.get(t.mint) ?? 0n);

  return (
    <Modal title="Select a token" onClose={onClose}>
      <div className="search">
        <Search />
        <input ref={inputRef} placeholder="Search name, symbol, or paste a mint address" value={query} spellCheck={false} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="token-list">
        {list === null && <div className="muted center">Loading…</div>}
        {list && list.length === 0 && <div className="muted center">No token found. Paste a full mint address to add one.</div>}
        {list?.map((t) => {
          const b = balanceOf(t);
          return (
            <button key={t.mint} className="token-row" onClick={() => onPick(t)}>
              <TokenLogo token={t} size={32} />
              <span className="token-meta">
                <span className="token-sym">
                  {t.symbol}
                  {!t.enabled && <span className="tag">not enabled</span>}
                </span>
                <span className="token-name">{t.name} <span className="mono dim">{short(t.mint)}</span></span>
              </span>
              <span className="token-bal mono">
                {mode !== 'shield' && !unlocked ? <Lock className="lock" /> : b === undefined ? '' : b > 0n ? formatCompact(b, t.decimals) : ''}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
