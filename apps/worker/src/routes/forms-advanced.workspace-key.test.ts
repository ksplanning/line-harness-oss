/**
 * T-B3 ⑤ (F6-2 / Codex M#10) — 7 call site が form.workspace_id で鍵解決する個別テーブルテスト。
 *   7 route = PUT/:id(push) / GET/:id/pull / GET/:id/rows/:rowId / GET/:id/stats /
 *             POST/:id/import / POST/:id/rows/bulk-delete / POST/:id/gsheet/connect。
 *   各 route を 3 ケースで検証:
 *     (a) form.workspace_id=登録 active → 復号済 workspace 鍵で Formaloo を叩く (env 鍵でない)。
 *     (b) form.workspace_id=NULL(legacy) → env 単一鍵 fallback (byte-equivalent)。
 *     (c) form.workspace_id=未登録/無効 → resolver null → 各 route の既存 fail-soft 応答 + state 副作用が
 *         byte-equivalent (Formaloo を一切叩かない = env silent fallback しない / 特に bulk-delete/gsheet/import)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { encryptSecret, formalooFieldAad } from '../services/formaloo-crypto.js';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const KEK = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
const WS_KEY = 'ws-decrypted-key';
const ENV_KEY = 'env-key';

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

function envBindings(over: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    // 多鍵解決に必要な env: env 単一鍵 (fallback 経路) + KEK (登録 workspace 復号)。
    FORMALOO_API_KEY: ENV_KEY, FORMALOO_API_SECRET: 'env-secret', FORMALOO_KEK: KEK,
    ...over,
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formsAdvanced);
  return a;
}
const OWNER = 'Bearer env-owner-key';
function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, envBindings());
}

async function seedWorkspace(id: string) {
  const kc = await encryptSecret(KEK, WS_KEY, formalooFieldAad(id, 'key'));
  const sc = await encryptSecret(KEK, 'ws-secret', formalooFieldAad(id, 'secret'));
  raw.prepare(
    `INSERT INTO formaloo_workspaces (id, label, key_ciphertext, key_iv, secret_ciphertext, secret_iv)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, 'L', kc.ciphertext, kc.iv, sc.ciphertext, sc.iv);
}

/** workspace_id + slug + fields を持つ form を seed。 */
function seedForm(id: string, workspaceId: string | null, slug: string | null = 'the_slug') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug, workspace_id, builder_status)
     VALUES (?,?,?,?,?,'published')`,
  ).run(id, 'T', JSON.stringify({ fields: [], logic: [], formalooAddress: 'https://demo-forms.formaloo.me/f/a' }), slug, workspaceId);
}
function seedSubmission(id: string, formId: string) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, friend_id, answers_json, submitted_at, formaloo_row_slug) VALUES (?,?,?,?,?,?)`,
  ).run(id, formId, null, '{"a":1}', now, id);
}

/** globalThis.fetch を stub し、Formaloo への各呼び出しの x-api-key を記録する。 */
function stubFetch() {
  const keys: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['x-api-key']) keys.push(headers['x-api-key']);
    if (String(url).includes('authorization-token')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    }
    // bulk-delete の persist 確認: form-nested の row detail とは別 endpoint。削除済みを 404 で返す。
    if ((init?.method ?? 'GET') === 'GET' && String(url).endsWith('/v3.0/rows/sub1/')) {
      return new Response(JSON.stringify({ detail: 'Not found.' }), { status: 404 });
    }
    // form detail (pull) は form.fields_list を期待するので最小の空 form を返す。他は空 data。
    return new Response(JSON.stringify({ data: { form: { slug: 'the_slug', fields_list: [], logic: { rules: [] } } } }), { status: 200 });
  }));
  return { keys };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => vi.unstubAllGlobals());

// 各 route を叩く関数 (client が非 null のとき Formaloo を叩く経路)。
const ROUTES: Array<{ name: string; run: (id: string) => Promise<Response>; needsSubmission?: boolean }> = [
  { name: 'PUT /:id (push)', run: (id) => call('PUT', `/api/forms-advanced/${id}`, { fields: [{ id: 'h1', type: 'text', label: '名', required: false, config: {} }], logic: [] }) },
  { name: 'GET /:id/pull', run: (id) => call('GET', `/api/forms-advanced/${id}/pull`) },
  { name: 'GET /:id/rows/:rowId', run: (id) => call('GET', `/api/forms-advanced/${id}/rows/sub1`), needsSubmission: true },
  { name: 'GET /:id/stats', run: (id) => call('GET', `/api/forms-advanced/${id}/stats`) },
  { name: 'POST /:id/import', run: (id) => call('POST', `/api/forms-advanced/${id}/import`, { csv: 'name\nfoo' }) },
  { name: 'POST /:id/rows/bulk-delete', run: (id) => call('POST', `/api/forms-advanced/${id}/rows/bulk-delete`, { ids: ['sub1'] }), needsSubmission: true },
  { name: 'POST /:id/gsheet/connect', run: (id) => call('POST', `/api/forms-advanced/${id}/gsheet/connect`) },
];

