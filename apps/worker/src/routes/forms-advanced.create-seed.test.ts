/**
 * form-design-presets ② (T-B2 / D-3) — POST create の既定パレット seed + 既存 null フォーム不可触。
 *   T-B2: POST /api/forms-advanced → response data.design.presetId === DEFAULT_FORM_DESIGN_PRESET_ID
 *         かつ 7 色 hex。D1 definition_json.design にも seed される (create-seed 経路)。
 *   D-3 : 既存 design=null フォーム相当の PUT (design:{}) → D1 definition に design key が生えない
 *         (色 push 0 / 既存フォーム不可触 = 後方互換の直接証明)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_FORM_DESIGN_PRESET_ID, FORM_DESIGN_COLOR_KEYS } from '@line-crm/shared';
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
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'seed-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'seed-formaloo-key', FORMALOO_API_SECRET: 'seed-formaloo-secret',
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formsAdvanced);
  return a;
}

function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer seed-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function definitionOf(id: string): Record<string, unknown> {
  const r = raw.prepare('SELECT definition_json AS d FROM formaloo_forms WHERE id=?').get(id) as { d: string };
  return JSON.parse(r.d);
}
function seedNullDesignForm(id: string, slug: string) {
  // 既存 design=null フォーム相当 (definition に design key 無し)。
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', '{"fields":[],"logic":[]}', ?)`,
  ).run(id, slug);
}

// 既存 null フォームの PUT push を成立させるための最小 Formaloo stub (色 PATCH の有無を観測)。
interface ApiCall { method: string; url: string; body: unknown }
function stubFormaloo() {
  const calls: ApiCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) return new Response(JSON.stringify({ data: { form: { fields_list: [] } } }), { status: 200 });
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) return new Response(JSON.stringify({ data: { form: body } }), { status: 200 });
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/forms-advanced — 既定パレット create-seed (T-B2)', () => {
  test('新規作成 response.data.design が OD-2 既定パレット (presetId + 7 色 hex) を持つ', async () => {
    const res = await call('POST', '/api/forms-advanced', { title: '新規フォーム' });
    expect(res.status).toBe(201);
    const design = (await res.json() as { data: { design: Record<string, string> | null } }).data.design;
    expect(design).not.toBeNull();
    expect(design!.presetId).toBe(DEFAULT_FORM_DESIGN_PRESET_ID);
    for (const key of FORM_DESIGN_COLOR_KEYS) {
      expect(design![key]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  test('create-seed は D1 definition_json.design にも persist される (builder 初期表示→初回 save で色 push の起点)', async () => {
    const res = await call('POST', '/api/forms-advanced', { title: '新規フォーム2' });
    const id = (await res.json() as { data: { id: string } }).data.id;
    const design = definitionOf(id).design as Record<string, string>;
    expect(design.presetId).toBe(DEFAULT_FORM_DESIGN_PRESET_ID);
    expect(design.fieldColor).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe('PUT /api/forms-advanced/:id — 既存 null フォーム不可触 (D-3)', () => {
  test('既存 design=null フォームに design:{} PUT → definition に design key が生えず色 PATCH も送らない', async () => {
    seedNullDesignForm('nf1', 'SLUGN');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/nf1', { fields: [], logic: [], design: {} });
    expect(res.status).toBe(200);
    // D1: design key が生えない (既存 null 不可触 = 後方互換)。
    expect('design' in definitionOf('nf1')).toBe(false);
    // Formaloo 色 PATCH: theme_color 等の色 field を一切送っていない (色 push 0)。
    const colorPatch = calls.find((e) =>
      e.method === 'PATCH' && e.body != null &&
      FORM_DESIGN_COLOR_KEYS.some((k) => (e.body as Record<string, unknown>)[k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] !== undefined));
    expect(colorPatch).toBeUndefined();
  });
});
