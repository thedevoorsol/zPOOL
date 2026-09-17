import { useConnect, type UiWallet, type UiWalletAccount } from '@wallet-standard/react';
import { config } from '../lib/config';
import { Modal } from './Modal';
import { Wallet } from './Icons';

export function WalletModal({ wallets, onConnected, onDemo, onClose }: {
  wallets: readonly UiWallet[];
  onConnected: (wallet: UiWallet, account: UiWalletAccount) => void;
  onDemo?: () => void;
  onClose: () => void;
}) {
  const solana = wallets.filter((w) => w.chains.some((c) => c === config.chain || c.startsWith('solana:')));
  return (
    <Modal title="Connect a wallet to zPOOL" onClose={onClose} width={360}>
      <div className="wallet-list">
        {solana.map((w) => (
          <WalletRow key={w.name} wallet={w} onConnected={(a) => { onConnected(w, a); onClose(); }} />
        ))}
        {solana.length === 0 && <div className="muted small center">No Solana wallet found. Install Phantom, Solflare or Backpack.</div>}
        {onDemo && (
          <button className="wallet-row demo" onClick={() => { onDemo(); onClose(); }}>
            <span className="wicon"><Wallet /></span>
            <span>Demo wallet <span className="tag">mock</span></span>
          </button>
        )}
      </div>
    </Modal>
  );
}

function WalletRow({ wallet, onConnected }: { wallet: UiWallet; onConnected: (a: UiWalletAccount) => void }) {
  const [connecting, connect] = useConnect(wallet);
  return (
    <button
      className="wallet-row"
      disabled={connecting}
      onClick={async () => {
        try {
          const accounts = await connect();
          if (accounts[0]) onConnected(accounts[0]);
        } catch { /* user rejected */ }
      }}
    >
      {wallet.icon ? <img className="wicon" src={wallet.icon} alt="" /> : <span className="wicon"><Wallet /></span>}
      <span>{wallet.name}</span>
      {connecting && <span className="muted small">connecting…</span>}
    </button>
  );
}
