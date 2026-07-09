/**
 * T-E1 (F-5) — migration 083 が formaloo_forms に Google Sheets 連携状態列を additive で足す検証 (任意)。
 *   gsheet_connected : 0=未連携 | 1=連携済 (regenerate-gsheet-data トリガ済)。既定 0。
 *   gsheet_url       : 連携先 Sheet URL (表示用 / NULL=未連携)。
 * additive のみ (ADD COLUMN NOT NULL DEFAULT / nullable)。既存 formaloo_forms 行の挙動不変 (D-1)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('migration 083 — formaloo_forms Google Sheets 連携状態 (additive / T-E1)', () => {
  test('gsheet_connected / gsheet_url 列が生える', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_forms)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('gsheet_connected');
    expect(cols).toContain('gsheet_url');
  });

  test('新規 formaloo_forms は既定 gsheet_connected=0 / gsheet_url=NULL', () => {
    raw.prepare(`INSERT INTO formaloo_forms (id, title) VALUES ('fa1','x')`).run();
    const row = raw.prepare(`SELECT gsheet_connected, gsheet_url FROM formaloo_forms WHERE id='fa1'`).get() as { gsheet_connected: number; gsheet_url: string | null };
    expect(row.gsheet_connected).toBe(0);
    expect(row.gsheet_url).toBeNull();
  });

  test('既存 080/079 列は不変 (builder_status/published_at/definition_json)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_forms)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['builder_status', 'published_at', 'definition_json', 'submit_count']) expect(cols).toContain(c);
  });
});
