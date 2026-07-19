/**
 * F-4 — /api/forms-advanced/:id データコックピット backend (real SQLite)。
 *   T-D1: rows 検索/フィルタ/ソート/ページング + Formaloo rows API ドリルスルー (dev=mirror fail-soft) + 保存フィルタ CRUD
 *   landmine#4: forms_advanced 権限なし custom role は rows/filters に 403 (specific-route gate)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { jstNow, createRole, setRolePermissions } from '@line-crm/db';
import { parseCsv } from '@line-crm/shared';
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
let bindingOverrides: Partial<Env['Bindings']> = {};

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    ...bindingOverrides,
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
  bindingOverrides = {};
});

afterEach(() => vi.unstubAllGlobals());

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

// ── T-D2 統計 / CSV 出し入れ / 一括削除 ──
/** forms_advanced 権限 "あり" だが owner でない custom role staff を作る (owner gate の検証用)。 */
async function seedFormsAdvancedStaff(apiKey: string) {
  const roleId = (await createRole(DB, { name: 'フォーム担当' })).id;
  await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: true }]);
  seedStaff(`u_${apiKey}`, 'staff', apiKey, roleId);
}

describe('T-D2 統計', () => {
  test('GET stats → total + 日次集計 + verified 件数', async () => {
    seedForm('fa1');
    seedSub('s1', 'fa1', { name: '田中' }, '2026-07-01T10:00:00+09:00');
    seedSub('s2', 'fa1', { name: '鈴木' }, '2026-07-01T12:00:00+09:00');
    seedSub('s3', 'fa1', { name: '佐藤' }, '2026-07-02T09:00:00+09:00');
    raw.prepare(`UPDATE formaloo_submissions SET verified=1 WHERE id IN ('s1','s2')`).run();
    const d = (await (await call('GET', '/api/forms-advanced/fa1/stats')).json() as { data: { total: number; verified: number; daily: Array<{ day: string; count: number }> } }).data;
    expect(d.total).toBe(3);
    expect(d.verified).toBe(2);
    expect(d.daily).toEqual([{ day: '2026-07-01', count: 2 }, { day: '2026-07-02', count: 1 }]);
  });
});

describe('T-D2 CSV export/import round-trip (owner gated / N-9)', () => {
  beforeEach(() => {
    seedForm('fa1');
    seedSub('s1', 'fa1', { name: '田中', tel: '090' }, '2026-07-01T10:00:00+09:00', 'fr_1');
    seedSub('s2', 'fa1', { name: '鈴木' }, '2026-07-05T10:00:00+09:00', 'fr_2');
  });

  test('owner は export.csv を取得でき、parse で回答が戻る (round-trip)', async () => {
    const res = await call('GET', '/api/forms-advanced/fa1/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    const rows = parseCsv(csv);
    // header + 2 データ行
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual(expect.arrayContaining(['回答ID', 'friend_id', '送信日時', 'name', 'tel']));
    // 全 answer key が列に出る (union)
    const nameCol = rows[0].indexOf('name');
    const dataById = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect(dataById.get('s1')![nameCol]).toBe('田中');
  });

  test('owner でない forms_advanced staff は export.csv に 403 (owner gated / N-9)', async () => {
    await seedFormsAdvancedStaff('fa-staff-key');
    expect((await call('GET', '/api/forms-advanced/fa1/export.csv', undefined, 'Bearer fa-staff-key')).status).toBe(403);
  });

  test('import: owner は CSV を検証し件数を返す (dev=Formaloo 未配備で pushed=false fail-soft)', async () => {
    const csv = (await (await call('GET', '/api/forms-advanced/fa1/export.csv')).text());
    const res = await call('POST', '/api/forms-advanced/fa1/import', { csv });
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { parsed: number; pushed: boolean } }).data;
    expect(d.parsed).toBe(2);
    expect(d.pushed).toBe(false);
  });

  test('import: owner でない forms_advanced staff は 403', async () => {
    await seedFormsAdvancedStaff('fa-staff-key');
    expect((await call('POST', '/api/forms-advanced/fa1/import', { csv: '回答ID\r\n' }, 'Bearer fa-staff-key')).status).toBe(403);
  });
});

