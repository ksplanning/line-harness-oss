/**
 * b1-field-polish (T-C1 / R-3) — PUT save の meta PATCH に星色 custom_css を rating-gated で合流。
 *   rating field ≥1 → meta PATCH body に managed custom_css (既定黄 or 選択色) を非破壊 merge。
 *   rating 無フォーム → custom_css を注入しない (既存 byte 不変 / R-3)。foreign custom_css は保持。
 *   designColorFields (本文 flat 7 色) は不改変 = 星色は別キー disjoint (D-2)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_RATING_STAR_COLOR } from '@line-crm/shared';
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
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'star-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'star-formaloo-key', FORMALOO_API_SECRET: 'star-formaloo-secret',
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
    headers: { Authorization: 'Bearer star-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null, definitionJson = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, definitionJson, slug);
}

function seedFieldSlug(formId: string, fieldId: string, slug: string, fieldType: string, position: number) {
  raw.prepare(
    `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
  ).run(fieldId, formId, slug, fieldType, 'L', position, '{}');
}

interface ApiCall { method: string; url: string; body: unknown }

/** meta PATCH body を捕捉し、custom_css GET は seeded foreign css を返す stub。 */
function stubFormaloo(opts: { customCss?: string } = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = { fields_list: [], ...(opts.customCss !== undefined ? { custom_css: opts.customCss } : {}) };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) return new Response(JSON.stringify({ authorization_token: 'star-jwt' }), { status: 200 });
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      Object.assign(state, (body ?? {}) as Record<string, unknown>); // 色/custom_css を state に round-trip (confirm GET 用)
      return new Response(JSON.stringify({ data: { form: body } }), { status: 200 });
    }
    if (url.includes('/v3.0/fields/')) {
      if (method === 'POST') return new Response(JSON.stringify({ data: { field: { slug: 'F_NEW' } } }), { status: 201 });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

function metaPatch(calls: ApiCall[], slug: string): Record<string, unknown> | undefined {
  return calls.find((e) => e.method === 'PATCH' && new RegExp(`/forms/${slug}/$`).test(e.url))?.body as Record<string, unknown> | undefined;
}

const ratingField = (id: string) => ({ id, type: 'rating', label: '満足度', required: false, position: 0, config: {} });
const textField = (id: string) => ({ id, type: 'text', label: '名前', required: true, position: 0, config: {} });

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('b1-field-polish T-C1 — 星色 custom_css の rating-gated 合流', () => {
  test('rating field ≥1 + 色未指定 → meta PATCH に既定黄の managed custom_css を注入', async () => {
    seedForm('r1', 'SLUGR1');
    seedFieldSlug('r1', 'fld_r1', 's_rate', 'rating', 0);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r1', { fields: [ratingField('fld_r1')], logic: [] });
    expect(res.status).toBe(200);
    const body = metaPatch(calls, 'SLUGR1');
    expect(typeof body?.custom_css).toBe('string');
    expect(String(body?.custom_css)).toContain(DEFAULT_RATING_STAR_COLOR); // 既定黄
    expect(String(body?.custom_css)).toContain('nps-icon-star'); // star クラス scope
  });

  test('rating field + ratingStarColor 指定 → その色を custom_css に注入', async () => {
    seedForm('r2', 'SLUGR2');
    seedFieldSlug('r2', 'fld_r2', 's_rate', 'rating', 0);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r2', { fields: [ratingField('fld_r2')], logic: [], design: { ratingStarColor: '#3B82F6' } });
    expect(res.status).toBe(200);
    expect(String(metaPatch(calls, 'SLUGR2')?.custom_css)).toContain('#3B82F6');
  });

  test('rating field + ratingStarColor=null (明示クリア) → custom_css を注入しない', async () => {
    seedForm('r3', 'SLUGR3');
    seedFieldSlug('r3', 'fld_r3', 's_rate', 'rating', 0);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r3', { fields: [ratingField('fld_r3')], logic: [], design: { ratingStarColor: null } });
    expect(res.status).toBe(200);
    expect('custom_css' in (metaPatch(calls, 'SLUGR3') ?? {})).toBe(false);
  });

  test('R-3: rating field 無し → custom_css を注入しない (byte 不変)', async () => {
    seedForm('r4', 'SLUGR4');
    seedFieldSlug('r4', 'fld_r4', 's_txt', 'short_text', 0);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r4', { fields: [textField('fld_r4')], logic: [] });
    expect(res.status).toBe(200);
    expect('custom_css' in (metaPatch(calls, 'SLUGR4') ?? {})).toBe(false);
  });

  test('R-3: rating field + foreign custom_css → foreign を保持しつつ managed block を追記 (非破壊)', async () => {
    seedForm('r5', 'SLUGR5');
    seedFieldSlug('r5', 'fld_r5', 's_rate', 'rating', 0);
    const calls = stubFormaloo({ customCss: '.owner-custom{color:red}' });
    const res = await call('PUT', '/api/forms-advanced/r5', { fields: [ratingField('fld_r5')], logic: [], design: { ratingStarColor: '#F5B301' } });
    expect(res.status).toBe(200);
    const css = String(metaPatch(calls, 'SLUGR5')?.custom_css);
    expect(css).toContain('.owner-custom{color:red}'); // foreign 保持
    expect(css).toContain('#F5B301'); // managed block も追記
  });

  test('D-2: rating form + design 色 → meta PATCH に 7 色 (JSON-string RGBA) と custom_css が両立 (色は不改変)', async () => {
    seedForm('r6', 'SLUGR6');
    seedFieldSlug('r6', 'fld_r6', 's_rate', 'rating', 0);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r6', {
      fields: [ratingField('fld_r6')], logic: [],
      design: { themeColor: '#06C755', buttonColor: '#06C755', ratingStarColor: '#F5B301' },
    });
    expect(res.status).toBe(200);
    const body = metaPatch(calls, 'SLUGR6') as Record<string, string>;
    // designColorFields 由来の本文色は JSON-string RGBA で乗る (別キー disjoint)。
    expect(body.theme_color).toBe(JSON.stringify({ r: 6, g: 199, b: 85, a: 1 }));
    expect(body.button_color).toBe(JSON.stringify({ r: 6, g: 199, b: 85, a: 1 }));
    // 星色は custom_css キー (色 field には混ざらない)。
    expect(String(body.custom_css)).toContain('#F5B301');
    expect(JSON.stringify({ theme_color: body.theme_color, button_color: body.button_color })).not.toContain('F5B301');
  });
});
