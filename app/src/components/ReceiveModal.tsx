import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PoolClient } from '../lib/pool-types';
import { Modal } from './Modal';
import { Check, Copy, Lock, Spinner } from './Icons';

export function ReceiveModal({ client, unlocked, unlocking, onUnlock, onConnect, onClose }: {
  client: PoolClient | null;
  unlocked: boolean;
  unlocking: boolean;
  onUnlock: () => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  const address = client && unlocked ? client.shieldedAddress() : null;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!address || !canvas.current) return;
    QRCode.toCanvas(canvas.current, address, {
      margin: 1,
      width: 208,
      errorCorrectionLevel: 'M',
      color: { dark: '#ecebff', light: '#00000000' },
    }).catch(() => undefined);
  }, [address]);

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked */ }
  }

  return (
    <Modal title="Receive privately" onClose={onClose} width={380}>
      {address ? (
        <div className="receive">
          <div className="qr-wrap"><canvas ref={canvas} width={208} height={208} /></div>
          <p className="muted small">Share this address with whoever wants to pay you. Payments to it are hidden: no sender, receiver or amount on chain.</p>
          <div className="addr-box mono" onClick={copy} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && copy()}>{address}</div>
          <button className="primary ghost" onClick={copy}>{copied ? <><Check /> Copied</> : <><Copy /> Copy address</>}</button>
        </div>
      ) : (
        <div className="receive locked">
          <div className="lock-big"><Lock width={28} height={28} /></div>
          <p className="muted small">{client ? 'Sign one message in your wallet to get your shielded address. Nothing is stored.' : 'Connect a wallet to get your shielded address.'}</p>
          {client ? (
            <button className="primary" disabled={unlocking} onClick={onUnlock}>{unlocking ? <Spinner /> : <Lock />} {unlocking ? 'Check your wallet…' : 'Unlock'}</button>
          ) : (
            <button className="primary" onClick={() => { onClose(); onConnect(); }}>Connect wallet</button>
          )}
        </div>
      )}
    </Modal>
  );
}
