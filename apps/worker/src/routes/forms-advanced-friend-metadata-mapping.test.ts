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
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'mapping-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'mapping-api-key', FORMALOO_API_SECRET: 'mapping-api-secret',
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
    headers: { Authorization: 'Bearer mapping-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

interface RemoteCall { body: unknown }
function stubFormaloo(): RemoteCall[] {
  const calls: RemoteCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ body });
    if (url.includes('/oauth2/authorization-token/')) return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    return new Response(JSON.stringify({ data: { form: body ?? {}, field: {} } }), { status: 200 });
  }));
  return calls;
}

function seedForm(id: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug)
     VALUES (?, '入金フォーム', '{"fields":[],"logic":[]}', 'FORM_PAY')`,
  ).run(id);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => vi.unstubAllGlobals());

describe('PUT/GET forms-advanced — friend metadata mappings', () => {
  test('未設定 GET は []、PUT は canonical mapping を保存して再表示する', async () => {
    seedForm('fm1');
    const initial = (await (await call('GET', '/api/forms-advanced/fm1')).json()) as { data: { friendMetadataMappings?: unknown } };
    expect(initial.data.friendMetadataMappings).toEqual([]);

    stubFormaloo();
    const mappings = [{ formalooFieldKey: ' BjEp0J2J ', friendMetadataKey: ' 入金確認 ' }];
    const put = await call('PUT', '/api/forms-advanced/fm1', { fields: [], logic: [], friendMetadataMappings: mappings });
    expect(put.status).toBe(200);
    const saved = raw.prepare('SELECT friend_metadata_mappings_json AS value FROM formaloo_forms WHERE id=?').get('fm1') as { value: string };
    expect(JSON.parse(saved.value)).toEqual([{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' }]);
    const response = (await put.json()) as { data: { friendMetadataMappings: unknown } };
    expect(response.data.friendMetadataMappings).toEqual(JSON.parse(saved.value));
  });

  test('mapping 未指定の後続 PUT は既存設定を保持する', async () => {
    seedForm('fm2');
    stubFormaloo();
    const mappings = [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' }];
    await call('PUT', '/api/forms-advanced/fm2', { fields: [], logic: [], friendMetadataMappings: mappings });
    await call('PUT', '/api/forms-advanced/fm2', { fields: [], logic: [], title: '改題' });
    const saved = raw.prepare('SELECT friend_metadata_mappings_json AS value FROM formaloo_forms WHERE id=?').get('fm2') as { value: string };
    expect(JSON.parse(saved.value)).toEqual(mappings);
  });

  test('空値・重複 target は 400 で、Formaloo へ送らない', async () => {
    seedForm('fm3');
    const calls = stubFormaloo();
    const response = await call('PUT', '/api/forms-advanced/fm3', {
      fields: [], logic: [],
      friendMetadataMappings: [
        { formalooFieldKey: 'a', friendMetadataKey: '入金確認' },
        { formalooFieldKey: 'b', friendMetadataKey: '入金確認' },
      ],
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('local mapping は Formaloo API body に混ざらない', async () => {
    seedForm('fm4');
    const calls = stubFormaloo();
    await call('PUT', '/api/forms-advanced/fm4', {
      fields: [], logic: [],
      friendMetadataMappings: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' }],
    });
    for (const remoteCall of calls) {
      expect(JSON.stringify(remoteCall.body ?? {})).not.toMatch(/friendMetadata|BjEp0J2J|入金確認/);
    }
  });
});
