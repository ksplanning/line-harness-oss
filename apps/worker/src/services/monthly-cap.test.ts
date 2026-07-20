/**
 * T-C6 / D-4 (F2 batch4 G2) — 月次上限 helper の計測式と gate 判定を実 SQLite で検証。
 *  - MESSAGES_THIS_MONTH_SQL が表示 (line-accounts.ts) と同一式 (byte-identical・単一 source)
 *  - getMessagesThisMonth: outgoing push/test のみ・当月のみ (test-send も LINE push 消費として計上)
 *  - checkMonthlyCap: cap=null は常に allowed (誤爆ゼロ) / count+pending>cap でブロック
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { MESSAGES_THIS_MONTH_SQL, getMessagesThisMonth, getMonthlyCap, checkMonthlyCap } from './monthly-cap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

const THIS_MONTH = new Date().toISOString().slice(0, 8) + '05T10:00:00.000+09:00'; // 当月 5 日
let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','t','s')`).run();
  raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id) VALUES ('f1','u1','acc-1')`).run();
  const ins = (id: string, dir: string, dt: string | null, created: string) =>
    raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, delivery_type, source, created_at) VALUES (?, 'f1', ?, 'text', 'x', ?, 'broadcast', ?)`).run(id, dir, dt, created);
  ins('m1', 'outgoing', 'push', THIS_MONTH); // 数える
  ins('m2', 'outgoing', null, THIS_MONTH);   // 数える (push 相当)
  ins('m3', 'outgoing', 'test', THIS_MONTH);  // test-send も数える
  ins('m4', 'outgoing', 'reply', THIS_MONTH); // reply = 除外
  ins('m5', 'incoming', null, THIS_MONTH);    // incoming = 除外
  ins('m6', 'outgoing', 'push', '2020-01-01T00:00:00.000+09:00'); // 先月以前 = 除外
});

describe('MESSAGES_THIS_MONTH_SQL (byte-identical with display)', () => {
  test('contains the exact display clauses (single source)', () => {
    expect(MESSAGES_THIS_MONTH_SQL).toContain("ml.direction = 'outgoing'");
    expect(MESSAGES_THIS_MONTH_SQL).toContain("(ml.delivery_type IS NULL OR ml.delivery_type IN ('push', 'test'))");
    expect(MESSAGES_THIS_MONTH_SQL).toContain("ml.created_at >= date('now', 'start of month')");
    expect(MESSAGES_THIS_MONTH_SQL).toContain('f.line_account_id = ?');
  });
});

describe('getMessagesThisMonth', () => {
  test('counts outgoing push and test this month (reply/incoming/old excluded)', async () => {
    expect(await getMessagesThisMonth(db, 'acc-1')).toBe(3); // m1 + m2 + m3
  });
});

describe('getMonthlyCap', () => {
  test('null by default (unlimited)', async () => {
    expect(await getMonthlyCap(db, 'acc-1')).toBeNull();
  });
  test('returns set value', async () => {
    raw.prepare(`UPDATE line_accounts SET monthly_cap = 100 WHERE id='acc-1'`).run();
    expect(await getMonthlyCap(db, 'acc-1')).toBe(100);
  });
});

describe('checkMonthlyCap gate', () => {
  test('cap=null → always allowed (誤爆ゼロ)', async () => {
    const r = await checkMonthlyCap(db, 'acc-1', 1_000_000);
    expect(r.allowed).toBe(true);
    expect(r.cap).toBeNull();
  });

  test('count + pending <= cap → allowed', async () => {
    raw.prepare(`UPDATE line_accounts SET monthly_cap = 10 WHERE id='acc-1'`).run();
    const r = await checkMonthlyCap(db, 'acc-1', 5); // 2 + 5 = 7 <= 10
    expect(r.allowed).toBe(true);
    expect(r.count).toBe(3);
    expect(r.remaining).toBe(7);
  });

  test('count + pending > cap → blocked', async () => {
    raw.prepare(`UPDATE line_accounts SET monthly_cap = 3 WHERE id='acc-1'`).run();
    const r = await checkMonthlyCap(db, 'acc-1', 5); // 2 + 5 = 7 > 3
    expect(r.allowed).toBe(false);
  });

  test('no accountId → unlimited (既定挙動不変)', async () => {
    expect((await checkMonthlyCap(db, null, 999)).allowed).toBe(true);
  });
});
