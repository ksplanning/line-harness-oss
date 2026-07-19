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

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'em-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'em-fk', FORMALOO_API_SECRET: 'em-fs',
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  hono.route('/', formsAdvanced);
  return hono;
}

function call(method: string, path: string, body?: unknown, bindings = env()) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer em-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, bindings);
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

function seedFieldMap(formId: string, id: string, slug: string, type = 'email') {
  raw.prepare(
    `INSERT INTO formaloo_field_map
       (id, form_id, formaloo_field_slug, field_type, label, position, config_json)
     VALUES (?, ?, ?, ?, '項目', 0, '{}')`,
  ).run(id, formId, slug, type);
}

function editMailFieldSlug(id: string): string | null | undefined {
  const row = raw.prepare('SELECT edit_mail_field_slug AS slug FROM formaloo_forms WHERE id=?').get(id) as { slug: string | null } | undefined;
  return row?.slug;
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
    if (method === 'GET' && /\/v3\.0\/fields\/[^/?]+\/$/.test(url)) return new Response('{}', { status: 404 });
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
    const forbidden = /allow_edit_mail|allowEditMail|edit_mail_field|editMailField/;
    for (const c of calls) {
      expect(JSON.stringify(c.body ?? {})).not.toMatch(forbidden);
    }
    expect(editMailRow('em5')).toBe(1);
  });
});

describe('GET/PUT /api/forms-advanced/:id — 編集メール宛先の明示指定 (Phase B / G-1)', () => {
  test('GET は保存 slug と完全一致する email map の internal id だけを返す (先頭 fallback なし)', async () => {
    seedForm('em6', 'EM_FORM6');
    seedFieldMap('em6', 'first-email', 'FIRST');
    seedFieldMap('em6', 'chosen-email', 'CHOSEN');
    raw.prepare("UPDATE formaloo_forms SET edit_mail_field_slug='CHOSEN' WHERE id='em6'").run();

    const get = await call('GET', '/api/forms-advanced/em6');
    const meta = (await get.json()) as { data: { editMailFieldId?: string | null } };
    expect(meta.data.editMailFieldId).toBe('chosen-email');

    raw.prepare("UPDATE formaloo_forms SET edit_mail_field_slug=NULL WHERE id='em6'").run();
    const unset = await call('GET', '/api/forms-advanced/em6');
    expect(((await unset.json()) as { data: { editMailFieldId?: string | null } }).data.editMailFieldId).toBeNull();
  });

  test('PUT は明示した既存 email internal id を remote slug に変換して保存する', async () => {
    seedForm('em7', 'EM_FORM7');
    seedFieldMap('em7', 'reply-email', 'REMOTE_EMAIL');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/em7', {
      fields: [{ id: 'reply-email', type: 'email', label: '返信先', required: true, position: 0, config: {} }],
      logic: [],
      editMailFieldId: 'reply-email',
    });
    expect(res.status).toBe(200);
    expect(editMailFieldSlug('em7')).toBe('REMOTE_EMAIL');
    expect(((await res.json()) as { data: { editMailFieldId?: string | null } }).data.editMailFieldId).toBe('reply-email');
  });

  test('新規 email internal id は push 後に採番された remote slug を保存する', async () => {
    seedForm('em7-new', 'EM_FORM7_NEW');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/em7-new', {
      fields: [{ id: 'new-email', type: 'email', label: '新規返信先', required: true, position: 0, config: {} }],
      logic: [],
      editMailFieldId: 'new-email',
    });
    expect(res.status).toBe(200);
    expect(editMailFieldSlug('em7-new')).toBe('FLD');
    expect(((await res.json()) as { data: { editMailFieldId?: string | null } }).data.editMailFieldId).toBe('new-email');
  });

  test.each([
    ['unknown id', 'missing'],
    ['text field', 'name-field'],
  ])('unknown/text は 400 で reject (%s)', async (_case, editMailFieldId) => {
    seedForm(`em8-${editMailFieldId}`, 'EM_FORM8');
    const res = await call('PUT', `/api/forms-advanced/em8-${editMailFieldId}`, {
      fields: [
        { id: 'name-field', type: 'text', label: '氏名', required: true, position: 0, config: {} },
        { id: 'reply-email', type: 'email', label: '返信先', required: true, position: 1, config: {} },
      ],
      logic: [],
      editMailFieldId,
    });
    expect(res.status).toBe(400);
  });

  test('null は明示解除し、key 不在は既存 slug を維持する', async () => {
    seedForm('em9', 'EM_FORM9');
    seedFieldMap('em9', 'reply-email', 'REMOTE_EMAIL');
    raw.prepare("UPDATE formaloo_forms SET edit_mail_field_slug='REMOTE_EMAIL' WHERE id='em9'").run();
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/em9', {
      fields: [{ id: 'reply-email', type: 'email', label: '返信先', required: true, position: 0, config: {} }],
      logic: [],
    });
    expect(editMailFieldSlug('em9')).toBe('REMOTE_EMAIL');
    await call('PUT', '/api/forms-advanced/em9', {
      fields: [{ id: 'reply-email', type: 'email', label: '返信先', required: true, position: 0, config: {} }],
      logic: [],
      editMailFieldId: null,
    });
    expect(editMailFieldSlug('em9')).toBeNull();
  });
});

