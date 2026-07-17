/**
 * form-jp-localization (T-B2) — PUT 保存で公開ページ文言 (button_text/success_message/error_message) を
 *   Formaloo へ反映・定義に永続・soft-200 対策の GET-after-PATCH で honest surface。
 *  - 文言は既存 title/description meta PATCH に additive 合流 (present-key only / update 意味論)。
 *  - formCopy 未提供 save は文言を送らず prev を carry (後方互換 byte 不変)。
 *  - 設定は保存されるが hosted に反映されない (soft-200) を GET-after-PATCH 不一致→ out_of_sync で surface。
 * design route test (forms-advanced-design.test.ts) を写経元にした file-disjoint な専用 harness。
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
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'copy-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'copy-formaloo-key', FORMALOO_API_SECRET: 'copy-formaloo-secret',
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
    headers: { Authorization: 'Bearer copy-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null, definitionJson = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, definitionJson, slug);
}

function rawDefinitionOf(id: string): string {
  const r = raw.prepare(`SELECT definition_json AS d FROM formaloo_forms WHERE id=?`).get(id) as { d: string };
  return r.d;
}
function definitionOf(id: string): Record<string, unknown> {
  return JSON.parse(rawDefinitionOf(id));
}

interface ApiCall { method: string; url: string; body: unknown }
const COPY_KEYS = ['button_text', 'success_message', 'error_message'];

/**
 * Formaloo API stub。文言 PATCH は remote form state に round-trip 反映され、後続 GET (= confirmFormCopyReflected)
 *   がそれを返す (実 Formaloo GET-after-PATCH 挙動を模倣)。
 *   - softIgnore: 文言 PATCH を soft-200 で無言無視 (state に反映しない = 反映されない地雷)。
 *   - reflectAfterGet: N 回目の confirm GET から反映 (bounded retry 収束模倣)。
 */
