import { useEffect, useState } from 'react';
import { Close } from './Icons';

/**
 * Four-step explainer. Every animation is inline SVG driven by CSS keyframes in styles.css
 * (no images, no libraries). Remounting a step (key={step}) restarts its animation.
 */

export const STEPS = [
  { id: 'shield', title: 'Shield', text: 'Put coins in the pool. They turn into a secret note only you can read.' },
  { id: 'pay', title: 'Pay privately', text: "Send part of your note to a friend's secret address. Nobody sees who paid whom, or how much." },
  { id: 'unshield', title: 'Unshield', text: 'Take coins out to any wallet, even a brand-new empty one. We pay the gas.' },
  { id: 'any', title: 'Any token', text: "Works for every Solana coin. If a coin isn't in yet, one click opens its pool for everyone." },
] as const;

export function HowItWorks({ firstVisit, initialStep = 0, onClose, onStart }: {
  firstVisit: boolean;
  initialStep?: number;
  onClose: () => void;
  onStart: () => void;
}) {
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 0), STEPS.length - 1));
  const last = step === STEPS.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const s = STEPS[step];
  return (
    <div className="overlay hiw-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hiw" role="dialog" aria-modal="true" aria-label="How zPOOL works">
        <div className="hiw-head">
          <span className="hiw-kicker">How it works <span className="dim mono">{step + 1}/{STEPS.length}</span></span>
          {firstVisit ? (
            <button className="hiw-skip" onClick={onClose}>Skip</button>
          ) : (
            <button className="icon-btn" onClick={onClose} aria-label="Close"><Close /></button>
          )}
        </div>

        <div className="hiw-stage" key={s.id} aria-hidden="true">
          {s.id === 'shield' && <ShieldAnim />}
          {s.id === 'pay' && <PayAnim />}
          {s.id === 'unshield' && <UnshieldAnim />}
          {s.id === 'any' && <AnyTokenAnim />}
        </div>

        <div className="hiw-body" key={`t-${s.id}`}>
          <h2>{s.title}</h2>
          <p>{s.text}</p>
        </div>

        <div className="hiw-nav">
          <div className="hiw-dots" role="tablist" aria-label="Steps">
            {STEPS.map((x, i) => (
              <button key={x.id} role="tab" aria-selected={i === step} aria-label={`${i + 1}. ${x.title}`} className={i === step ? 'on' : ''} onClick={() => setStep(i)} />
            ))}
          </div>
          <div className="hiw-btns">
            {step > 0 && <button className="hiw-back" onClick={() => setStep(step - 1)}>Back</button>}
            {last ? (
              <button className="primary hiw-start" onClick={onStart}>Start</button>
            ) : (
              <button className="primary hiw-next" onClick={() => setStep(step + 1)}>Next</button>
            )}
          </div>
        </div>

        <p className="hiw-honest">
          <b>Public:</b> the amounts going in and out at the door, and which coin. <b>Private:</b> everything inside — balances, senders, receivers, amounts.
        </p>
      </div>
    </div>
  );
}

/* ---------- shared drawing bits ---------- */

const VB = '0 0 320 180';

function Pool({ x = 160, y = 132, rx = 92 }: { x?: number; y?: number; rx?: number }) {
  return (
    <g className="a-pool">
      <ellipse cx={x} cy={y} rx={rx} ry={22} fill="url(#poolFill)" />
      <ellipse cx={x} cy={y} rx={rx} ry={22} fill="none" stroke="rgba(160,145,255,0.45)" strokeWidth="1" />
      <ellipse className="a-ripple" cx={x} cy={y} rx={rx * 0.55} ry={12} fill="none" stroke="rgba(160,145,255,0.5)" strokeWidth="1" />
      <ellipse className="a-ripple r2" cx={x} cy={y} rx={rx * 0.55} ry={12} fill="none" stroke="rgba(160,145,255,0.5)" strokeWidth="1" />
    </g>
  );
}

