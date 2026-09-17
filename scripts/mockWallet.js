// Wallet-standard mock backed by an ed25519 seed; signs messages and v0/legacy transactions, sends via fetch.
(async () => {
  const seed = Uint8Array.from(window.__MOCK_SEED__.match(/../g).map((h) => parseInt(h, 16)));
  const rpcUrl = window.__MOCK_RPC__; const chain = window.__MOCK_CHAIN__;
  const pkcs8Prefix = Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  const pkcs8 = new Uint8Array(48); pkcs8.set(pkcs8Prefix); pkcs8.set(seed, 16);
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pubBytes = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (b) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x === 0) s = '1' + s; else break; } return s; };
  const b58d = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } for (const c of s) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); };
  const address = b58(pubBytes);
  const sign = async (m) => new Uint8Array(await crypto.subtle.sign('Ed25519', priv, m));
  const account = { address, publicKey: pubBytes, chains: [chain], features: ['solana:signMessage', 'solana:signAndSendTransaction', 'solana:signTransaction'], label: 'mock' };
  const cu16 = (b, o) => { let v = 0, sh = 0, i = o; for (;;) { const x = b[i++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; } return [v, i]; };
  async function signTx(tx) { const [n, start] = cu16(tx, 0); const msg = tx.subarray(start + n * 64); const sig = await sign(msg); const out = new Uint8Array(tx); out.set(sig, start); return out; }
  async function send(tx) { const b64 = btoa(String.fromCharCode(...tx)); const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', preflightCommitment: 'confirmed' }] }) }); const j = await r.json(); if (j.error) throw new Error('mock wallet send failed: ' + JSON.stringify(j.error)); return j.result; }
  const listeners = {};
  const wallet = { version: '1.0.0', name: 'Mock Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', chains: [chain], accounts: [], features: {
    'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; (listeners.change || []).forEach((cb) => cb({ accounts: wallet.accounts })); return { accounts: [account] }; } },
    'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
    'standard:events': { version: '1.0.0', on: (e, cb) => { (listeners[e] ||= []).push(cb); return () => {}; } },
    'solana:signMessage': { version: '1.0.0', signMessage: async (...ins) => Promise.all(ins.map(async ({ message }) => ({ signedMessage: message, signature: await sign(message) }))) },
    'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async (...ins) => Promise.all(ins.map(async ({ transaction }) => ({ signedTransaction: await signTx(transaction) }))) },
    'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async (...ins) => Promise.all(ins.map(async ({ transaction }) => ({ signature: b58d(await send(await signTx(transaction))) }))) },
  } };
  const register = ({ register }) => register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  window.__MOCK_ADDRESS__ = address;
})();
