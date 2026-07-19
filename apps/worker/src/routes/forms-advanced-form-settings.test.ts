/**
 * treasure-b2-form-settings — form 単位「運用制御」の route 契約。
 *
 * 実 Formaloo FormUpdateRequest / GET read-back shape を pin する:
 *   has_recaptcha / accept_draft_answers / max_submit_count /
 *   submit_start_time / submit_end_time の管理 5 key のみを扱う。
 * PATCH 200 は反映根拠にせず、data.form.* の GET-after-PATCH 一致で同期済みとする。
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
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'ops-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'ops-formaloo-key', FORMALOO_API_SECRET: 'ops-formaloo-secret',
    // system hidden field の ensure は専用テストの責務。この route test は FormUpdateRequest のみに固定する。
    FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE: '1',
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
    headers: { Authorization: 'Bearer ops-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string, definitionJson = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, definitionJson, slug);
}

function definitionOf(id: string): Record<string, unknown> {
  const row = raw.prepare('SELECT definition_json AS d FROM formaloo_forms WHERE id=?').get(id) as { d: string };
  return JSON.parse(row.d) as Record<string, unknown>;
}

interface ApiCall { method: string; url: string; body: unknown }

const OPERATION_KEYS = [
  'has_recaptcha',
  'accept_draft_answers',
  'max_submit_count',
  'submit_start_time',
  'submit_end_time',
] as const;

const WRONG_OR_UNMANAGED_KEYS = [
  'max_responses',
  'submission_limit',
  'start_date',
  'end_date',
  'expire_date',
  'max_submit_per_ip_per_day',
  'time_limit',
] as const;

const REMOTE_DEFAULTS: Record<string, unknown> = {
  has_recaptcha: false,
  accept_draft_answers: false,
  max_submit_count: null,
  max_submit_per_ip_per_day: null,
  submit_start_time: null,
  submit_end_time: null,
  time_limit: null,
};

const REMOTE_ALL_SET: Record<string, unknown> = {
  has_recaptcha: true,
  accept_draft_answers: true,
  max_submit_count: 100,
  max_submit_per_ip_per_day: 3,
  submit_start_time: '2026-07-20T00:00:00Z',
  submit_end_time: '2026-08-20T00:00:00Z',
  time_limit: '00:10:00',
};

/**
 * Formaloo stub。PATCH の管理 5 key を data.form.* state に反映し、後続 GET が read-back する。
 * softIgnoreOperations は PATCH 200 のまま state を変えない実測地雷を再現する。
 */
