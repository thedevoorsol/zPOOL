import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PoolClient, Progress, TokenInfo } from '../lib/pool-types';
import type { Session } from '../lib/session';
import { createPoolClient } from '../lib/client';
import { bpsToPercent, formatCompact, parseAmount, sanitizeAmountInput } from '../lib/amounts';
import { explorerTx } from '../lib/config';
import { TokenLogo } from './TokenLogo';
import { TokenSelect } from './TokenSelect';
import { ReceiveModal } from './ReceiveModal';
import { Alert, Check, Chevron, External, Lock, Qr, Spinner } from './Icons';

export type Mode = 'shield' | 'send' | 'unshield';
const MODES: { id: Mode; label: string }[] = [
  { id: 'shield', label: 'Shield' },
  { id: 'send', label: 'Send' },
  { id: 'unshield', label: 'Unshield' },
];

type Run =
  | { kind: 'idle' }
  | { kind: 'running'; steps: Progress[] }
  | { kind: 'done'; steps: Progress[]; signature: string }
  | { kind: 'error'; message: string };

const isBase58 = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

export function Card({ session, onConnect }: { session: Session | null; onConnect: () => void }) {
  const client: PoolClient | null = useMemo(() => {
    if (!session) return null;
    return createPoolClient({ walletAddress: session.address, signMessage: session.signMessage, signAndSend: session.signAndSend });
  }, [session]);

  const [mode, setMode] = useState<Mode>('shield');
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [recipient, setRecipient] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [publicBal, setPublicBal] = useState<Map<string, bigint>>(new Map());
  const [shieldedBal, setShieldedBal] = useState<Map<string, bigint>>(new Map());
  const [fees, setFees] = useState<{ depositBps: number; withdrawBps: number; relayerFlatLamports: bigint } | null>(null);
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  // Default token + fees once a client exists.
  useEffect(() => {
    if (!client) return;
    let live = true;
    client.tokens().then((ts) => live && !token && ts[0] && setToken(ts[0])).catch(() => undefined);
    client.fees().then((f) => live && setFees(f)).catch(() => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const refreshPublic = useCallback(async (mint: string) => {
    if (!client) return;
    try {
      const b = await client.publicBalance(mint);
      setPublicBal((m) => new Map(m).set(mint, b));
    } catch { /* leave stale */ }
  }, [client]);

  const refreshShielded = useCallback(async () => {
    if (!client || !client.isUnlocked()) return;
    try {
      const list = await client.shieldedBalances();
      setShieldedBal(new Map(list.map((b) => [b.mint, b.amount])));
    } catch { /* leave stale */ }
  }, [client]);

  useEffect(() => { if (token) void refreshPublic(token.mint); }, [token, refreshPublic]);
  useEffect(() => { if (unlocked) void refreshShielded(); }, [unlocked, refreshShielded]);

  const decimals = token?.decimals ?? 0;
  const pub = token ? publicBal.get(token.mint) : undefined;
  const shd = token ? (shieldedBal.get(token.mint) ?? 0n) : undefined;
  const relevant = mode === 'shield' ? pub : shd;

  // Validation → primary button state.
  const primary = useMemo((): { label: string; action?: () => void; disabled?: boolean } => {
    if (!client) return { label: 'Connect wallet', action: onConnect };
    if (!unlocked) return { label: unlocking ? 'Check your wallet…' : 'Unlock', action: unlock, disabled: unlocking };
    if (!token) return { label: 'Select a token', action: () => setPickerOpen(true) };
    if (!token.enabled) return { label: `Enable ${token.symbol}`, action: enable };
    if (!amount.trim()) return { label: 'Enter an amount', disabled: true };
    let raw: bigint;
    try { raw = parseAmount(amount, decimals); } catch (e) { return { label: (e as Error).message, disabled: true }; }
    if (raw <= 0n) return { label: 'Enter an amount', disabled: true };
    if (relevant !== undefined && raw > relevant) return { label: `Insufficient ${mode === 'shield' ? '' : 'shielded '}balance`, disabled: true };
    if (mode === 'send') {
      if (!to.trim()) return { label: 'Enter their shielded address', disabled: true };
      if (!to.trim().startsWith('sp')) return { label: 'Shielded addresses start with sp', disabled: true };
      return { label: 'Send privately', action: () => execute(raw) };
    }
    if (mode === 'unshield') {
      if (!recipient.trim()) return { label: 'Enter a wallet address', disabled: true };
      if (!isBase58(recipient.trim())) return { label: 'That is not a Solana wallet address', disabled: true };
      return { label: 'Unshield', action: () => execute(raw) };
    }
    return { label: 'Shield', action: () => execute(raw) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, unlocked, unlocking, token, amount, decimals, relevant, mode, to, recipient]);

  async function unlock() {
    if (!client) return;
    setUnlocking(true);
    setRun({ kind: 'idle' });
    try {
      await client.unlock();
      setUnlocked(true);
    } catch (e) {
      setRun({ kind: 'error', message: shortError(e) });
    } finally {
      setUnlocking(false);
    }
  }

  function track(): { cb: (p: Progress) => void; steps: Progress[] } {
    const steps: Progress[] = [];
    return {
      steps,
      cb: (p) => {
        steps.push(p);
        setRun({ kind: 'running', steps: [...steps] });
      },
    };
  }

  async function enable() {
    if (!client || !token) return;
    const t = track();
    setRun({ kind: 'running', steps: [] });
    try {
      const res = await client.enableToken(token.mint, t.cb);
      setToken({ ...token, enabled: true });
      setRun({ kind: 'done', steps: t.steps, signature: res.signature });
    } catch (e) {
      setRun({ kind: 'error', message: shortError(e) });
    }
  }

  async function execute(raw: bigint) {
    if (!client || !token) return;
    const t = track();
    setRun({ kind: 'running', steps: [] });
    try {
      let res;
      if (mode === 'shield') res = await client.deposit(token.mint, raw, t.cb);
      else if (mode === 'send') res = await client.send(token.mint, raw, to.trim(), t.cb);
      else res = await client.withdraw(token.mint, raw, recipient.trim(), t.cb);
      setRun({ kind: 'done', steps: t.steps, signature: res.signature });
      setAmount('');
    } catch (e) {
      setRun({ kind: 'error', message: shortError(e) });
    } finally {
      void refreshPublic(token.mint);
      void refreshShielded();
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    if (run.kind !== 'running') setRun({ kind: 'idle' });
  }

  const busy = run.kind === 'running';
  const showFee = mode !== 'shield';

  return (
    <section className="card" aria-label="zPOOL">
      <div className="card-head">
        <div className="seg" role="tablist">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} disabled={busy} onClick={() => switchMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Receive: show your shielded address" aria-label="Receive" onClick={() => setReceiveOpen(true)}>
          <Qr />
        </button>
      </div>

      <div className="field">
        <div className="field-top">
          <span className="label">{mode === 'shield' ? 'You shield' : mode === 'send' ? 'You send' : 'You unshield'}</span>
          <span className="bal">
            {mode === 'shield' ? 'Public' : 'Shielded'}:{' '}
            {mode !== 'shield' && !unlocked ? (
              <Lock className="lock" />
            ) : relevant === undefined ? (
              <span className="mono">–</span>
            ) : (
              <span className="mono">{formatCompact(relevant, decimals)}</span>
            )}
            {relevant !== undefined && (mode === 'shield' || unlocked) && relevant > 0n && (
              <button className="max" disabled={busy} onClick={() => { setAmount(formatCompact(relevant, decimals).replace(/,/g, '')); amountRef.current?.focus(); }}>MAX</button>
            )}
          </span>
        </div>
        <div className="field-row">
          <button className="token-btn" disabled={busy || !client} onClick={() => setPickerOpen(true)}>
            <TokenLogo token={token} size={26} />
            <span className="sym">{token ? token.symbol : 'Select'}</span>
            <Chevron className="chev" />
          </button>
          <input
            ref={amountRef}
            id="amount"
            className="amount mono"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0"
            value={amount}
            disabled={busy || !client}
            onChange={(e) => setAmount(sanitizeAmountInput(e.target.value, decimals))}
          />
        </div>
        {token && !token.enabled && client && (
          <div className="note">
            <Alert /> {token.symbol} has no pool yet. One click opens it for everyone.
          </div>
        )}
      </div>

      {mode === 'send' && (
        <div className="field">
          <div className="field-top"><span className="label">To their shielded address</span></div>
          <input className="addr mono" placeholder="sp…" value={to} disabled={busy || !client} spellCheck={false} autoComplete="off" onChange={(e) => setTo(e.target.value.trim())} />
          <div className="hint">Ask them to open Receive and share it. Nobody sees who paid whom, or how much.</div>
        </div>
      )}
      {mode === 'unshield' && (
        <div className="field">
          <div className="field-top">
            <span className="label">To wallet</span>
            {session && <button className="link-btn" disabled={busy} onClick={() => setRecipient(session.address)}>mine</button>}
          </div>
          <input className="addr mono" placeholder="Any Solana address" value={recipient} disabled={busy || !client} spellCheck={false} autoComplete="off" onChange={(e) => setRecipient(e.target.value.trim())} />
          <div className="hint">Any wallet works, even a brand-new empty one. Gas is paid for you.</div>
        </div>
      )}

      {run.kind === 'running' || run.kind === 'done' ? (
        <Stepper run={run} onDone={() => setRun({ kind: 'idle' })} />
      ) : (
        <button className={`primary ${!client ? 'connect' : !unlocked ? 'unlock' : ''}`} disabled={primary.disabled} onClick={primary.action}>
          {!client ? null : !unlocked ? (unlocking ? <Spinner /> : <Lock />) : null}
          {primary.label}
        </button>
      )}

      {run.kind === 'error' && (
        <div className="error" role="alert"><Alert /> {run.message}</div>
      )}

      <div className="fee">
        {showFee ? (
          fees ? `Fee ${bpsToPercent(fees.withdrawBps)} · gas paid by relayer` : ' '
        ) : (
          fees && fees.depositBps > 0 ? `Fee ${bpsToPercent(fees.depositBps)} · one wallet signature` : 'No fee · one wallet signature'
        )}
      </div>

      {pickerOpen && client && (
        <TokenSelect
          client={client}
          mode={mode}
          unlocked={unlocked}
          shielded={shieldedBal}
          onClose={() => setPickerOpen(false)}
          onPick={(t) => { setToken(t); setAmount(''); setPickerOpen(false); if (run.kind !== 'running') setRun({ kind: 'idle' }); }}
        />
      )}
      {receiveOpen && (
        <ReceiveModal client={client} unlocked={unlocked} unlocking={unlocking} onUnlock={unlock} onConnect={onConnect} onClose={() => setReceiveOpen(false)} />
      )}
    </section>
  );
}

function Stepper({ run, onDone }: { run: Extract<Run, { kind: 'running' | 'done' }>; onDone: () => void }) {
  const steps = [...run.steps];
  if (run.kind === 'done' && !steps.some((s) => s.signature)) steps.push({ step: 'Confirmed', signature: run.signature });
  if (run.kind === 'running' && steps.length === 0) steps.push({ step: 'Preparing' });
  return (
    <div className="stepper" aria-live="polite">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const active = run.kind === 'running' && last;
        const confirmed = !!s.signature;
        return (
          <div key={i} className={`step ${active ? 'active' : 'done'} ${confirmed ? 'confirmed' : ''}`}>
            <span className="step-icon">{active ? <Spinner /> : <Check />}</span>
            <span className="step-text">
              <span className="step-name">{s.step}{active ? '…' : confirmed ? ' ✓' : ''}</span>
              {s.detail && active && <span className="step-detail">{s.detail}</span>}
              {s.signature && (
                <a className="tx mono" href={explorerTx(s.signature)} target="_blank" rel="noreferrer">
                  {s.signature.slice(0, 8)}…{s.signature.slice(-6)} <External width={12} height={12} />
                </a>
              )}
            </span>
          </div>
        );
      })}
      {run.kind === 'done' && (
        <button className="primary ghost" onClick={onDone}>Done</button>
      )}
    </div>
  );
}

function shortError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const first = m.split('\n')[0].trim();
  return first.length > 120 ? `${first.slice(0, 117)}…` : first || 'Something went wrong';
}
