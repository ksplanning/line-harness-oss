/**
 * form-edit-mail-link (弾L / T-C1) — PUT/GET forms-advanced の allowEditMail 配線 (弾S allowPostEdit 同型)。
 *   PUT allowEditMail=1 → 保存 + GET meta が allowEditMail===1 (0/1 正規化) / 未指定は不変 (present-key) /
 *   allow_edit_mail は Formaloo push (form/field payload) に混ざらない (harness 側 D1 保存のみ)。
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
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((p) => p.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'em-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'em-fk', FORMALOO_API_SECRET: 'em-fs',
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
    headers: { Authorization: 'Bearer em-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'フォーム', NULL, '{"fields":[],"logic":[]}', ?)`,
  ).run(id, slug);
}
function editMailRow(id: string): number | undefined {
  const r = raw.prepare('SELECT allow_edit_mail AS v FROM formaloo_forms WHERE id=?').get(id) as { v: number } | undefined;
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
    if (url.includes('/oauth2/authorization-token/')) return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    if (method === 'POST' && /\/fields\/$/.test(url)) return new Response(JSON.stringify({ data: { field: { slug: 'FLD' } } }), { status: 201 });
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

describe('PUT/GET /api/forms-advanced/:id — allowEditMail 配線 (T-C1)', () => {
  test('PUT allowEditMail=1 を保存し GET meta が allowEditMail===1 を返す', async () => {
    seedForm('em1', 'EM_FORM');
    stubFormaloo();
    const put = await call('PUT', '/api/forms-advanced/em1', { fields: [], logic: [], allowEditMail: 1 });
    expect(put.status).toBe(200);
    expect(editMailRow('em1')).toBe(1);
    const get = await call('GET', '/api/forms-advanced/em1');
    const meta = (await get.json()) as { data: { allowEditMail?: number } };
    expect(meta.data.allowEditMail).toBe(1);
  });

  test('allowEditMail は 0/1 に正規化 (truthy→1 / 0→0)', async () => {
    seedForm('em2', 'EM_FORM2');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/em2', { fields: [], logic: [], allowEditMail: true });
    expect(editMailRow('em2')).toBe(1);
    await call('PUT', '/api/forms-advanced/em2', { fields: [], logic: [], allowEditMail: 0 });
    expect(editMailRow('em2')).toBe(0);
  });

  test('allowEditMail 未指定 PUT は当該フォームの allow_edit_mail を変えない (present-key)', async () => {
    seedForm('em3', 'EM_FORM3');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/em3', { fields: [], logic: [], allowEditMail: 1 });
    expect(editMailRow('em3')).toBe(1);
    await call('PUT', '/api/forms-advanced/em3', { fields: [], logic: [], title: '改題' });
    expect(editMailRow('em3')).toBe(1);
  });

  test('未設定フォームの GET は allowEditMail=0 (既定 byte 同等)', async () => {
    seedForm('em4', 'EM_FORM4');
    const get = await call('GET', '/api/forms-advanced/em4');
    const meta = (await get.json()) as { data: { allowEditMail?: number } };
    expect(meta.data.allowEditMail).toBe(0);
  });
});

describe('PUT /api/forms-advanced/:id — allow_edit_mail は Formaloo push に混ざらない (T-C1)', () => {
  test('保存時の Formaloo API 呼出 body に allow_edit_mail / allowEditMail 系が含まれない', async () => {
    seedForm('em5', 'EM_FORM5');
    const calls = stubFormaloo();
    await call('PUT', '/api/forms-advanced/em5', {
      fields: [{ id: 'q1', type: 'email', label: 'メール', required: false, position: 0, config: {} }],
      logic: [],
      allowEditMail: 1,
    });
    const forbidden = /allow_edit_mail|allowEditMail/;
    for (const c of calls) {
      expect(JSON.stringify(c.body ?? {})).not.toMatch(forbidden);
    }
    expect(editMailRow('em5')).toBe(1);
  });
});