function stubFormaloo(opts: { getForm?: Record<string, unknown>; softIgnore?: boolean; reflectAfterGet?: number } = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = { fields_list: [], ...(opts.getForm ?? {}) };
  let pending: Record<string, unknown> | null = null;
  let getCount = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (!(init?.body instanceof FormData)) {
      try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    }
    calls.push({ method, url, body });

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'copy-jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      getCount += 1;
      if (pending && opts.reflectAfterGet != null && getCount >= opts.reflectAfterGet) { Object.assign(state, pending); pending = null; }
      return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) if (COPY_KEYS.includes(k)) copy[k] = v;
      if (Object.keys(copy).length) {
        if (opts.softIgnore) { /* soft-200: 無言無視 = state に反映しない */ }
        else if (opts.reflectAfterGet != null) pending = { ...(pending ?? {}), ...copy };
        else Object.assign(state, copy);
      }
      return new Response(JSON.stringify({ data: { form: body } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

/** 文言 key を持つ meta PATCH を探す (文言を運ぶ PATCH は meta PATCH のみ)。 */
function copyPatch(calls: ApiCall[]) {
  return calls.find((e) => e.method === 'PATCH' && e.body != null && COPY_KEYS.some((k) => k in (e.body as Record<string, unknown>)));
}
function anyCopyPatch(calls: ApiCall[]) { return copyPatch(calls); }

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('PUT /api/forms-advanced/:id — form-jp-localization 文言', () => {
  test('formCopy 提供 → meta PATCH body に文言キーが合流し definition_json に永続・out_of_sync でない', async () => {
    seedForm('k1', 'SLUGK1');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k1', {
      fields: [], logic: [],
      formCopy: { buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました' },
    });
    expect(res.status).toBe(200);
    const patch = copyPatch(calls);
    expect(patch?.body).toMatchObject({ button_text: '送信', success_message: 'ありがとうございました', error_message: '送信に失敗しました' });
    // definition_json は canonical (buttonText 等) で永続。
    expect(definitionOf('k1').formCopy).toEqual({ buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました' });
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('formCopy 未提供 → meta PATCH body に文言キー不在・definition_json に formCopy キー不在 (後方互換)', async () => {
    seedForm('k2', 'SLUGK2');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k2', { fields: [], logic: [], title: '新題' });
    expect(res.status).toBe(200);
    expect(anyCopyPatch(calls)).toBeUndefined(); // 文言キーを 1 つも送っていない
    expect('formCopy' in definitionOf('k2')).toBe(false);
  });

  test('D-1 後方互換: formCopy を持つフォームへの formCopy 未提供 save は definition_json 生バイト完全一致 (idempotent)', async () => {
    // buildDefinitionJson は formalooAddress/logicFingerprint を必ず正規化して書くため、route 自身が
    // canonicalize した状態を基準に「formCopy 未提供 save の前後で raw string が 1 byte も変わらない」を証明する。
    seedForm('k3', 'SLUGK3');
    stubFormaloo();
    // save 1: formCopy を set して canonicalize + 永続。
    await call('PUT', '/api/forms-advanced/k3', { fields: [], logic: [], formCopy: { buttonText: '送信' } });
    const before = rawDefinitionOf('k3');
    // save 2: formCopy 未提供 (builder が文言を触っていない) → prev を carry。
    const res = await call('PUT', '/api/forms-advanced/k3', { fields: [], logic: [] });
    expect(res.status).toBe(200);
    const after = rawDefinitionOf('k3');
    expect(after).toBe(before); // 生バイト完全一致 (キー不在検査でなく raw string 一致)
    expect(definitionOf('k3').formCopy).toEqual({ buttonText: '送信' }); // prev 文言は carry
  });

  test('partial merge: prev formCopy + incoming set key → merge 永続・prev を消さない', async () => {
    const seeded = JSON.stringify({ fields: [], logic: [], formCopy: { successMessage: '完了しました' } });
    seedForm('k4', 'SLUGK4', seeded);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k4', {
      fields: [], logic: [],
      formCopy: { buttonText: '送信', successMessage: '', errorMessage: '' }, // buttonText だけ新規・他は空欄
    });
    expect(res.status).toBe(200);
    // prev successMessage は保持され buttonText が追加される (空欄=未指定=触らない → 誤消去しない)。
    expect(definitionOf('k4').formCopy).toEqual({ successMessage: '完了しました', buttonText: '送信' });
    // meta PATCH は merged 文言を原子送 (self-heal parity w/ design)。
    expect(copyPatch(calls)?.body).toMatchObject({ button_text: '送信', success_message: '完了しました' });
  });

  test('D-4a soft-200: 文言 PATCH が無言無視され GET-after-PATCH 不一致 → out_of_sync (殻完了防止)', async () => {
    seedForm('k5', 'SLUGK5');
    stubFormaloo({ softIgnore: true });
    const res = await call('PUT', '/api/forms-advanced/k5', { fields: [], logic: [], formCopy: { buttonText: '送信' } });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('D-4b bounded retry で反映収束 → out_of_sync でない (eventual consistency)', async () => {
    seedForm('k6', 'SLUGK6');
    stubFormaloo({ reflectAfterGet: 2 });
    const res = await call('PUT', '/api/forms-advanced/k6', { fields: [], logic: [], formCopy: { buttonText: '送信' } });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('D-3 on_submit_message を触らない: どの PATCH body にも on_submit_message 系キーが無い', async () => {
    seedForm('k7', 'SLUGK7');
    const calls = stubFormaloo();
    await call('PUT', '/api/forms-advanced/k7', { fields: [], logic: [], formCopy: { successMessage: 'ありがとう' } });
    const touched = calls.some((e) => e.body != null && Object.keys(e.body as Record<string, unknown>).some((k) => /on_submit_message|submit_message/.test(k)));
    expect(touched).toBe(false);
  });

  test('文言 GET-after mock は実 Formaloo 応答 shape (data.form.*) — 一致で idle', async () => {
    seedForm('k8', 'SLUGK8');
    // stub は PATCH した文言を data.form.* に round-trip する (base extractForm と同 shape)。
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/k8', { fields: [], logic: [], formCopy: { errorMessage: 'エラー' } });
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });
});
