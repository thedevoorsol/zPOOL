/** SQLite (Node built-in) store for pools, leaves, and indexer cursor. */
import { DatabaseSync } from 'node:sqlite';

export type PoolRow = {
  mint: string;
  token_program: string;
  decimals: number;
  symbol: string;
  name: string;
  logo_uri: string | null;
  tree: string;
  vault: string;
  alt: string | null;
  fee_ata: string | null;
  min_fee: string;
};
export type LeafRow = { mint: string; idx: number; commitment: string; encrypted: string; signature: string; slot: number };

export class Db {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pools (mint TEXT PRIMARY KEY, token_program TEXT, decimals INTEGER, symbol TEXT, name TEXT, logo_uri TEXT, tree TEXT, vault TEXT, alt TEXT, fee_ata TEXT, min_fee TEXT DEFAULT '0');
      CREATE TABLE IF NOT EXISTS leaves (mint TEXT, idx INTEGER, commitment TEXT, encrypted TEXT, signature TEXT, slot INTEGER, PRIMARY KEY (mint, idx));
      CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), last_signature TEXT, last_slot INTEGER);
      CREATE TABLE IF NOT EXISTS seen (signature TEXT PRIMARY KEY);
    `);
  }
  pools(): PoolRow[] {
    return this.db.prepare('SELECT * FROM pools ORDER BY rowid').all() as PoolRow[];
  }
  pool(mint: string): PoolRow | null {
    return (this.db.prepare('SELECT * FROM pools WHERE mint = ?').get(mint) as PoolRow | undefined) ?? null;
  }
  upsertPool(p: PoolRow): void {
    this.db
      .prepare(
        `INSERT INTO pools (mint, token_program, decimals, symbol, name, logo_uri, tree, vault, alt, fee_ata, min_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET token_program=excluded.token_program, decimals=excluded.decimals, symbol=excluded.symbol, name=excluded.name, logo_uri=excluded.logo_uri, tree=excluded.tree, vault=excluded.vault, alt=COALESCE(excluded.alt, pools.alt), fee_ata=COALESCE(excluded.fee_ata, pools.fee_ata), min_fee=excluded.min_fee`,
      )
      .run(p.mint, p.token_program, p.decimals, p.symbol, p.name, p.logo_uri, p.tree, p.vault, p.alt, p.fee_ata, p.min_fee);
  }
  setPoolAlt(mint: string, alt: string, feeAta: string): void {
    this.db.prepare('UPDATE pools SET alt = ?, fee_ata = ? WHERE mint = ?').run(alt, feeAta, mint);
  }
  leaves(mint: string, start = 0, limit = 5000): LeafRow[] {
    return this.db.prepare('SELECT * FROM leaves WHERE mint = ? AND idx >= ? ORDER BY idx LIMIT ?').all(mint, start, limit) as LeafRow[];
  }
  allCommitments(mint: string): string[] {
    return (this.db.prepare('SELECT commitment FROM leaves WHERE mint = ? ORDER BY idx').all(mint) as { commitment: string }[]).map((r) => r.commitment);
  }
  leafCount(mint: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM leaves WHERE mint = ?').get(mint) as { n: number }).n;
  }
  insertLeaf(l: LeafRow): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO leaves (mint, idx, commitment, encrypted, signature, slot) VALUES (?,?,?,?,?,?)').run(l.mint, l.idx, l.commitment, l.encrypted, l.signature, l.slot);
    return Number(r.changes) > 0;
  }
  cursor(): { last_signature: string | null; last_slot: number } {
    return (this.db.prepare('SELECT last_signature, last_slot FROM cursor WHERE id = 1').get() as { last_signature: string | null; last_slot: number } | undefined) ?? { last_signature: null, last_slot: 0 };
  }
  setCursor(sig: string, slot: number): void {
    this.db.prepare('INSERT INTO cursor (id, last_signature, last_slot) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET last_signature = excluded.last_signature, last_slot = excluded.last_slot').run(sig, slot);
  }
  seen(sig: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM seen WHERE signature = ?').get(sig);
  }
  markSeen(sig: string): void {
    this.db.prepare('INSERT OR IGNORE INTO seen (signature) VALUES (?)').run(sig);
  }
}