function stubFormaloo(opts: { getForm?: Record<string, unknown>; softIgnoreOperations?: boolean } = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = { fields_list: [], logic: [], ...REMOTE_DEFAULTS, ...(opts.getForm ?? {}) };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (!(init?.body instanceof FormData)) {
      try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    }
    calls.push({ method, url, body });

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'ops-jwt' }), { status: 200 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      const patch = (body ?? {}) as Record<string, unknown>;
      if (!opts.softIgnoreOperations) {
        for (const key of OPERATION_KEYS) if (key in patch) state[key] = patch[key];
      }
      return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

function operationPatch(calls: ApiCall[]) {
  return calls.find((call) => call.method === 'PATCH' && call.body != null
    && OPERATION_KEYS.some((key) => key in (call.body as Record<string, unknown>)));
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe('PUT /api/forms-advanced/:id — 運用制御 FormUpdateRequest', () => {
  test('operationsSettings set は管理5実キーだけを PATCH・data.form GET確認し canonical を永続/応答する', async () => {
    seedForm('ops1', 'SLUG_OPS1');
    const calls = stubFormaloo();
    const operationsSettings = {
      hasRecaptcha: true,
      acceptDraftAnswers: true,
      maxSubmitCount: 100,
      submitStartTime: '2026-07-20T00:00:00Z',
      submitEndTime: '2026-08-20T00:00:00Z',
    };

    const res = await call('PUT', '/api/forms-advanced/ops1', { fields: [], logic: [], operationsSettings });

    expect(res.status).toBe(200);
    const patch = operationPatch(calls)?.body as Record<string, unknown> | undefined;
    expect(patch).toMatchObject({
      has_recaptcha: true,
      accept_draft_answers: true,
      max_submit_count: 100,
      submit_start_time: '2026-07-20T00:00:00Z',
      submit_end_time: '2026-08-20T00:00:00Z',
    });
    expect(patch && OPERATION_KEYS.filter((key) => key in patch)).toEqual(OPERATION_KEYS);
    for (const key of WRONG_OR_UNMANAGED_KEYS) expect(patch && key in patch).toBe(false);
    // PATCH 応答そのものではなく、実 shape data.form.* の独立 GET まで到達した証拠。
    expect(calls.some((call) => call.method === 'GET' && /\/v3\.0\/forms\/SLUG_OPS1\/$/.test(call.url))).toBe(true);
    expect(definitionOf('ops1').operationsSettings).toEqual(operationsSettings);
    const data = (await res.json() as { data: { operationsSettings: unknown; syncStatus: string } }).data;
    expect(data.operationsSettings).toEqual(operationsSettings);
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('operationsSettings 未提供は運用キーを PATCH せず definition_json にも key を作らない', async () => {
    seedForm('ops2', 'SLUG_OPS2');
    const calls = stubFormaloo();

    const res = await call('PUT', '/api/forms-advanced/ops2', { fields: [], logic: [], title: '新題' });

    expect(res.status).toBe(200);
    expect(operationPatch(calls)).toBeUndefined();
    expect('operationsSettings' in definitionOf('ops2')).toBe(false);
  });

  test('false/null clear は5実キーを明示 reset し canonical が空なら local key を削除する', async () => {
    const previous = {
      hasRecaptcha: true,
      acceptDraftAnswers: true,
      maxSubmitCount: 100,
      submitStartTime: '2026-07-20T00:00:00Z',
      submitEndTime: '2026-08-20T00:00:00Z',
    };
    seedForm('ops3', 'SLUG_OPS3', JSON.stringify({ fields: [], logic: [], operationsSettings: previous }));
    const calls = stubFormaloo({ getForm: REMOTE_ALL_SET });

    const res = await call('PUT', '/api/forms-advanced/ops3', {
      fields: [], logic: [],
      operationsSettings: {
        hasRecaptcha: false,
        acceptDraftAnswers: false,
        maxSubmitCount: null,
        submitStartTime: null,
        submitEndTime: null,
      },
    });

    expect(res.status).toBe(200);
    expect(operationPatch(calls)?.body).toMatchObject({
      has_recaptcha: false,
      accept_draft_answers: false,
      max_submit_count: null,
      submit_start_time: null,
      submit_end_time: null,
    });
    expect('operationsSettings' in definitionOf('ops3')).toBe(false);
    const data = (await res.json() as { data: { operationsSettings: unknown; syncStatus: string } }).data;
    expect(data.operationsSettings).toBeNull();
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('partial update は保存済み canonical 設定へ merge し、未指定値を消さない', async () => {
    const previous = {
      hasRecaptcha: true,
      acceptDraftAnswers: true,
      maxSubmitCount: 50,
      submitStartTime: '2026-07-20T00:00:00Z',
      submitEndTime: '2026-08-20T00:00:00Z',
    };
    seedForm('ops4', 'SLUG_OPS4', JSON.stringify({ fields: [], logic: [], operationsSettings: previous }));
    const calls = stubFormaloo({ getForm: { ...REMOTE_ALL_SET, max_submit_count: 50 } });

    const res = await call('PUT', '/api/forms-advanced/ops4', {
      fields: [], logic: [], operationsSettings: { maxSubmitCount: 75 },
    });

    expect(res.status).toBe(200);
    expect(operationPatch(calls)?.body).toMatchObject({ max_submit_count: 75 });
    expect(definitionOf('ops4').operationsSettings).toEqual({ ...previous, maxSubmitCount: 75 });
    expect((await res.json() as { data: { operationsSettings: unknown } }).data.operationsSettings)
      .toEqual({ ...previous, maxSubmitCount: 75 });
  });

  test('PATCH 200 soft-ignore は GET-after-PATCH 不一致で out_of_sync にする', async () => {
    seedForm('ops5', 'SLUG_OPS5');
    const calls = stubFormaloo({ softIgnoreOperations: true });

    const res = await call('PUT', '/api/forms-advanced/ops5', {
      fields: [], logic: [], operationsSettings: { hasRecaptcha: true, maxSubmitCount: 100 },
    });

    expect(res.status).toBe(200);
    expect(operationPatch(calls)).toBeDefined(); // PATCH 自体は 200
    expect(calls.some((call) => call.method === 'GET' && /\/v3\.0\/forms\/SLUG_OPS5\/$/.test(call.url))).toBe(true);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('誤キー・今回非管理2キーは whitelist drop し remote/local のどちらにも送らない', async () => {
    seedForm('ops6', 'SLUG_OPS6');
    const calls = stubFormaloo();

    const res = await call('PUT', '/api/forms-advanced/ops6', {
      fields: [], logic: [],
      operationsSettings: {
        maxResponses: 100,
        submissionLimit: 100,
        startDate: '2026-07-20T00:00:00Z',
        endDate: '2026-08-20T00:00:00Z',
        expireDate: '2026-08-20T00:00:00Z',
        maxSubmitPerIpPerDay: 3,
        timeLimit: '00:10:00',
      },
    });

    expect(res.status).toBe(200);
    for (const call of calls) {
      if (!call.body || typeof call.body !== 'object') continue;
      for (const key of WRONG_OR_UNMANAGED_KEYS) expect(key in (call.body as Record<string, unknown>)).toBe(false);
    }
    expect(operationPatch(calls)).toBeUndefined();
    expect('operationsSettings' in definitionOf('ops6')).toBe(false);
  });

  test('ISO8601 datetime でない曖昧な日付文字列は push/save 前に 400 reject する', async () => {
    seedForm('ops7', 'SLUG_OPS7');
    const calls = stubFormaloo();

    const res = await call('PUT', '/api/forms-advanced/ops7', {
      fields: [], logic: [], operationsSettings: { submitStartTime: 'July 20, 2026' },
    });

    expect(res.status).toBe(400);
    expect(operationPatch(calls)).toBeUndefined();
    expect('operationsSettings' in definitionOf('ops7')).toBe(false);
  });
});

describe('GET /api/forms-advanced/:id/pull — 運用制御逆算', () => {
  test('実測7キー data.form fixture から今回管理する5キーだけを canonical へ逆算する', async () => {
    seedForm('ops-pull', 'SLUG_OPS_PULL');
    stubFormaloo({ getForm: REMOTE_ALL_SET });

    const res = await call('GET', '/api/forms-advanced/ops-pull/pull');

    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { ok: boolean; operationsSettings?: unknown } }).data;
    expect(data.ok).toBe(true);
    expect(data.operationsSettings).toEqual({
      hasRecaptcha: true,
      acceptDraftAnswers: true,
      maxSubmitCount: 100,
      submitStartTime: '2026-07-20T00:00:00Z',
      submitEndTime: '2026-08-20T00:00:00Z',
    });
    expect(data.operationsSettings).not.toHaveProperty('maxSubmitPerIpPerDay');
    expect(data.operationsSettings).not.toHaveProperty('timeLimit');
  });
});
