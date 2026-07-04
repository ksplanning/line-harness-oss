/**
 * T-C6 / A4 (F2 batch4 G2) — /send entry pre-check が上限超過を即時 429 で拒否し実送信を叩かないこと、
 * cap=null では止めないこと (誤爆ゼロ) を実 SQLite + mock LINE client で検証。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const sends: string[] = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public t: string) {}
    async multicast() { sends.push('multicast'); return {}; }
    async broadcast() { sends.push('broadcast'); return { requestId: 'r' }; }
    async pushMessage() { sends.push('push'); return {}; }
  },
}));

const { broadcasts } = await import('./broadcasts.js');

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
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) { const o = []; for (const st of stmts) o.push(await st.run()); return o; },
  } as unknown as D1Database;
}

function seed(raw: Database.Database, cap: number | null) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, monthly_cap) VALUES ('acc-1','ch','a','tok','sec',?)`).run(cap);
  for (const [id, u] of [['f1', 'u1'], ['f2', 'u2'], ['f3', 'u3']]) {
    raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, is_following) VALUES (?,?,?,1)`).run(id, u, 'acc-1');
  }
  raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id, total_count, success_count) VALUES ('b1','T','text','hi','all','draft','acc-1',0,0)`).run();
}

function app(raw: Database.Database) {
  const a = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string; LINE_CHANNEL_ACCESS_TOKEN: string } }>();
  a.use('*', async (c, next) => { c.env = { DB: d1(raw), WORKER_URL: 'https://w', LINE_CHANNEL_ACCESS_TOKEN: 'tok' } as never; await next(); });
  a.route('/', broadcasts);
  return a;
}

beforeEach(() => { sends.length = 0; });

describe('/send entry pre-check', () => {
  test('cap exceeded → 429 capBlocked, no send fired', async () => {
    const raw = new Database(':memory:');
    replayAll(raw);
    seed(raw, 1); // cap=1, 3 followers → 0+3 > 1 → block
    const res = await app(raw).request('/api/broadcasts/b1/send', { method: 'POST' });
    expect(res.status).toBe(429);
    const body = await res.json() as { capBlocked: boolean; cap: { count: number; cap: number } };
    expect(body.capBlocked).toBe(true);
    expect(sends.length).toBe(0); // 実送信ゼロ
  });

  test('cap=null → not blocked (proceeds, 誤爆ゼロ)', async () => {
    const raw = new Database(':memory:');
    replayAll(raw);
    seed(raw, null);
    const res = await app(raw).request('/api/broadcasts/b1/send', { method: 'POST' });
    expect(res.status).not.toBe(429); // 上限で止めない
  });
});
