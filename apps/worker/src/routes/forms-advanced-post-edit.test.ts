/**
 * form-media-limits (Batch C / T-C3・T-C4) — PUT/GET forms-advanced の allowPostEdit 配線。
 *   ③ 編集禁止トグル。harness 側保存のみ・Formaloo push には渡さない (soft-200 theater を送らない)。
 *   T-C3 PUT allowPostEdit=1→保存 + GET meta が allowPostEdit===1 (0/1 正規化) / 未指定は不変
 *   T-C4 allow_post_edit は Formaloo push (form/field payload) に混ざらない
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
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
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'postedit-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'postedit-formaloo-key', FORMALOO_API_SECRET: 'postedit-formaloo-secret',
  } as Env['Bindings'];
}

function app() {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  hono.route('/', formsAdvanced);
  return hono;
}

function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer postedit-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'フォーム', NULL, '{"fields":[],"logic":[]}', ?)`,
  ).run(id, slug);
}

function postEditRow(id: string): number | undefined {
  const r = raw.prepare('SELECT allow_post_edit AS v FROM formaloo_forms WHERE id=?').get(id) as { v: number } | undefined;
  return r?.v;
}

function branchEditRow(id: string): number | undefined {
  const r = raw.prepare('SELECT allow_branch_edit AS v FROM formaloo_forms WHERE id=?').get(id) as { v: number } | undefined;
  return r?.v;
}

interface ApiCall { method: string; url: string; body: unknown }

function stubFormaloo(): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    }
    if (method === 'POST' && /\/fields\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { field: { slug: 'FLD' } } }), { status: 201 });
    }
    return new Response(JSON.stringify({ data: { form: body ?? {}, field: {} } }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => vi.unstubAllGlobals());

describe('PUT/GET /api/forms-advanced/:id — allowPostEdit 配線 (T-C3)', () => {
  test('PUT allowPostEdit=1 を保存し GET meta が allowPostEdit===1 を返す', async () => {
    seedForm('pe1', 'PE_FORM');
    stubFormaloo();

    const put = await call('PUT', '/api/forms-advanced/pe1', { fields: [], logic: [], allowPostEdit: 1 });
    expect(put.status).toBe(200);
    expect(postEditRow('pe1')).toBe(1);

    const get = await call('GET', '/api/forms-advanced/pe1');
    const meta = (await get.json()) as { data: { allowPostEdit?: number } };
    expect(meta.data.allowPostEdit).toBe(1);
  });

  test('allowPostEdit は 0/1 に正規化 (truthy→1 / 0→0)', async () => {
    seedForm('pe2', 'PE_FORM2');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/pe2', { fields: [], logic: [], allowPostEdit: true });
    expect(postEditRow('pe2')).toBe(1);
    await call('PUT', '/api/forms-advanced/pe2', { fields: [], logic: [], allowPostEdit: 0 });
    expect(postEditRow('pe2')).toBe(0);
  });

  test('allowPostEdit 未指定 PUT は当該フォームの allow_post_edit を変えない', async () => {
    seedForm('pe3', 'PE_FORM3');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/pe3', { fields: [], logic: [], allowPostEdit: 1 });
    expect(postEditRow('pe3')).toBe(1);
    // allowPostEdit を含まない PUT (title のみ) は 1 を保持
    await call('PUT', '/api/forms-advanced/pe3', { fields: [], logic: [], title: '改題' });
    expect(postEditRow('pe3')).toBe(1);
  });
});

describe('PUT /api/forms-advanced/:id — allow_post_edit は Formaloo push に混ざらない (T-C4)', () => {
  test('保存時の Formaloo API 呼出 body に allow_post_edit / allowPostEdit / editable 系が含まれない', async () => {
    seedForm('pe4', 'PE_FORM4');
    const calls = stubFormaloo();

    await call('PUT', '/api/forms-advanced/pe4', {
      fields: [{ id: 'q1', type: 'file', label: '添付', required: false, position: 0, config: {} }],
      logic: [],
      allowPostEdit: 1,
    });

    const forbidden = /allow_post_edit|allowPostEdit|editable_responses|is_answer_editable|allow_edit_response/;
    for (const c of calls) {
      const serialized = JSON.stringify(c.body ?? {});
      expect(serialized).not.toMatch(forbidden);
    }
    // allow_post_edit は D1 には保存されている (harness 側のみ = soft-200 theater を送らない証跡)
    expect(postEditRow('pe4')).toBe(1);
  });
});

describe('PUT/GET /api/forms-advanced/:id — allowBranchEdit 配線 (D-1)', () => {
  test('既定 0 を返し、PUT は 0|1 に正規化して保存する', async () => {
    seedForm('be1', 'BE_FORM1');
    stubFormaloo();

    const initial = await call('GET', '/api/forms-advanced/be1');
    expect(((await initial.json()) as { data: { allowBranchEdit?: number } }).data.allowBranchEdit).toBe(0);

    const put = await call('PUT', '/api/forms-advanced/be1', { fields: [], logic: [], allowBranchEdit: true });
    expect(put.status).toBe(200);
    expect(branchEditRow('be1')).toBe(1);
    const get = await call('GET', '/api/forms-advanced/be1');
    expect(((await get.json()) as { data: { allowBranchEdit?: number } }).data.allowBranchEdit).toBe(1);

    await call('PUT', '/api/forms-advanced/be1', { fields: [], logic: [], allowBranchEdit: 0 });
    expect(branchEditRow('be1')).toBe(0);
  });

  test('allowBranchEdit 未指定 PUT は値を保持し、Formaloo payload へ混ぜない', async () => {
    seedForm('be2', 'BE_FORM2');
    const calls = stubFormaloo();
    await call('PUT', '/api/forms-advanced/be2', { fields: [], logic: [], allowBranchEdit: 1 });
    await call('PUT', '/api/forms-advanced/be2', { fields: [], logic: [], title: '改題' });
    expect(branchEditRow('be2')).toBe(1);
    for (const entry of calls) {
      expect(JSON.stringify(entry.body ?? {})).not.toMatch(/allow_branch_edit|allowBranchEdit/);
    }
  });
});
