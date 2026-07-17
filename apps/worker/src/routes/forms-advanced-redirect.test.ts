/**
 * route-terminal-phase2 (T-B2) — PUT 保存で送信後リダイレクト URL を Formaloo へ反映・永続・soft-200 対策。
 *  - form_redirects_after_submit は既存 title/description meta PATCH に additive 合流 (present-key only)。
 *  - worker authoritative 検証 (CI-4/CX-7): 危険 URL/非 string を push 前に 400 で明示 reject (silent drop 非依存)。
 *  - CX-4 clear 意味論: url 空/明示クリアで form_redirects_after_submit:null を送り既存 redirect を解除。
 *  - formRedirect 未提供 save は redirect を送らず prev を carry (後方互換 byte 不変)。
 *  - soft-200: 送った URL が hosted に反映されない → GET-after-PATCH 不一致 → out_of_sync (殻完了防止)。
 * forms-advanced-form-copy.test.ts を写経元にした file-disjoint な専用 harness。
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
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'rd-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'rd-formaloo-key', FORMALOO_API_SECRET: 'rd-formaloo-secret',
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
    headers: { Authorization: 'Bearer rd-owner-key', 'Content-Type': 'application/json' },
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
const REDIRECT_KEY = 'form_redirects_after_submit';

/**
 * Formaloo API stub。redirect PATCH は remote form state に round-trip 反映され、後続 GET
 *   (= confirmRedirectReflected) がそれを返す。
 *   - softIgnore: redirect PATCH を soft-200 で無言無視 (state に反映しない = 反映されない地雷)。
 */