function Defs() {
  return (
    <defs>
      <radialGradient id="poolFill" cx="50%" cy="45%" r="60%">
        <stop offset="0%" stopColor="#1a1633" />
        <stop offset="100%" stopColor="#0a0912" />
      </radialGradient>
      <linearGradient id="coinFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#ffe9a3" />
        <stop offset="100%" stopColor="#e0b04a" />
      </linearGradient>
      <linearGradient id="envFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#2a2452" />
        <stop offset="100%" stopColor="#161330" />
      </linearGradient>
      <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="3" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
  );
}

function Coin({ x, y, r = 13, label = '◎', className = '' }: { x: number; y: number; r?: number; label?: string; className?: string }) {
  return (
    <g className={`a-coin ${className}`}>
      <circle cx={x} cy={y} r={r} fill="url(#coinFill)" stroke="#8a6a1e" strokeWidth="1" />
      <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle" fontSize={r * 0.95} fontWeight="600" fill="#5a3f0a" fontFamily="Geist Mono, ui-monospace, monospace">{label}</text>
    </g>
  );
}

/** Sealed envelope, 44x30 centred at (x, y). The animated class sits on an inner group so a CSS
 *  transform never overrides the positioning transform attribute. */
function Envelope({ x, y, scale = 1, className = '', open = false }: { x: number; y: number; scale?: number; className?: string; open?: boolean }) {
  const w = 44;
  const h = 30;
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={`a-env ${className}`}>
        <g transform={`scale(${scale})`} filter="url(#glow)">
          <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="4" fill="url(#envFill)" stroke="#a091ff" strokeWidth="1.2" />
          {/* body fold lines */}
          <path d={`M${-w / 2} ${h / 2 - 2} L0 ${-1} L${w / 2} ${h / 2 - 2}`} fill="none" stroke="rgba(160,145,255,0.55)" strokeWidth="1" />
          {/* flap */}
          <g className={open ? 'a-flap open' : 'a-flap'} style={{ transformOrigin: `0px ${-h / 2}px` }}>
            <path d={`M${-w / 2} ${-h / 2} L0 ${h / 2 - 12} L${w / 2} ${-h / 2} Z`} fill="#2f2960" stroke="#a091ff" strokeWidth="1.2" />
            <circle cx="0" cy="0" r="4" fill="#a091ff" />
          </g>
        </g>
      </g>
    </g>
  );
}

function Person({ x, y, className = '' }: { x: number; y: number; className?: string }) {
  return (
    <g className={`a-person ${className}`}>
      <circle cx={x} cy={y - 14} r="8" fill="rgba(236,235,245,0.9)" />
      <path d={`M${x - 16} ${y + 14} a16 16 0 0 1 32 0z`} fill="rgba(236,235,245,0.9)" />
    </g>
  );
}

function Eye({ x, y, delay }: { x: number; y: number; delay: number }) {
  return (
    <g className="a-eye" style={{ animationDelay: `${delay}s` }}>
      <path d={`M${x - 12} ${y} q12 -10 24 0 q-12 10 -24 0z`} fill="none" stroke="#6d6b80" strokeWidth="1.4" />
      <circle cx={x} cy={y} r="3.2" fill="#6d6b80" />
      <text className="a-q" x={x} y={y - 12} textAnchor="middle" fontSize="12" fontWeight="600" fill="#a5a3b8" fontFamily="Geist Mono, ui-monospace, monospace" style={{ animationDelay: `${delay + 0.4}s` }}>?</text>
    </g>
  );
}

function Wallet({ x, y, tag, className = '' }: { x: number; y: number; tag?: string; className?: string }) {
  return (
    <g className={`a-wallet ${className}`}>
      <rect x={x - 30} y={y - 20} width="60" height="40" rx="7" fill="#151425" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <path d={`M${x - 30} ${y - 12} h48 a5 5 0 0 1 5 5 v14 a5 5 0 0 1 -5 5 h-48`} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x={x + 10} y={y - 4} width="14" height="9" rx="2" fill="rgba(160,145,255,0.5)" />
      {tag && (
        <g>
          <rect x={x - 16} y={y + 24} width="32" height="12" rx="6" fill="rgba(160,145,255,0.16)" />
          <text x={x} y={y + 30.5} textAnchor="middle" dominantBaseline="middle" fontSize="7.5" fontWeight="600" letterSpacing="0.06em" fill="#a091ff" fontFamily="Geist, system-ui, sans-serif">{tag}</text>
        </g>
      )}
    </g>
  );
}

