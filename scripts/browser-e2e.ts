/**
 * Drives the REAL app (no mocks) in headless Chromium with a wallet-standard mock wallet against the local stack.
 *   APP_URL=http://127.0.0.1:5174 RPC_URL=http://127.0.0.1:8899 RELAYER_URL=http://127.0.0.1:8787 USER_KEYPAIR=... MINT=... npx tsx scripts/browser-e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { ShieldPool } from '../sdk/src/pool';
import { SOL_MINT } from '../sdk/src/utxo';

// Playwright is not a workspace dependency; point PLAYWRIGHT_DIR at any install (e.g. a temp `npm i playwright`).
const { chromium } = await import(`${process.env.PLAYWRIGHT_DIR ?? '../node_modules/playwright'}/index.mjs`);
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5174';
const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const RELAYER_URL = process.env.RELAYER_URL ?? 'http://127.0.0.1:8787';
const MINT = process.env.MINT!;
const CHAIN = process.env.CHAIN ?? 'solana:localnet';
const SHIELD_SOL = process.env.SHIELD_SOL ?? '1';
const SEND_SOL = process.env.SEND_SOL ?? '0.3';
const UNSHIELD_SOL = process.env.UNSHIELD_SOL ?? '0.5';
const SPL_AMOUNT = process.env.SPL_AMOUNT ?? '100';
const SHOT_PREFIX = process.env.SHOT_PREFIX ?? 'real';
const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.USER_KEYPAIR!, 'utf8'))));
const seedHex = Buffer.from(user.secretKey.slice(0, 32)).toString('hex');
const shots = path.resolve('app/screenshots');
const connection = new Connection(RPC_URL, 'confirmed');
const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// a second user who will receive the private payment (node-side, via the SDK)
const bob = Keypair.generate();
const B = await ShieldPool.init({ connection, relayerUrl: RELAYER_URL, artifacts: { wasm: path.resolve('circuits/transaction2.wasm'), zkey: path.resolve('circuits/transaction2.zkey') } });
await B.unlock(bob.publicKey, async (m) => nacl.sign.detached(m, bob.secretKey));
const bobAddr = B.shieldedAddress();
const fresh = Keypair.generate();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(`window.__MOCK_SEED__='${seedHex}';window.__MOCK_RPC__='${RPC_URL}';window.__MOCK_CHAIN__='${CHAIN}';`);
await page.addInitScript(fs.readFileSync(new URL('./mockWallet.js', import.meta.url), 'utf8'));

const primary = () => page.locator('button.primary').first();
async function waitPrimary(label: string, timeout = 120_000) { await page.locator('button.primary', { hasText: label }).first().waitFor({ timeout }); }
async function runAndFinish(clickLabel: string, timeout = 240_000) {
  await page.locator('button.primary', { hasText: clickLabel }).first().click();
  await page.locator('button', { hasText: 'Done' }).first().waitFor({ timeout });
  const cardText = await page.locator('section.card').innerText();
  await page.locator('button', { hasText: 'Done' }).first().click();
  return cardText;
}
async function shot(name: string) { await page.screenshot({ path: path.join(shots, `${SHOT_PREFIX}-${name}.png`) }); }
async function cardText() { return (await page.locator('section.card').innerText()).replace(/\s+/g, ' '); }

await page.goto(APP_URL);
step('page loaded');
const skip = page.locator('button', { hasText: /^(Skip|Start)$/ }).first();
if (await skip.isVisible({ timeout: 3000 }).catch(() => false)) { await skip.click(); step('intro dismissed'); }
await page.locator('button', { hasText: 'Connect wallet' }).first().click();
await page.locator('button', { hasText: 'Mock Wallet' }).first().click();
await waitPrimary('Unlock');
step('wallet connected');
await shot('01-connected');
await primary().click();
await waitPrimary('Enter an amount');
step('unlocked: ' + (await cardText()).slice(0, 120));
await shot('02-unlocked');

// --- SOL: shield 1
await page.locator('input[placeholder="0"]').fill(SHIELD_SOL);
const t1 = await runAndFinish('Shield');
step('shield SOL done | ' + t1.replace(/\s+/g, ' ').slice(0, 160));
await shot('03-sol-shielded');
await page.waitForTimeout(1500);
step('card: ' + await cardText());

// --- SOL: send 0.3 privately to bob
await page.getByRole('tab', { name: 'Send', exact: true }).click();
await page.locator('input[placeholder="0"]').fill(SEND_SOL);
await page.locator('input[placeholder="sp…"]').fill(bobAddr);
const t2 = await runAndFinish('Send');
step('private send done | ' + t2.replace(/\s+/g, ' ').slice(0, 120));
await B.sync(SOL_MINT);
step(`bob shielded SOL (node-side sync) = ${Number(B.balance(SOL_MINT)) / LAMPORTS_PER_SOL}`);
if (B.balance(SOL_MINT) !== BigInt(Math.round(Number(SEND_SOL) * LAMPORTS_PER_SOL))) throw new Error('bob did not receive the private payment');
await shot('04-sent');

// --- SOL: unshield 0.5 to a fresh wallet
await page.getByRole('tab', { name: 'Unshield', exact: true }).click();
await page.locator('input[placeholder="0"]').fill(UNSHIELD_SOL);
await page.locator('input[placeholder="Any Solana address"]').fill(fresh.publicKey.toBase58());
const t3 = await runAndFinish('Unshield');
step('unshield done | ' + t3.replace(/\s+/g, ' ').slice(0, 120));
const freshBal = await connection.getBalance(fresh.publicKey);
step(`fresh wallet SOL = ${freshBal / LAMPORTS_PER_SOL}`);
if (freshBal !== Math.round(Number(UNSHIELD_SOL) * LAMPORTS_PER_SOL)) throw new Error('fresh wallet did not get the unshielded SOL');
await shot('05-unshielded');

// --- SPL: pick the new token by pasting its mint, enable the pool, shield 100
await page.getByRole('tab', { name: 'Shield', exact: true }).click();
await page.locator('button.token-btn').click();
await page.locator('input[placeholder*="paste a mint"]').fill(MINT);
const row = page.locator('button.token-row', { hasText: MINT.slice(0, 4) });
await row.first().waitFor({ timeout: 30_000 });
await row.first().click();
await page.waitForTimeout(1500);
const label = (await primary().innerText()).trim();
if (label.startsWith('Enable')) {
  step('token selected, pool not enabled yet');
  await shot('06-enable');
  const t4 = await runAndFinish('Enable');
  step('pool enabled | ' + t4.replace(/\s+/g, ' ').slice(0, 100));
  await waitPrimary('Enter an amount');
} else {
  step('token selected, pool already enabled (' + label + ')');
}
// shielded balance before (shown on the Send tab)
await page.getByRole('tab', { name: 'Send', exact: true }).click();
await page.waitForTimeout(800);
const beforeMatch = (await cardText()).match(/Shielded: ([\d,.\u2013-]+)/);
const before = beforeMatch && /\d/.test(beforeMatch[1]) ? Number(beforeMatch[1].replace(/,/g, '')) : 0;
await page.getByRole('tab', { name: 'Shield', exact: true }).click();
await page.locator('input[placeholder="0"]').fill(SPL_AMOUNT);
const t5 = await runAndFinish('Shield');
step('shield SPL done | ' + t5.replace(/\s+/g, ' ').slice(0, 100));
await page.waitForTimeout(1500);
await page.getByRole('tab', { name: 'Send', exact: true }).click(); // the shielded balance is shown on Send/Unshield
await page.waitForTimeout(800);
const finalText = await cardText();
step('card: ' + finalText);
await shot('07-spl-shielded');
const receive = page.locator('button[aria-label="Receive"]');
await receive.click();
await page.waitForTimeout(500);
await shot('08-receive');
const modalText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const afterMatch = finalText.match(/Shielded: ([\d,.]+)/);
const after = afterMatch ? Number(afterMatch[1].replace(/,/g, '')) : NaN;
step(`SPL shielded before=${before} after=${after}`);
// the pool credits amount minus the on-chain deposit fee
const feesNow = await (await fetch(RELAYER_URL + '/config')).json() as { depositFeeBps: number };
const credited = Number(SPL_AMOUNT) * (1 - feesNow.depositFeeBps / 10000);
const ok = modalText.includes('sp') && Math.abs(after - (before + credited)) < 1e-6 && !errors.length;
console.log('--- console errors:', errors.length ? errors.join('\n') : 'none');
console.log(ok ? 'BROWSER E2E OK' : 'BROWSER E2E MISMATCH: ' + finalText);
await browser.close();
process.exit(ok ? 0 : 1);