function stubFormaloo(opts: { getForm?: Record<string, unknown>; softIgnore?: boolean } = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = { fields_list: [], ...(opts.getForm ?? {}) };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (!(init?.body instanceof FormData)) {
      try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    }
    calls.push({ method, url, body });

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'rd-jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      const b = (body ?? {}) as Record<string, unknown>;
      if (REDIRECT_KEY in b && !opts.softIgnore) state[REDIRECT_KEY] = b[REDIRECT_KEY];
      return new Response(JSON.stringify({ data: { form: body } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

/** redirect key を持つ meta PATCH を探す。 */
function redirectPatch(calls: ApiCall[]) {
  return calls.find((e) => e.method === 'PATCH' && e.body != null && REDIRECT_KEY in (e.body as Record<string, unknown>));
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('PUT /api/forms-advanced/:id — route-terminal-phase2 redirect (Track 1)', () => {
  test('formRedirect 提供 → meta PATCH に form_redirects_after_submit 合流・definition_json 永続・out_of_sync でない', async () => {
    seedForm('r1', 'SLUGR1');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r1', {
      fields: [], logic: [],
      formRedirect: { url: 'https://example.com/lp', openExternalBrowser: false },
    });
    expect(res.status).toBe(200);
    expect(redirectPatch(calls)?.body).toMatchObject({ form_redirects_after_submit: 'https://example.com/lp' });
    expect(definitionOf('r1').formRedirect).toEqual({ url: 'https://example.com/lp', openExternalBrowser: false });
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('外部ブラウザ ON → form_redirects_after_submit に openExternalBrowser=1 付与', async () => {
    seedForm('r2', 'SLUGR2');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r2', {
      fields: [], logic: [],
      formRedirect: { url: 'https://example.com/lp?utm=x', openExternalBrowser: true },
    });
    expect(res.status).toBe(200);
    const sent = (redirectPatch(calls)?.body as Record<string, string>)[REDIRECT_KEY];
    expect(new URL(sent).searchParams.get('openExternalBrowser')).toBe('1');
    expect(new URL(sent).searchParams.get('utm')).toBe('x');
  });

  test('CI-4/CX-7 危険 URL は push 前に 400 (javascript:/http:/userinfo/非 string)', async () => {
    seedForm('r3', 'SLUGR3');
    stubFormaloo();
    for (const bad of ['javascript:alert(1)', 'http://x.com', 'https://user:pass@x.com', 'data:text/html,x']) {
      const res = await call('PUT', '/api/forms-advanced/r3', { fields: [], logic: [], formRedirect: { url: bad } });
      expect(res.status).toBe(400);
    }
    const resNonStr = await call('PUT', '/api/forms-advanced/r3', { fields: [], logic: [], formRedirect: { url: 12345 } });
    expect(resNonStr.status).toBe(400);
  });

  test('CX-4 clear 意味論: prev redirect ありで url 空 → form_redirects_after_submit:null を送り解除・永続からも消える', async () => {
    const seeded = JSON.stringify({ fields: [], logic: [], formRedirect: { url: 'https://old.example.com/lp' } });
    seedForm('r4', 'SLUGR4', seeded);
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r4', { fields: [], logic: [], formRedirect: { url: '' } });
    expect(res.status).toBe(200);
    const patch = redirectPatch(calls);
    expect(patch?.body).toMatchObject({ form_redirects_after_submit: null });
    expect('formRedirect' in definitionOf('r4')).toBe(false); // 永続からも消える
  });

  test('formRedirect 未提供 → redirect meta PATCH 不在・definition_json に formRedirect キー不在 (後方互換)', async () => {
    seedForm('r5', 'SLUGR5');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r5', { fields: [], logic: [], title: '新題' });
    expect(res.status).toBe(200);
    expect(redirectPatch(calls)).toBeUndefined();
    expect('formRedirect' in definitionOf('r5')).toBe(false);
  });

  test('D-1 後方互換: formRedirect を持つフォームへの formRedirect 未提供 save は definition_json 生バイト完全一致', async () => {
    seedForm('r6', 'SLUGR6');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/r6', { fields: [], logic: [], formRedirect: { url: 'https://example.com/lp' } });
    const before = rawDefinitionOf('r6');
    const res = await call('PUT', '/api/forms-advanced/r6', { fields: [], logic: [] });
    expect(res.status).toBe(200);
    expect(rawDefinitionOf('r6')).toBe(before); // 生バイト完全一致
    expect(definitionOf('r6').formRedirect).toEqual({ url: 'https://example.com/lp' }); // prev carry
  });

  test('soft-200: redirect PATCH が無言無視され GET-after 不一致 → out_of_sync (殻完了防止)', async () => {
    seedForm('r7', 'SLUGR7');
    stubFormaloo({ softIgnore: true });
    const res = await call('PUT', '/api/forms-advanced/r7', {
      fields: [], logic: [], formRedirect: { url: 'https://example.com/lp' },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('T-C3 load: 保存後の応答 (serializeForm) が formRedirect を返す (reload 復元素材)', async () => {
    seedForm('r9', 'SLUGR9');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/r9', {
      fields: [], logic: [], formRedirect: { url: 'https://example.com/lp', openExternalBrowser: true },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { formRedirect?: unknown } }).data;
    expect(data.formRedirect).toEqual({ url: 'https://example.com/lp', openExternalBrowser: true });
    // redirect 無しフォームは formRedirect:null を返す (design/formType と同型)。
    seedForm('r9b', 'SLUGR9B');
    const res2 = await call('PUT', '/api/forms-advanced/r9b', { fields: [], logic: [] });
    const data2 = (await res2.json() as { data: { formRedirect?: unknown } }).data;
    expect(data2.formRedirect).toBeNull();
  });

  test('D-1 idempotent: redirect 無しフォームへの redirect 無し save 前後で definition_json byte 一致', async () => {
    seedForm('r8', 'SLUGR8');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/r8', { fields: [], logic: [] });
    const before = rawDefinitionOf('r8');
    await call('PUT', '/api/forms-advanced/r8', { fields: [], logic: [] });
    expect(rawDefinitionOf('r8')).toBe(before);
    expect('formRedirect' in definitionOf('r8')).toBe(false);
  });
});
