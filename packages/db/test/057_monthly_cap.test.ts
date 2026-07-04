/**
 * T-C2 (F2 batch4 G2) — migration 057 が line_accounts.monthly_cap を additive で足すことの検証。
 *   - 057 適用後 monthly_cap 列が生え、既定 NULL (無制限 = 既定挙動不変)
 *   - 既存 line_accounts 列は不変
 *   - 正整数を保存・読み出しできる (CHECK なし = application 検証に委譲)
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
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run('acc-1', 'ch-1', 'acc-1', 'tok', 'sec');
});

describe('migration 057 — line_accounts.monthly_cap (additive)', () => {
  test('monthly_cap column exists and defaults to NULL (unlimited)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(line_accounts)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('monthly_cap');
    const row = raw.prepare(`SELECT monthly_cap FROM line_accounts WHERE id='acc-1'`).get() as { monthly_cap: number | null };
    expect(row.monthly_cap).toBeNull();
  });

  test('existing line_accounts columns unchanged', () => {
    const cols = (raw.prepare(`PRAGMA table_info(line_accounts)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'channel_id', 'name', 'channel_access_token', 'is_active', 'display_order']) {
      expect(cols).toContain(c);
    }
  });

  test('positive integer cap can be stored and read back', () => {
    raw.prepare(`UPDATE line_accounts SET monthly_cap = 1000 WHERE id='acc-1'`).run();
    const row = raw.prepare(`SELECT monthly_cap FROM line_accounts WHERE id='acc-1'`).get() as { monthly_cap: number };
    expect(row.monthly_cap).toBe(1000);
  });
});
