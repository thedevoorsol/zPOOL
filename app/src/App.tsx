import { useEffect, useMemo, useRef, useState } from 'react';
import { createSignableMessage, getBase58Decoder, getTransactionDecoder, type Transaction } from '@solana/kit';
import { useWalletAccountMessageSigner, useWalletAccountTransactionSendingSigner } from '@solana/react';
import { useDisconnect, useWallets, type UiWallet, type UiWalletAccount } from '@wallet-standard/react';
import { config } from './lib/config';
import type { Session } from './lib/session';
import { short } from './lib/amounts';
import { Background } from './components/Background';
import { Card } from './components/Card';
import { WalletModal } from './components/WalletModal';
import { Chevron } from './components/Icons';
import { HowItWorks } from './components/HowItWorks';

const SEEN_INTRO = 'zpool.seenIntro';

function seenIntro(): boolean {
  try { return localStorage.getItem(SEEN_INTRO) === '1'; } catch { return true; }
}
function markIntroSeen() {
  try { localStorage.setItem(SEEN_INTRO, '1'); } catch { /* storage blocked: show it again next time */ }
}

export function App() {
  const wallets = useWallets();
  const [account, setAccount] = useState<UiWalletAccount | null>(null);
  const [wallet, setWallet] = useState<UiWallet | null>(null);
  const [demo, setDemo] = useState(false);
  const [pick, setPick] = useState(false);
  // 'intro' = auto-shown on the very first visit (Skip button); 'manual' = opened from the header.
  const [how, setHow] = useState<'intro' | 'manual' | null>(() => (seenIntro() ? null : 'intro'));

  function closeHow() {
    markIntroSeen();
    setHow(null);
  }
  function startFromHow() {
    closeHow();
    // Land the visitor straight on the card: the amount input, or the card's main button while
    // no wallet is connected (the input is disabled until then).
    requestAnimationFrame(() => {
      const amount = document.querySelector<HTMLInputElement>('#amount');
      if (amount && !amount.disabled) amount.focus();
      else document.querySelector<HTMLButtonElement>('.card .primary')?.focus();
    });
  }

  const demoSession = useMemo<Session | null>(() => (demo ? makeDemoSession(() => setDemo(false)) : null), [demo]);

  return (
    <>
      <Background />
      <div className="shell">
        <header className="top">
          <a className="brand" href="/" aria-label="zPOOL">
            <span className="brand-z">z</span>POOL
          </a>
          <div className="top-right">
          <button className="how-link" onClick={() => setHow('manual')}>How it works</button>
          {account && wallet ? (
            <WalletSession account={account} wallet={wallet} onDisconnected={() => { setAccount(null); setWallet(null); }}>
              {(session) => <Connected session={session} />}
            </WalletSession>
          ) : demoSession ? (
            <Connected session={demoSession} />
          ) : (
            <button className="wallet-btn" onClick={() => setPick(true)}>Connect wallet</button>
          )}
          </div>
        </header>

        <main className="stage">
          {account && wallet ? (
            <WalletSession account={account} wallet={wallet} onDisconnected={() => { setAccount(null); setWallet(null); }}>
              {(session) => <Card key={session.address} session={session} onConnect={() => setPick(true)} />}
            </WalletSession>
          ) : (
            <Card key={demoSession?.address ?? 'none'} session={demoSession} onConnect={() => setPick(true)} />
          )}
        </main>

        <footer className="foot">
          <span><span className="brand-z">z</span>POOL · shielded pool for any Solana token</span>
          <span className="dim">{config.chain.replace('solana:', '')}{config.mock ? ' · mock' : ''}</span>
        </footer>
      </div>

      {how && (
        <HowItWorks firstVisit={how === 'intro'} onClose={closeHow} onStart={startFromHow} />
      )}
      {pick && (
        <WalletModal
          wallets={wallets}
          onConnected={(w, a) => { setDemo(false); setWallet(w); setAccount(a); }}
          onDemo={config.mock ? () => { setAccount(null); setWallet(null); setDemo(true); } : undefined}
          onClose={() => setPick(false)}
        />
      )}
    </>
  );
}

/** Binds a wallet-standard account to signer callbacks the pool client understands. */
function WalletSession({ account, wallet, onDisconnected, children }: {
  account: UiWalletAccount;
  wallet: UiWallet;
  onDisconnected: () => void;
  children: (s: Session) => JSX.Element;
}) {
  const txSigner = useWalletAccountTransactionSendingSigner(account, config.chain);
  const msgSigner = useWalletAccountMessageSigner(account);
  const [, disconnect] = useDisconnect(wallet);
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;

  const session = useMemo<Session>(() => ({
    address: account.address,
    walletName: wallet.name,
    walletIcon: wallet.icon,
    async signMessage(bytes) {
      const [signed] = await msgSigner.modifyAndSignMessages([createSignableMessage(bytes)]);
      const sig = signed.signatures[msgSigner.address];
      if (!sig) throw new Error('Wallet returned no signature');
      return new Uint8Array(sig);
    },
    async signAndSend(txBytes) {
      const tx = getTransactionDecoder().decode(txBytes) as Transaction;
      const [sig] = await txSigner.signAndSendTransactions([tx]);
      return getBase58Decoder().decode(sig);
    },
    async disconnect() {
      try { await disconnectRef.current(); } finally { onDisconnected(); }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [account.address, wallet.name, wallet.icon, msgSigner, txSigner]);

  return children(session);
}

/** Top-right pill for the connected wallet, with a disconnect menu. */
function Connected({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="wallet-menu" ref={ref}>
      <button className="wallet-btn on" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {session.walletIcon ? <img src={session.walletIcon} alt="" width={16} height={16} /> : <span className="brand-dot small" />}
        <span className="mono">{short(session.address)}</span>
        <Chevron width={14} height={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(session.address); setOpen(false); }}>Copy address</button>
          <button role="menuitem" onClick={() => { setOpen(false); void session.disconnect(); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

/** Mock-mode only: a wallet that signs instantly, so the whole flow can be clicked through. */
function makeDemoSession(onDisconnect: () => void): Session {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    address: 'DemozPoo1Wa11et111111111111111111111111111',
    walletName: 'Demo wallet',
    async signMessage() { await sleep(500); return crypto.getRandomValues(new Uint8Array(64)); },
    async signAndSend() { await sleep(500); return 'demo'; },
    async disconnect() { onDisconnect(); },
  };
}
