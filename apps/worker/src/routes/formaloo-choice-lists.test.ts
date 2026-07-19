import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

interface MockStmt {
  bind(...args: unknown[]): MockStmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api: MockStmt = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    API_KEY: 'owner-key',
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    LIFF_URL: 'https://liff.example.test',
    WORKER_URL: 'https://worker.example.test/',
  } as Env['Bindings'];
}

function request(method: string, path: string, body?: unknown, auth = true, origin?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer owner-key';
  if (origin) headers.Origin = origin;
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, deleted = 0): void {
  raw.prepare("INSERT INTO formaloo_forms (id, title, definition_json, deleted) VALUES (?, ?, '{\"fields\":[],\"logic\":[]}', ?)")
    .run(id, id, deleted);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  seedForm('form_a');
  seedForm('form_b');
  seedForm('form_deleted', 1);
});

describe('choice list route mount and admin CRUD', () => {
  test('real app mounts admin and public routes', () => {
    const routes = app.routes.map((route) => `${route.method} ${route.path}`);
    expect(routes).toContain('GET /api/forms-advanced/:formId/choice-lists');
    expect(routes).toContain('POST /api/forms-advanced/:formId/choice-lists');
    expect(routes).toContain('PATCH /api/forms-advanced/:formId/choice-lists/:listId');
    expect(routes).toContain('DELETE /api/forms-advanced/:formId/choice-lists/:listId');
    expect(routes).toContain('GET /formaloo/choices/:formId/:listId');
  });

  test('create/list/update/delete stays scoped to the parent form and returns a server-built sourceUrl', async () => {
    const items = [{ label: '渋谷店', value: 'shibuya' }, { label: '新宿店', value: 'shinjuku' }];
    const created = await request('POST', '/api/forms-advanced/form_a/choice-lists', { name: '店舗', items });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; name: string; items: typeof items; sourceUrl: string } };
    expect(createdBody.data).toMatchObject({ name: '店舗', items });
    expect(createdBody.data.id).toMatch(/^fcl_/);
    expect(createdBody.data.sourceUrl).toBe(
      `https://worker.example.test/formaloo/choices/form_a/${createdBody.data.id}`,
    );

    const listed = await request('GET', '/api/forms-advanced/form_a/choice-lists');
    expect(listed.status).toBe(200);
    expect((await listed.json() as { data: Array<{ id: string }> }).data.map((item) => item.id)).toEqual([createdBody.data.id]);

    const crossForm = await request('PATCH', `/api/forms-advanced/form_b/choice-lists/${createdBody.data.id}`, { name: '越境' });
    expect(crossForm.status).toBe(404);

    const updatedItems = [...items, { label: '横浜店', value: 'yokohama' }];
    const updated = await request('PATCH', `/api/forms-advanced/form_a/choice-lists/${createdBody.data.id}`, {
      name: '予約店舗', items: updatedItems,
    });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { data: { name: string; items: typeof updatedItems } }).data)
      .toMatchObject({ name: '予約店舗', items: updatedItems });

    expect((await request('DELETE', `/api/forms-advanced/form_b/choice-lists/${createdBody.data.id}`)).status).toBe(404);
    expect((await request('DELETE', `/api/forms-advanced/form_a/choice-lists/${createdBody.data.id}`)).status).toBe(200);
    expect((raw.prepare('SELECT COUNT(*) AS count FROM formaloo_choice_lists').get() as { count: number }).count).toBe(0);
  });

  test('admin route validates parent/name/items and remains authenticated', async () => {
    expect((await request('POST', '/api/forms-advanced/missing/choice-lists', { name: 'x', items: [] })).status).toBe(404);
    expect((await request('POST', '/api/forms-advanced/form_deleted/choice-lists', { name: 'x', items: [] })).status).toBe(404);
    expect((await request('POST', '/api/forms-advanced/form_a/choice-lists', { name: '', items: [] })).status).toBe(400);
    expect((await request('POST', '/api/forms-advanced/form_a/choice-lists', { name: 'x', items: [{ label: 'A' }] })).status).toBe(400);
    expect((await request('POST', '/api/forms-advanced/form_a/choice-lists', { name: 'x', items: [] }, false)).status).toBe(401);
  });
});

describe('official choice_fetch public GET contract', () => {
  test('returns a raw JSON array of at most 10 {label,value} objects and supports q before limiting', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ label: `店舗${index + 1}`, value: `store-${index + 1}` }));
    items[11] = { label: 'Charlie', value: '3' };
    const created = await request('POST', '/api/forms-advanced/form_a/choice-lists', { name: '店舗', items });
    const list = (await created.json() as { data: { id: string } }).data;

    const publicResponse = await request('GET', `/formaloo/choices/form_a/${list.id}`, undefined, false, 'https://app.formaloo.com');
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('content-type')).toContain('application/json');
    expect(publicResponse.headers.get('access-control-allow-origin')).toBe('*');
    const publicBody = await publicResponse.json() as Array<{ label: string; value: string }>;
    expect(Array.isArray(publicBody)).toBe(true);
    expect(publicBody).toHaveLength(10);
    expect(publicBody[0]).toEqual({ label: '店舗1', value: 'store-1' });
    expect((publicBody as unknown as { success?: unknown }).success).toBeUndefined();

    const searched = await request('GET', `/formaloo/choices/form_a/${list.id}?q=Charlie`, undefined, false);
    expect(await searched.json()).toEqual([{ label: 'Charlie', value: '3' }]);
  });

  test('wrong form, missing list, and deleted parent return 404 without exposing another list', async () => {
    const created = await request('POST', '/api/forms-advanced/form_a/choice-lists', {
      name: '店舗', items: [{ label: 'A', value: 'a' }],
    });
    const id = (await created.json() as { data: { id: string } }).data.id;
    expect((await request('GET', `/formaloo/choices/form_b/${id}`, undefined, false)).status).toBe(404);
    expect((await request('GET', '/formaloo/choices/form_a/fcl_missing', undefined, false)).status).toBe(404);
    raw.prepare("UPDATE formaloo_forms SET deleted=1 WHERE id='form_a'").run();
    expect((await request('GET', `/formaloo/choices/form_a/${id}`, undefined, false)).status).toBe(404);
  });
});
