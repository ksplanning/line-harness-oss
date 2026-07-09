/**
 * F-4 — /api/forms-advanced/:id データコックピット backend (real SQLite)。
 *   T-D1: rows 検索/フィルタ/ソート/ページング + Formaloo rows API ドリルスルー (dev=mirror fail-soft) + 保存フィルタ CRUD
 *   landmine#4: forms_advanced 権限なし custom role は rows/filters に 403 (specific-route gate)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { jstNow, createRole, setRolePermissions } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formsAdvanced);
  return a;
}

const OWNER = 'Bearer env-owner-key';
function call(method: string, path: string, body?: unknown, auth = OWNER) {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}
function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  ).run(id, id, null, role, apiKey, now, now, roleId);
}
function seedForm(id: string) {
  raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status) VALUES (?,?,?,?)`).run(id, `slug_${id}`, 'テスト', 'published');
}
function seedSub(id: string, formId: string, answers: Record<string, unknown>, submittedAt: string, friendId: string | null = null) {
  raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, friend_id, answers_json, submitted_at) VALUES (?,?,?,?,?)`)
    .run(id, formId, friendId, JSON.stringify(answers), submittedAt);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('T-D1 rows 検索/ページング', () => {
  beforeEach(() => {
    seedForm('fa1');
    seedSub('s1', 'fa1', { name: '田中' }, '2026-07-01T10:00:00+09:00', 'fr_1');
    seedSub('s2', 'fa1', { name: '鈴木' }, '2026-07-05T10:00:00+09:00', 'fr_2');
    seedSub('s3', 'fa1', { name: '田中太郎' }, '2026-07-09T10:00:00+09:00', 'fr_3');
  });

  test('GET rows → desc + total + answers parse', async () => {
    const res = await call('GET', '/api/forms-advanced/fa1/rows');
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { rows: Array<{ id: string; answers: { name: string } }>; total: number; page: number } }).data;
    expect(d.total).toBe(3);
    expect(d.rows.map((r) => r.id)).toEqual(['s3', 's2', 's1']);
    expect(d.rows[0].answers.name).toBe('田中太郎');
  });

  test('q フィルタ', async () => {
    const d = (await (await call('GET', '/api/forms-advanced/fa1/rows?q=田中')).json() as { data: { total: number } }).data;
    expect(d.total).toBe(2);
  });

  test('期間 + sort asc + paging', async () => {
    const d = (await (await call('GET', '/api/forms-advanced/fa1/rows?sort=asc&pageSize=2&page=1')).json() as { data: { rows: Array<{ id: string }>; total: number } }).data;
    expect(d.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(d.total).toBe(3);
    const p2 = (await (await call('GET', '/api/forms-advanced/fa1/rows?sort=asc&pageSize=2&page=2')).json() as { data: { rows: Array<{ id: string }> } }).data;
    expect(p2.rows.map((r) => r.id)).toEqual(['s3']);
  });

  test('unknown form → 404', async () => {
    expect((await call('GET', '/api/forms-advanced/nope/rows')).status).toBe(404);
  });
});

describe('T-D1 rows ドリルスルー (dev fail-soft = mirror)', () => {
  test('GET rows/:rowId → dev (client なし) は mirror 回答を返す', async () => {
    seedForm('fa1');
    seedSub('s1', 'fa1', { name: '田中', tel: '090' }, '2026-07-01T10:00:00+09:00');
    const res = await call('GET', '/api/forms-advanced/fa1/rows/s1');
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { id: string; answers: { name: string }; source: string } }).data;
    expect(d.id).toBe('s1');
    expect(d.answers.name).toBe('田中');
    expect(d.source).toBe('mirror');
  });

  test('存在しない row → 404', async () => {
    seedForm('fa1');
    expect((await call('GET', '/api/forms-advanced/fa1/rows/ghost')).status).toBe(404);
  });
});

describe('T-D1 保存フィルタ CRUD', () => {
  test('POST → GET → DELETE', async () => {
    seedForm('fa1');
    const created = await call('POST', '/api/forms-advanced/fa1/filters', { name: '未対応のみ', filter: { q: '田中', sort: 'asc' } });
    expect(created.status).toBe(201);
    const cid = (await created.json() as { data: { id: string; name: string; filter: { q: string } } }).data;
    expect(cid.name).toBe('未対応のみ');
    expect(cid.filter.q).toBe('田中');

    const list = (await (await call('GET', '/api/forms-advanced/fa1/filters')).json() as { data: Array<{ id: string }> }).data;
    expect(list.length).toBe(1);

    expect((await call('DELETE', `/api/forms-advanced/fa1/filters/${cid.id}`)).status).toBe(200);
    expect(((await (await call('GET', '/api/forms-advanced/fa1/filters')).json() as { data: unknown[] }).data).length).toBe(0);
  });

  test('name 空は 400', async () => {
    seedForm('fa1');
    expect((await call('POST', '/api/forms-advanced/fa1/filters', { name: '  ', filter: {} })).status).toBe(400);
  });
});

describe('landmine#4 権限 gate', () => {
  test('forms_advanced 権限なし custom role は rows に 403', async () => {
    seedForm('fa1');
    const roleId = (await createRole(DB, { name: 'ゲスト' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('guest', 'staff', 'guest-key', roleId);
    const res = await call('GET', '/api/forms-advanced/fa1/rows', undefined, 'Bearer guest-key');
    expect(res.status).toBe(403);
  });
});
