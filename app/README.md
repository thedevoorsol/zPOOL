# zPOOL (front end)

Shielded pool UI for any Solana token: **Shield** (deposit into a private balance), **Send** (private payment to a shielded `sp…` address), **Unshield** (withdraw to any wallet, relayer pays gas).

The landing screen is the card itself (usable at once, nothing to scroll). A **How it works** link in the header opens a four-step animated explainer; it also opens automatically on a visitor's very first visit (localStorage flag `zpool.seenIntro`, wrapped in try/catch) and never again after that.

## Run

```sh
npm install
VITE_MOCK=1 npm run dev     # fully clickable demo against an in-browser mock pool, http://localhost:5174
npm run build               # typecheck + production build into dist/
```

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `VITE_CHAIN` | `solana:mainnet` | Chain the wallet is asked to sign for (`solana:devnet` adds `?cluster=devnet` to explorer links). |
| `VITE_MOCK` | unset | `1` uses the mock pool client and adds a **Demo wallet** entry to the connect modal (signs instantly, no extension needed). |

Copy `.env.example` to `.env` to set them.

## Where the client lives

- `src/lib/pool-types.ts`: the `PoolClient` interface and `PoolClientFactory`. The UI is wired against this only.
- `src/lib/client.ts`: `createPoolClient` returns the mock when `VITE_MOCK=1`, otherwise throws `real client not wired yet`. Replace that branch with the real implementation.
- `src/lib/mockClient.ts`: in-memory implementation with realistic delays. Demo hooks: an amount of exactly `13` whole tokens makes the relayer reject the action (error state); pasting an unknown 32-44 char base58 mint resolves to an unlisted, not-yet-enabled token (enable flow).

The wallet layer (`src/App.tsx`, `WalletSession`) turns a wallet-standard account into the two callbacks the factory needs: `signMessage(bytes)` and `signAndSend(txBytes)` (wire-encoded transaction in, base58 signature out).

## Layout

```
src/
  App.tsx                 top bar, wallet session, card
  main.tsx, styles.css
  components/
    Background.tsx        animated encrypted field (canvas 2D, 4 parallax layers, decrypt sweep ~20 s, reduced-motion fallback)
    HowItWorks.tsx        four-step explainer overlay (inline SVG + CSS keyframes, no images)
    Card.tsx              Shield / Send / Unshield card, stepper, errors
    TokenSelect.tsx       token search modal (symbol, name, or pasted mint)
    ReceiveModal.tsx      shielded address + QR
    WalletModal.tsx       wallet-standard wallet picker (+ demo wallet in mock mode)
    Modal.tsx, TokenLogo.tsx, Icons.tsx
  lib/
    pool-types.ts         the contract
    client.ts             factory switch (mock / real)
    mockClient.ts
    amounts.ts            bigint formatting / strict parsing
    config.ts             env, explorer links
    session.ts
screenshots/              zpool-* captured with headless Chromium (mock mode) at 1280x800 and 390x844; real-* against the real client
```
