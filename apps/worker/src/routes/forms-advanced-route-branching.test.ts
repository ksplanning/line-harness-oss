/**
 * form-route-branching (R2) — PUT 保存で form_type を反映・永続・pull 復元 + jump+simple backstop 警告。
 *  - form_type は baseline 差分時のみ PATCH (勝手に変えない)。未設定フォームは definition_json byte 一致。
 *  - jump rule ∧ formType='simple' → 非ブロッキング警告を response.warnings に載せる (最後の砦)。
 *  - jump 飛び先 = page_break(decoration) を logic filter が drop しない (R1 route 配線)。
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
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'frb-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'frb-formaloo-key', FORMALOO_API_SECRET: 'frb-formaloo-secret',
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
    headers: { Authorization: 'Bearer frb-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null, definitionJson = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, definitionJson, slug);
}

function definitionOf(id: string): Record<string, unknown> {
  const r = raw.prepare(`SELECT definition_json AS d FROM formaloo_forms WHERE id=?`).get(id) as { d: string };
  return JSON.parse(r.d);
}

interface ApiCall { method: string; url: string; body: unknown }

function stubFormaloo(opts: { getForm?: Record<string, unknown> } = {}) {
  const calls: ApiCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) return new Response(JSON.stringify({ data: { form: { fields_list: [], ...(opts.getForm ?? {}) } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { form: body ?? {} } }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('PUT /api/forms-advanced/:id — form_type (R2)', () => {
  test('formType=multi_step は definition_json に永続・response に露出・baseline 差分で form_type PATCH', async () => {
    seedForm('f1', 'SLUG1');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: [], formType: 'multi_step' });
    expect(res.status).toBe(200);
    expect(definitionOf('f1').formType).toBe('multi_step');
    const data = (await res.json() as { data: { formType: string | null } }).data;
    expect(data.formType).toBe('multi_step');
    // baseline (未設定=undefined) から multi_step へ変化 → form_type PATCH 送出
    const ft = calls.find((e) => e.method === 'PATCH' && (e.body as Record<string, unknown>)?.form_type === 'multi_step');
    expect(ft).toBeTruthy();
  });

  test('formType 未変化 (prev と同一) → form_type PATCH を送らない (勝手に変えない)', async () => {
    seedForm('f2', 'SLUG2', JSON.stringify({ fields: [], logic: [], formType: 'multi_step' }));
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/f2', { fields: [], logic: [], formType: 'multi_step', title: '新題' });
    expect(res.status).toBe(200);
    expect(calls.some((e) => (e.body as Record<string, unknown>)?.form_type !== undefined)).toBe(false);
    expect(definitionOf('f2').formType).toBe('multi_step'); // carry
  });

  test('formType 無しフォームは従来通り (definition_json に formType キー無し = 後方互換)', async () => {
    seedForm('f3', 'SLUG3');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/f3', { fields: [], logic: [] });
    expect(res.status).toBe(200);
    expect('formType' in definitionOf('f3')).toBe(false);
  });

  test('pull は Formaloo form_type を formType として復元 (multi_step)', async () => {
    seedForm('f4', 'SLUGP');
    stubFormaloo({ getForm: { form_type: 'multi_step' } });
    const res = await call('GET', '/api/forms-advanced/f4/pull');
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { ok: boolean; formType?: string } }).data;
    expect(data.ok).toBe(true);
    expect(data.formType).toBe('multi_step');
  });
});

describe('PUT /api/forms-advanced/:id — jump+simple backstop + jump→page_break 保持', () => {
  const fieldsWithJump = [
    { id: 'q1', type: 'choice', label: 'ルート', required: true, position: 0, config: { choices: ['A', 'C'], choiceItems: [{ title: 'A', slug: 'ciA' }, { title: 'C', slug: 'ciC' }] } },
    { id: 'pb', type: 'page_break', label: '', required: false, position: 1, config: {} },
    { id: 'q3', type: 'text', label: 'P3', required: false, position: 2, config: {} },
  ];
  const jumpRule = [{ id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'C', action: 'jump', targetFieldId: 'pb' }];

  test('jump rule ∧ formType=simple → 非ブロッキング警告 (success 維持)', async () => {
    seedForm('j1', 'SLUGJ');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/j1', { fields: fieldsWithJump, logic: jumpRule, formType: 'simple' });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; warnings?: string[] };
    expect(json.success).toBe(true);
    expect(json.warnings?.some((w) => /1問ずつ表示|multi_step/.test(w))).toBe(true);
  });

  test('jump rule ∧ formType=multi_step → 警告なし', async () => {
    seedForm('j2', 'SLUGK');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/j2', { fields: fieldsWithJump, logic: jumpRule, formType: 'multi_step' });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; warnings?: string[] };
    expect(json.warnings).toBeUndefined();
  });

  test('jump 飛び先 = page_break(decoration) は logic filter に drop されず definition_json に残る', async () => {
    seedForm('j3', 'SLUGL');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/j3', { fields: fieldsWithJump, logic: jumpRule, formType: 'multi_step' });
    expect(res.status).toBe(200);
    const persistedLogic = definitionOf('j3').logic as Array<{ action: string; targetFieldId: string }>;
    expect(persistedLogic).toHaveLength(1);
    expect(persistedLogic[0]).toMatchObject({ action: 'jump', targetFieldId: 'pb' });
  });

  test('show rule が decoration を target → 従来通り drop (回帰)', async () => {
    seedForm('j4', 'SLUGM');
    stubFormaloo();
    const showToPage = [{ id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'C', action: 'show', targetFieldId: 'pb' }];
    const res = await call('PUT', '/api/forms-advanced/j4', { fields: fieldsWithJump, logic: showToPage });
    expect(res.status).toBe(200);
    expect((definitionOf('j4').logic as unknown[])).toHaveLength(0); // show→decoration は drop
  });
});
