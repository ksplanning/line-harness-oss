/**
 * fold-in fix (F2 batch4 G1 / browser-evaluator CRITICAL) — POST/PUT /api/broadcasts が
 * abTestId/abVariant を **永続化** し、保存後 GET で返ることを実 SQLite で証明 (silent-drop 再発防止)。
 * cross-account ab_test 拒否 / 不正 variant / test 無しの孤児 variant を 400 で弾く。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/line-sdk', () => ({ LineClient: class { constructor(public t: string) {} } }));

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

let raw: Database.Database;
function app() {
  const a = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
  a.use('*', async (c, next) => { c.env = { DB: d1(raw), WORKER_URL: 'https://w' } as never; await next(); });
  a.route('/', broadcasts);
  return a;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  for (const acc of ['acc-1', 'acc-2']) {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run(acc, `ch-${acc}`, acc, 't', 's');
  }
  raw.prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES ('ab-1','acc-1','春A/B','open_rate')`).run();
});

const base = { title: 'A案', messageType: 'text', messageContent: 'hi', targetType: 'all', lineAccountId: 'acc-1' };

describe('POST /api/broadcasts A/B binding persistence (silent-drop regression)', () => {
  test('abTestId/abVariant persist and are returned by a subsequent GET', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, abTestId: 'ab-1', abVariant: 'A' }) });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; abTestId: string | null; abVariant: string | null } };
    expect(body.data.abTestId).toBe('ab-1');
    expect(body.data.abVariant).toBe('A');
    // 保存後 GET でも返る (DB に永続 = silent-drop していない)。
    const got = await app().request(`/api/broadcasts/${body.data.id}`);
    const gotBody = await got.json() as { data: { abTestId: string | null; abVariant: string | null } };
    expect(gotBody.data.abTestId).toBe('ab-1');
    expect(gotBody.data.abVariant).toBe('A');
    // DB 直も確認。
    const row = raw.prepare(`SELECT ab_test_id, ab_variant FROM broadcasts WHERE id=?`).get(body.data.id) as { ab_test_id: string; ab_variant: string };
    expect(row.ab_test_id).toBe('ab-1');
    expect(row.ab_variant).toBe('A');
  });

  test('cross-account ab_test → 400 (別 account の test に紐付けられない)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, lineAccountId: 'acc-2', abTestId: 'ab-1', abVariant: 'A' }) });
    expect(res.status).toBe(400);
  });

  test('invalid variant → 400', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, abTestId: 'ab-1', abVariant: 'C' }) });
    expect(res.status).toBe(400);
  });

  test('variant without abTestId → 400 (孤児 variant 禁止)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, abVariant: 'A' }) });
    expect(res.status).toBe(400);
  });

  test('abTestId without variant → 400 (どの案か不明)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, abTestId: 'ab-1' }) });
    expect(res.status).toBe(400);
  });

  test('no A/B binding still works (backward compatible)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify(base) });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { abTestId: string | null } };
    expect(body.data.abTestId).toBeNull();
  });
});

describe('PUT /api/broadcasts/:id A/B binding', () => {
  test('attaches abTestId/abVariant to an existing draft and GET returns them', async () => {
    const created = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify(base) });
    const id = (await created.json() as { data: { id: string } }).data.id;
    const put = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ abTestId: 'ab-1', abVariant: 'B' }) });
    expect(put.status).toBe(200);
    const got = await app().request(`/api/broadcasts/${id}`);
    const gotBody = await got.json() as { data: { abTestId: string | null; abVariant: string | null } };
    expect(gotBody.data.abTestId).toBe('ab-1');
    expect(gotBody.data.abVariant).toBe('B');
  });

  test('PUT cross-account ab_test → 400', async () => {
    // acc-2 の broadcast を作り、acc-1 の ab_test に紐付けようとする。
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id, total_count, success_count) VALUES ('b2','T','text','hi','all','draft','acc-2',0,0)`).run();
    const put = await app().request('/api/broadcasts/b2', { method: 'PUT', body: JSON.stringify({ abTestId: 'ab-1', abVariant: 'A' }) });
    expect(put.status).toBe(400);
  });
});