describe('T-D2 一括削除 (owner gated)', () => {
  beforeEach(() => {
    seedForm('fa1');
    seedSub('s1', 'fa1', { name: '田中' }, '2026-07-01T10:00:00+09:00');
    seedSub('s2', 'fa1', { name: '鈴木' }, '2026-07-05T10:00:00+09:00');
  });

  test('owner は選択削除でき件数を返す', async () => {
    const res = await call('POST', '/api/forms-advanced/fa1/rows/bulk-delete', { ids: ['s1'] });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { deleted: number } }).data.deleted).toBe(1);
    expect((await (await call('GET', '/api/forms-advanced/fa1/rows')).json() as { data: { total: number } }).data.total).toBe(1);
  });

  test('Formaloo row slug を解決し slugs_list で削除後、GET 404 を確認してから mirror を削除する', async () => {
    bindingOverrides = { FORMALOO_API_KEY: 'bulk-key', FORMALOO_API_SECRET: 'bulk-secret' };
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) as unknown : init?.body ?? null;
      requests.push({ method, url, body });
      if (url.endsWith('/v1.0/oauth2/authorization-token/')) {
        return new Response(JSON.stringify({ authorization_token: 'bulk-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v3.0/forms/slug_fa1/rows/?')) {
        return new Response(JSON.stringify({ data: { rows: [{ submit_code: 's1', slug: 'remote-row-1' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/v3.0/forms/slug_fa1/rows/bulk-delete/')) {
        return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/v3.0/rows/remote-row-1/')) {
        return new Response(JSON.stringify({ detail: 'Not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected Formaloo request: ${method} ${url}`);
    }));

    const res = await call('POST', '/api/forms-advanced/fa1/rows/bulk-delete', { ids: ['s1'] });

    expect(res.status).toBe(200);
    const bulk = requests.find((r) => r.url.endsWith('/rows/bulk-delete/'));
    expect(bulk?.body).toEqual({ slugs_list: ['remote-row-1'] });
    expect(requests.some((r) => r.method === 'GET' && r.url.endsWith('/v3.0/rows/remote-row-1/'))).toBe(true);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM formaloo_submissions WHERE id = ?').get('s1')).toEqual({ n: 0 });
  });

  test('bulk-delete が 200 でも row が残る場合は fail-closed で mirror を保持する', async () => {
    bindingOverrides = { FORMALOO_API_KEY: 'bulk-stale-key', FORMALOO_API_SECRET: 'bulk-stale-secret' };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1.0/oauth2/authorization-token/')) {
        return new Response(JSON.stringify({ authorization_token: 'bulk-stale-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v3.0/forms/slug_fa1/rows/?')) {
        return new Response(JSON.stringify({ data: { rows: [{ submit_code: 's1', slug: 'remote-row-stale' }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/v3.0/forms/slug_fa1/rows/bulk-delete/')) {
        return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/v3.0/rows/remote-row-stale/')) {
        return new Response(JSON.stringify({ data: { row: { slug: 'remote-row-stale' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected Formaloo request: ${url}`);
    }));

    const res = await call('POST', '/api/forms-advanced/fa1/rows/bulk-delete', { ids: ['s1'] });

    expect(res.status).toBe(502);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM formaloo_submissions WHERE id = ?').get('s1')).toEqual({ n: 1 });
  });

  test('owner でない forms_advanced staff は 403 (機微 mutating)', async () => {
    await seedFormsAdvancedStaff('fa-staff-key');
    expect((await call('POST', '/api/forms-advanced/fa1/rows/bulk-delete', { ids: ['s1'] }, 'Bearer fa-staff-key')).status).toBe(403);
  });

  test('forms_advanced 権限なしは 403 (middleware gate)', async () => {
    const roleId = (await createRole(DB, { name: 'ゲスト2' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('guest2', 'staff', 'guest2-key', roleId);
    expect((await call('POST', '/api/forms-advanced/fa1/rows/bulk-delete', { ids: ['s1'] }, 'Bearer guest2-key')).status).toBe(403);
  });
});
