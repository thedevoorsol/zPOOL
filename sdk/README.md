# zpool-sdk

Shielded pool for any Solana token. Shield coins into a private note, pay other shielded addresses with nothing on chain, unshield to any wallet with the relayer paying gas. Proofs are generated in the browser (in a Web Worker) or in Node.

```bash
npm install zpool-sdk
```

```ts
import { createZpool, SOL_MINT } from 'zpool-sdk';
import { PublicKey } from '@solana/web3.js';

const pool = await createZpool({
  rpcUrl: 'https://your-rpc',                                     // any Solana RPC
  partner: { address: new PublicKey('YourWallet…'), bps: 25 },    // optional: your fee on shields, 0.25%
});

// one wallet signature derives the user's shielded keys (nothing is stored)
await pool.unlock(wallet.publicKey, (msg) => wallet.signMessage(msg));
const address = pool.shieldedAddress();                            // sp… share it to receive

await pool.sync(SOL_MINT);
const balance = pool.balance(SOL_MINT);                            // bigint, raw units

// shield: the wallet signs; the amount is what leaves the wallet (token transfer fees come off first)
const { bytes } = await pool.buildDepositBytes(SOL_MINT, 100_000_000n, wallet.publicKey, undefined, { partner: pool.partner });
await wallet.signAndSendTransaction(bytes);

// private payment and unshield: built here, signed and paid for by the relayer
await pool.send(SOL_MINT, 50_000_000n, 'sp…recipient');
await pool.withdraw(SOL_MINT, 20_000_000n, new PublicKey('AnyWallet…'));
const { max } = await pool.spendable(SOL_MINT, 'withdraw');       // the most one action can move after the fee
```

## Fees

Protocol fees are enforced on chain: 0.5% on shield, 0.5% on unshield (with a small floor for gas), and a flat fee worth about 0.002 SOL on private sends, all paid in the token. A percentage on private sends would reveal the amount, so it is flat on purpose.

Your `partner` fee is charged on shields, the only step the user's wallet signs. It goes straight to your address (a wallet for SOL, your token account for other tokens; that token account must exist). Maximum 10%. It adds one instruction to the deposit and keeps it under the size wallets accept.

## Defaults and options

- `relayerUrl` defaults to the public relayer. Anyone can run their own from the repository.
- `artifacts` default to the circuit files hosted at zpool.fun (about 20 MB, cached). Host your own copy for full independence.
- Proving runs in a Web Worker when the bundler supports `new URL('./prover.worker.js', import.meta.url)` (Vite, webpack 5, Rollup). Otherwise it falls back to the main thread. `setUseWorker(false)` forces the main thread.
- In Node, call `await terminateProver()` before your script exits: snarkjs keeps worker threads alive after a proof.
- Deposits are built as v0 transactions with a lookup table, about 1.1 KB. Pass `{ version: 1 }` for wallets that advertise transaction v1.

## Privacy

Keys never leave the client. The SDK trial-decrypts every note in a pool locally. To avoid telling any server which notes are yours, set `pool.spentChecker` to a function that decides spent status from a public feed (the zPOOL app does this with `https://www.zpool.fun/api/events`); without it, spent status is asked from the relayer per note.

Docs: https://www.zpool.fun/docs · Source: https://github.com/thedevoorsol/zPOOL · License: BUSL-1.1
