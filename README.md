<p align="center"><b>zPOOL</b></p>
<p align="center">A shielded pool for any Solana token.<br/>Hold and pay privately. Withdraw anywhere. No whitelist, no auditor key.</p>
<p align="center"><a href="https://www.zpool.fun">www.zpool.fun</a></p>

---

## What it is

zPOOL is one vault per token on Solana. Coins that go in stop being balances and become **notes**: sealed
commitments that only their owner can read or spend. Inside the pool, balances, senders, receivers and amounts are
hidden. Coins can leave to any wallet, including a brand-new empty one, with a relayer paying the gas so the
withdrawing wallet never has to sign.

It works for every SPL and Token-2022 mint. If a coin has no pool yet, anyone opens one with a single transaction.

| | |
|---|---|
| Program (mainnet) | `7Bts9gjMRYG577hbipnAZMuEiBWnGy4SwkqN8TjRpuVF` |
| Verified build hash | `435fb7ad7b31f1b7d3981dbfc8924247259bcfc8d2cf1f3510b4ca163992f444` |
| App | https://www.zpool.fun |
| Design | Tornado Nova style joinsplit, Groth16 on BN254, Poseidon Merkle tree of height 26 |
| Lineage | Fork of [Privacy Cash](https://github.com/Privacy-Cash/privacy-cash), circuits and trusted setup unchanged |

## How it works

**Keys.** Sign one fixed message with your wallet. From that signature the app derives a spending key (whose Poseidon
hash is your note public key) and an x25519 key for receiving encrypted notes. Nothing is stored; the keys are
re-derived every session. Your **shielded address** is `sp` + base58 of both public keys.

**Shield.** You deposit `amount` into the pool's vault. The transaction carries a zero-knowledge proof that two new
notes were created correctly and appends their commitments, `Poseidon(amount, pubkey, blinding, mint)`, to the
pool's Merkle tree. Each note also carries a small ciphertext, encrypted to your x25519 key, holding the amount and
blinding. On chain the note is a random-looking 32-byte value with no link to your wallet.

**Reading a balance.** Your client trial-decrypts every note ciphertext in the pool. The ones that open are yours. It
then checks the note's nullifier on chain to learn whether it is still unspent. Your balance is the sum of your
unspent notes.

**Spending.** Every spend is a proof of three facts: a note with this amount exists in the tree, you hold its
secret, and the value in equals the value out. The proof reveals none of the inputs. It also publishes a
**nullifier**, `Poseidon(commitment, index, Poseidon(secret, commitment, index))`, which the program records as a
tiny account so the note can never be spent twice. A nullifier cannot be linked back to its note.

**Pay privately.** A spend whose outputs are one note encrypted to the recipient's shielded address and one change
note to yourself. The relayer submits it. The chain sees two new commitments and two nullifiers.

**Unshield.** A spend where part of the value leaves the vault to a wallet. The relayer submits it, pre-creates the
recipient's token account, and pays gas, so the recipient wallet needs nothing and is never a signer.

**What stays public.** The amounts entering and leaving each vault and the wallets at those two doors, which token
a transaction touches, and timing. Everything between the doors is hidden. Privacy at the doors grows with the
number of people using a pool.

## Fees

Set on chain in the program's global config and readable at the relayer's `/config`:

- shield: 0.5% of the amount, deducted from the deposit
- unshield: 0.5% of the amount (+0.002 SOL on SOL pools, which covers the relayer's rent for nullifier accounts)
- private payment: 0.3%

The fee recipient is enforced by the program, not by the relayer, so it cannot be bypassed by self-relaying.

## Repository

```
program/   Anchor program `shieldpool` (Rust). target/idl/shieldpool.json is the IDL clients use.
circuits/  transaction2.{wasm,zkey}, verifyingkey2.json, circom sources, ceremony record (unchanged upstream)
sdk/       TypeScript client: keys, notes, Merkle tree, prover (snarkjs, browser + node), program bindings
relayer/   indexer + relayer service (Node 24, SQLite built in), pays gas for withdrawals and private payments
app/       the web app (Vite + React + wallet-standard)
scripts/   e2e.ts (keypair round trip), browser-e2e.ts (headless Chromium through the real UI), admin helpers
```

### Changes from Privacy Cash

| Area | Privacy Cash | zPOOL |
|---|---|---|
| Opening a pool | admin-only allowlist | permissionless `create_pool` for any mint |
| Token programs | legacy SPL | SPL and Token-2022 via the token interface: `transfer_checked`, transfer-fee aware, transfer hooks, non-transferable mints refused |
| In-pool payments | not exposed | first-class, with a relayer fee (`public_amount = -fee`) |
| Fee recipient | any account | must equal `global_config.fee_recipient` |
| Deposit fee | none | supported via `deposit_fee_rate` |
| Root history | 100 | 250 |
| Note encryption | owner-only AES from a wallet signature | x25519 + HKDF + AES-GCM to a shielded address, so anyone can pay you |
| Relayer transactions | v0 + lookup table | transaction v1 (4,096 bytes); v0 fallback |

## Run it locally

```
npm install
solana-test-validator --reset --limit-ledger-size 100000000 \
  --url https://api.mainnet-beta.solana.com --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g --deactivate-feature TestFeature11111111111111111111111111111111
cd program && anchor build && solana program deploy target/deploy/shieldpool.so --program-id <keypair> --url http://127.0.0.1:8899
RPC_URL=http://127.0.0.1:8899 RELAYER_KEYPAIR=<relayer.json> DB_PATH=./relayer.sqlite CHAIN=solana:localnet npm run relayer
RPC_URL=http://127.0.0.1:8899 RELAYER_URL=http://127.0.0.1:8787 KEYS_DIR=<dir with deployer.json + relayer.json> npm run e2e
cd app && cp .env.example .env.local && npm run dev
```

`npm run e2e` opens pools for a legacy SPL mint, a Token-2022 mint with a 1% transfer fee and native SOL, then
deposits, pays privately to a second user, and withdraws to a never-funded wallet for each.

## Verify the on-chain program

The deployed program is the deterministic build of `program/` made with
[`solana-verify`](https://github.com/Ellipsis-Labs/solana-verifiable-build) (base image
`solanafoundation/solana-verifiable-build:2.2.20`). Reproduce and compare:

```
cd program && solana-verify build --library-name shieldpool --base-image solanafoundation/solana-verifiable-build:2.2.20
solana-verify get-executable-hash target/deploy/shieldpool.so
solana-verify get-program-hash -um 7Bts9gjMRYG577hbipnAZMuEiBWnGy4SwkqN8TjRpuVF
```

Both print `435fb7ad7b31f1b7d3981dbfc8924247259bcfc8d2cf1f3510b4ca163992f444`. Remote verification against this
repository:

```
solana-verify verify-from-repo -um --program-id 7Bts9gjMRYG577hbipnAZMuEiBWnGy4SwkqN8TjRpuVF \
  https://github.com/thedevoorsol/zpool --library-name shieldpool --mount-path program
```

## Security

The program's custody paths differ from the audited upstream (token interface, fee handling, permissionless
pools) and have not yet been independently reviewed. Until then, SOL deposits are capped per transaction and the
upgrade authority remains with the maintainers. The circuits, proving key and verifying key are the audited
Privacy Cash artifacts. Do not deposit more than you can afford to lose.

## License

Business Source License 1.1, inherited from Privacy Cash. See `LICENSE.md` and `LICENSE-privacy-cash.md`.