/* ---------- step 1: Shield ---------- */
function ShieldAnim() {
  return (
    <svg viewBox={VB} className="anim anim-shield">
      <Defs />
      {/* wallet balance counter */}
      <g fontFamily="Geist Mono, ui-monospace, monospace" fontSize="12" fill="#a5a3b8">
        <text x="160" y="28" textAnchor="middle" fontSize="10.5" fill="#6d6b80" fontFamily="Geist, system-ui, sans-serif">WALLET</text>
        <text className="a-count a-count-1" x="160" y="46" textAnchor="middle" fontSize="15" fontWeight="500" fill="#ecebf5">1.00 SOL</text>
        <text className="a-count a-count-0" x="160" y="46" textAnchor="middle" fontSize="15" fontWeight="500" fill="#ecebf5">0.00 SOL</text>
      </g>
      <Pool />
      <Coin x={160} y={80} className="a-coin-drop" />
      <Envelope x={160} y={122} className="a-env-rise" />
    </svg>
  );
}

/* ---------- step 2: Pay privately ---------- */
function PayAnim() {
  return (
    <svg viewBox={VB} className="anim anim-pay">
      <Defs />
      <Person x={70} y={64} />
      <Person x={250} y={64} className="a-person-friend" />
      <Envelope x={70} y={112} className="a-env-src" />
      <Envelope x={70} y={112} scale={0.72} className="a-env-keep" />
      <Envelope x={70} y={112} scale={0.72} className="a-env-go" />
      <Eye x={100} y={160} delay={0} />
      <Eye x={160} y={160} delay={0.15} />
      <Eye x={220} y={160} delay={0.3} />
    </svg>
  );
}

/* ---------- step 3: Unshield ---------- */
function UnshieldAnim() {
  return (
    <svg viewBox={VB} className="anim anim-unshield">
      <Defs />
      <Wallet x={230} y={112} tag="NEW" />
      <g fontFamily="Geist Mono, ui-monospace, monospace" fontSize="13" textAnchor="middle" fill="#ecebf5" fontWeight="500">
        <text className="a-wbal a-wbal-0" x="230" y="70">0</text>
        <text className="a-wbal a-wbal-3" x="230" y="70">3.00</text>
      </g>
      <Envelope x={80} y={100} open className="a-env-open" />
      <Coin x={80} y={100} r={9} className="a-pour a-pour-1" />
      <Coin x={80} y={100} r={9} className="a-pour a-pour-2" />
      <Coin x={80} y={100} r={9} className="a-pour a-pour-3" />
      <g className="a-gas">
        <rect x="112" y="150" width="96" height="20" rx="10" fill="rgba(89,214,154,0.14)" stroke="rgba(89,214,154,0.45)" strokeWidth="1" />
        <text x="160" y="160.5" textAnchor="middle" dominantBaseline="middle" fontSize="10.5" fontWeight="500" fill="#59d69a" fontFamily="Geist, system-ui, sans-serif">gas paid ✓</text>
      </g>
    </svg>
  );
}

/* ---------- step 4: Any token ---------- */
function AnyTokenAnim() {
  const coins = ['◎', '$', 'J', 'B', 'Ξ', '★'];
  return (
    <svg viewBox={VB} className="anim anim-any">
      <Defs />
      <Pool rx={110} />
      {coins.map((c, i) => (
        <Coin key={c} x={60 + i * 40} y={40} r={12} label={c} className={`a-drop a-drop-${i}`} />
      ))}
    </svg>
  );
}