describe('(a) form.workspace_id=登録 active → 復号済 workspace 鍵を使う (env 鍵でない)', () => {
  for (const r of ROUTES) {
    test(r.name, async () => {
      await seedWorkspace('fw_1');
      seedForm('fa1', 'fw_1');
      if (r.needsSubmission) seedSubmission('sub1', 'fa1');
      const { keys } = stubFetch();
      const res = await r.run('fa1');
      expect(res.status).toBe(200);
      // Formaloo を叩いており、その x-api-key は復号済 workspace 鍵 (env 鍵でない)。
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain(WS_KEY);
      expect(keys).not.toContain(ENV_KEY);
    });
  }
});

describe('(b) form.workspace_id=NULL(legacy) → env 単一鍵 fallback (byte-equivalent)', () => {
  for (const r of ROUTES) {
    test(r.name, async () => {
      seedForm('fa1', null);
      if (r.needsSubmission) seedSubmission('sub1', 'fa1');
      const { keys } = stubFetch();
      const res = await r.run('fa1');
      expect(res.status).toBe(200);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toContain(ENV_KEY); // env 鍵で動く (legacy 挙動不変)
      expect(keys).not.toContain(WS_KEY);
    });
  }
});

describe('(c) form.workspace_id=未登録 → resolver null → fail-soft + Formaloo 非接触 (env silent fallback しない)', () => {
  for (const r of ROUTES) {
    test(r.name, async () => {
      seedForm('fa1', 'fw_ghost'); // 未登録 workspace → resolver null
      if (r.needsSubmission) seedSubmission('sub1', 'fa1');
      const { keys } = stubFetch();
      const res = await r.run('fa1');
      // どの route も 200 (fail-soft・500 にしない)。
      expect(res.status).toBe(200);
      // client=null なので Formaloo を一切叩かない (env 鍵へも落ちない = 誤送信防止の要)。
      expect(keys).not.toContain(ENV_KEY);
      expect(keys).not.toContain(WS_KEY);
    });
  }

  test('bulk-delete: client null でも mirror 削除は byte-equivalent に確定する', async () => {
    seedForm('fa1', 'fw_ghost');
    seedSubmission('sub1', 'fa1');
    seedSubmission('sub2', 'fa1');
    stubFetch();
    const res = await call('POST', '/api/forms-advanced/fa1/rows/bulk-delete', { ids: ['sub1', 'sub2'] });
    const d = (await res.json() as { data: { deleted: number } }).data;
    expect(d.deleted).toBe(2); // Formaloo 未接続でも local mirror 削除は確定 (既存契約)
    const remain = (raw.prepare(`SELECT COUNT(*) n FROM formaloo_submissions WHERE form_id='fa1'`).get() as { n: number }).n;
    expect(remain).toBe(0);
  });

  test('gsheet/connect: client null で connected=false を state に記録 (byte-equivalent)', async () => {
    seedForm('fa1', 'fw_ghost');
    stubFetch();
    const res = await call('POST', '/api/forms-advanced/fa1/gsheet/connect');
    const d = (await res.json() as { data: { connected: boolean } }).data;
    expect(d.connected).toBe(false);
    const row = raw.prepare(`SELECT gsheet_connected g FROM formaloo_forms WHERE id='fa1'`).get() as { g: number };
    expect(row.g).toBe(0);
  });

  test('import: client null で pushed=false + note (byte-equivalent)', async () => {
    seedForm('fa1', 'fw_ghost');
    stubFetch();
    const res = await call('POST', '/api/forms-advanced/fa1/import', { csv: 'name\nfoo' });
    const d = (await res.json() as { data: { pushed: boolean; note: string } }).data;
    expect(d.pushed).toBe(false);
    expect(d.note).toContain('未設定');
  });

  test('PUT push: client null で out_of_sync に落ちローカル保存は維持 (byte-equivalent)', async () => {
    seedForm('fa1', 'fw_ghost');
    stubFetch();
    const res = await call('PUT', '/api/forms-advanced/fa1', { fields: [{ id: 'h1', type: 'text', label: '名', required: false, config: {} }], logic: [] });
    const d = (await res.json() as { data: { syncStatus: string; fields: unknown[] } }).data;
    expect(d.syncStatus).toBe('out_of_sync');
    expect(d.fields).toHaveLength(1); // ローカル保存は維持
  });
});