describe('PUT /api/forms-advanced/:id — submit-time 控え設定 (Phase B / D-7)', () => {
  const receiptKeys = ['show_submit_tracking_code', 'assign_submit_number', 'generate_pdf_for_user'] as const;
  const field = { id: 'reply-email', type: 'email', label: '返信先', required: true, position: 0, config: {} };

  test('env + 後編集 + メール + 明示宛先の AND gate で既存 meta PATCH に3設定を true で合流する', async () => {
    seedForm('em10', 'EM_FORM10');
    seedFieldMap('em10', 'reply-email', 'REMOTE_EMAIL');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/em10', {
      fields: [field], logic: [], allowPostEdit: 1, allowEditMail: 1, editMailFieldId: 'reply-email',
    }, env({ FORM_EDIT_MAIL_ENABLED: 'true' }));
    expect(res.status).toBe(200);
    const body = calls.map((call) => call.body).find((candidate) =>
      candidate && typeof candidate === 'object' && receiptKeys.every((key) => key in (candidate as Record<string, unknown>)),
    ) as Record<string, unknown> | undefined;
    expect(body).toBeTruthy();
    for (const key of receiptKeys) expect(body?.[key]).toBe(true);
  });

  test.each([
    ['env 未設定', {}, { allowPostEdit: 1, allowEditMail: 1 }],
    ['後編集 OFF', { FORM_EDIT_MAIL_ENABLED: 'true' }, { allowPostEdit: 0, allowEditMail: 1 }],
    ['メール OFF', { FORM_EDIT_MAIL_ENABLED: 'true' }, { allowPostEdit: 1, allowEditMail: 0 }],
  ])('%s なら3設定を一切送らない', async (_case, bindingOverrides, flags) => {
    const id = `gate-${flags.allowPostEdit}-${flags.allowEditMail}-${Object.keys(bindingOverrides).length}`;
    seedForm(id, 'EM_GATE');
    seedFieldMap(id, 'reply-email', 'REMOTE_EMAIL');
    const calls = stubFormaloo();
    const res = await call('PUT', `/api/forms-advanced/${id}`, {
      fields: [field], logic: [], ...flags, editMailFieldId: 'reply-email',
    }, env(bindingOverrides));
    expect(res.status).toBe(200);
    for (const call of calls) {
      const serialized = JSON.stringify(call.body ?? {});
      for (const key of receiptKeys) expect(serialized).not.toContain(key);
    }
  });
});
