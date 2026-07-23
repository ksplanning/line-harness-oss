import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(__dirname, '../../../../packages/db/bootstrap.sql');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's',
    LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'c',
    LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls',
    WORKER_URL: 'https://api.example.test',
    FORMALOO_API_KEY: 'api-key',
    FORMALOO_API_SECRET: 'api-secret',
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
    headers: {
      Authorization: 'Bearer owner-key',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, legacyTagId: string | null = null) {
  if (legacyTagId) {
    raw.prepare("INSERT INTO tags (id, name, color) VALUES (?, '旧タグ', '#111111')")
      .run(legacyTagId);
  }
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, title, definition_json, formaloo_slug, on_submit_tag_id)
     VALUES (?, '申込フォーム', '{"fields":[],"logic":[]}', 'FORM_ACTIONS', ?)`,
  ).run(id, legacyTagId);
}

function stubFormaloo() {
  vi.stubGlobal('fetch', vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : {};
    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { form: body, field: {} } }), { status: 200 });
  }));
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
  DB = d1(raw);
});

afterEach(() => {
  raw.close();
  vi.unstubAllGlobals();
});

describe('PUT/GET forms-advanced — ordered submit actions', () => {
  test('legacy onSubmitTagId is returned as one add-tag action', async () => {
    seedForm('legacy-form', 'legacy-tag');

    const response = await call('GET', '/api/forms-advanced/legacy-form');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        onSubmitTagId: 'legacy-tag',
        submitActions: [{ type: 'add_tag', tagId: 'legacy-tag' }],
      },
    });
  });

  test('saves and reloads all four action types in the same order', async () => {
    seedForm('action-form');
    stubFormaloo();
    const submitActions = [
      { type: 'add_tag', tagId: 'tag-a' },
      { type: 'remove_tag', tagId: 'tag-b' },
      { type: 'set_field', fieldId: 'field-a', value: '済' },
      { type: 'clear_field', fieldId: 'field-b' },
    ];

    const put = await call('PUT', '/api/forms-advanced/action-form', {
      fields: [],
      logic: [],
      submitActions,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ data: { submitActions } });
    expect(JSON.parse(raw.prepare(
      "SELECT on_submit_actions_json FROM formaloo_forms WHERE id = 'action-form'",
    ).pluck().get() as string)).toEqual(submitActions);

    const get = await call('GET', '/api/forms-advanced/action-form');
    expect(await get.json()).toMatchObject({ data: { submitActions } });
  });

  test('explicit [] remains empty while an omitted key preserves the saved list', async () => {
    seedForm('delete-form', 'legacy-tag');
    stubFormaloo();
    const submitActions = [{ type: 'remove_tag', tagId: 'legacy-tag' }];
    expect((await call('PUT', '/api/forms-advanced/delete-form', {
      fields: [],
      logic: [],
      submitActions,
    })).status).toBe(200);
    expect((await call('PUT', '/api/forms-advanced/delete-form', {
      fields: [],
      logic: [],
      title: '改題',
    })).status).toBe(200);
    expect(JSON.parse(raw.prepare(
      "SELECT on_submit_actions_json FROM formaloo_forms WHERE id = 'delete-form'",
    ).pluck().get() as string)).toEqual(submitActions);

    expect((await call('PUT', '/api/forms-advanced/delete-form', {
      fields: [],
      logic: [],
      submitActions: [],
    })).status).toBe(200);
    expect((await (await call('GET', '/api/forms-advanced/delete-form')).json()))
      .toMatchObject({ data: { submitActions: [] } });
  });

  test('invalid actions return 400 before provider calls', async () => {
    seedForm('invalid-form');
    stubFormaloo();

    const response = await call('PUT', '/api/forms-advanced/invalid-form', {
      fields: [],
      logic: [],
      submitActions: [{ type: 'set_field', fieldId: 'field-a' }],
    });

    expect(response.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
