/**
 * T-C3 (F2 batch4 G17) — migration 058 が rich_menu_groups.schedule_start/schedule_end を additive で足す検証。
 *   - 058 適用後 schedule_start/schedule_end 列が生え、既定 NULL (スケジュールなし)
 *   - 既存 rich_menu_groups 列 (status/publishing_at 等) は不変
 *   - ISO8601 JST 文字列を保存・読み出しできる
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
  raw.prepare(`INSERT INTO rich_menu_groups (id, account_id, name, chat_bar_text, size) VALUES ('g1','acc-1','春','メニュー','large')`).run();
});

describe('migration 058 — rich_menu_groups.schedule_start/schedule_end (additive)', () => {
  test('schedule columns exist and default to NULL', () => {
    const cols = (raw.prepare(`PRAGMA table_info(rich_menu_groups)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('schedule_start');
    expect(cols).toContain('schedule_end');
    const row = raw.prepare(`SELECT schedule_start, schedule_end FROM rich_menu_groups WHERE id='g1'`).get() as { schedule_start: string | null; schedule_end: string | null };
    expect(row.schedule_start).toBeNull();
    expect(row.schedule_end).toBeNull();
  });

  test('existing rich_menu_groups columns unchanged', () => {
    const cols = (raw.prepare(`PRAGMA table_info(rich_menu_groups)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'account_id', 'name', 'status', 'publishing_at', 'default_page_id']) {
      expect(cols).toContain(c);
    }
  });

  test('ISO8601 JST schedule window can be stored and read back', () => {
    raw.prepare(`UPDATE rich_menu_groups SET schedule_start=?, schedule_end=? WHERE id='g1'`).run('2026-07-10T00:00:00+09:00', '2026-07-20T23:59:59+09:00');
    const row = raw.prepare(`SELECT schedule_start, schedule_end FROM rich_menu_groups WHERE id='g1'`).get() as { schedule_start: string; schedule_end: string };
    expect(row.schedule_start).toBe('2026-07-10T00:00:00+09:00');
    expect(row.schedule_end).toBe('2026-07-20T23:59:59+09:00');
  });
});
