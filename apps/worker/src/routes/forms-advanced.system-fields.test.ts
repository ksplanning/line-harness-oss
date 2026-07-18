/**
 * fr-id-capture-fix / T-C3 (route-level): PUT /api/forms-advanced/:id の publish 経路が friend system hidden
 *   field (fr_id/fr_name) を冪等 auto-push する。両テナント共通経路 (client は resolveFormalooClient で解決・
 *   本 test は env 単一鍵 = ks 相当。piecemaker は D1 KEK 経由だが push 経路コードは同一ゆえ本 test で機構を固定)。
 *   - env 既定 (flag 無) → POST /v3.0/fields/ で fr_id + fr_name を作成 → syncStatus idle。
 *   - FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE='1' → system field POST 一切なし (byte 同等 / rollback D-4)。
 *   - FORMALOO_FR_NAME_AUTOPUSH_DISABLE='1' → fr_id のみ (fr_name owner-gate / codex#8)。
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
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((p) => p.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e)) ) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(extra: Record<string, string> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'sf-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'sf-formaloo-key', FORMALOO_API_SECRET: 'sf-formaloo-secret',
    ...extra,
  } as Env['Bindings'];
}

function app() {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  hono.route('/', formsAdvanced);
  return hono;
}

function call(method: string, path: string, body: unknown, extraEnv: Record<string, string> = {}) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer sf-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(extraEnv));
}

function seedForm(id: string, slug: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', '{"fields":[],"logic":[]}', ?)`,
  ).run(id, slug);
}
function seedFieldSlug(formId: string, fieldId: string, slug: string, position: number) {
  const now = new Date().toISOString();
  raw.prepare(
    `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(fieldId, formId, slug, 'short_text', 'L', position, '{}', now, now);
}

interface ApiCall { method: string; url: string; body: unknown }

/** 実 Formaloo GET-after-POST を模倣: POST /v3.0/fields/ が state.fields_list に append し、後続 GET が反映する。 */
function stubFormaloo(opts: { withLogic?: boolean } = {}) {
  const calls: ApiCall[] = [];
  const fieldsList: { slug: string; alias?: string; type?: string; title?: string; position?: number }[] = [
    { slug: 's_one', type: 'short_text', title: '名前', position: 0 },
  ];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'sf-jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/fields\/$/.test(url)) {
      const b = (body ?? {}) as { alias?: string; type?: string; title?: string };
      fieldsList.push({ slug: `new_${b.alias}`, alias: b.alias, type: b.type ?? 'hidden', title: b.title, position: fieldsList.length });
      return new Response(JSON.stringify({ data: { field: { slug: `new_${b.alias}` } } }), { status: 201 });
    }
    if (method === 'PATCH' && /\/v3\.0\/fields\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      const form: Record<string, unknown> = { slug: 'FSLUG', fields_list: fieldsList.map((f) => ({ ...f })) };
      // T-C7: logic 有効フォームは Formaloo が hidden field 値を破棄する = fr_id 捕捉不能を surface する対象。
      if (opts.withLogic) form.logic = [{ conditions: [], actions: [{ type: 'submit_form' }] }];
      return new Response(JSON.stringify({ data: { form } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }));
  return { calls, fieldsList };
}

function sysFieldPosts(calls: ApiCall[]): string[] {
  return calls
    .filter((c) => c.method === 'POST' && /\/v3\.0\/fields\/$/.test(c.url))
    .map((c) => (c.body as { alias?: string }).alias ?? '')
    .filter((a) => a === 'fr_id' || a === 'fr_name');
}

async function putForm(id: string, extraEnv: Record<string, string> = {}) {
  return call('PUT', `/api/forms-advanced/${id}`, {
    fields: [{ id: `${id}_f1`, type: 'text', label: '名前', required: true, config: {} }],
    logic: [],
  }, extraEnv);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => { raw.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PUT /api/forms-advanced/:id — friend system field auto-push (T-C3 route-level)', () => {
  test('env 既定 (flag 無) → POST /v3.0/fields/ で fr_id + fr_name を作成 → syncStatus idle', async () => {
    const id = 'sfA';
    seedForm(id, 'FSLUG');
    seedFieldSlug(id, `${id}_f1`, 's_one', 0);
    const { calls } = stubFormaloo();
    const res = await putForm(id);
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { syncStatus: string } }).data.syncStatus).toBe('idle');
    expect(sysFieldPosts(calls).sort()).toEqual(['fr_id', 'fr_name']);
  });

  test('FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE=1 → system field POST 一切なし (byte 同等 / rollback D-4)', async () => {
    const id = 'sfB';
    seedForm(id, 'FSLUG');
    seedFieldSlug(id, `${id}_f1`, 's_one', 0);
    const { calls } = stubFormaloo();
    const res = await putForm(id, { FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE: '1' });
    expect(res.status).toBe(200);
    expect(sysFieldPosts(calls)).toEqual([]);
  });

  test('FORMALOO_FR_NAME_AUTOPUSH_DISABLE=1 → fr_id のみ (fr_name owner-gate)', async () => {
    const id = 'sfC';
    seedForm(id, 'FSLUG');
    seedFieldSlug(id, `${id}_f1`, 's_one', 0);
    const { calls } = stubFormaloo();
    const res = await putForm(id, { FORMALOO_FR_NAME_AUTOPUSH_DISABLE: '1' });
    expect(res.status).toBe(200);
    expect(sysFieldPosts(calls)).toEqual(['fr_id']);
  });

  test('T-C7: logic 有効フォーム → syncStatus out_of_sync + logic 専用 message (fr_id 破棄を honest 告知・殻完了防止)', async () => {
    const id = 'sfD';
    seedForm(id, 'FSLUG');
    seedFieldSlug(id, `${id}_f1`, 's_one', 0);
    const { calls } = stubFormaloo({ withLogic: true });
    const res = await putForm(id);
    expect(res.status).toBe(200);
    // field 作成は行う (owner が logic を外せば機能する) が、状態は out_of_sync
    expect(sysFieldPosts(calls).sort()).toEqual(['fr_id', 'fr_name']);
    const data = (await res.json() as { data: { syncStatus: string; syncError?: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    // owner 向け専用 message (logic により fr_id が破棄される旨)
    expect(data.syncError ?? '').toContain('logic');
    expect(data.syncError ?? '').toContain('fr_id');
  });
});
