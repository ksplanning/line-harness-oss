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

const FIELD = {
  id: 'copied-name',
  type: 'text',
  label: '氏名',
  required: true,
  position: 0,
  config: { placeholder: '山田 花子' },
};

const COPIED_DEFINITION = {
  fields: [FIELD],
  logic: [],
  design: {
    backgroundColor: '#FFFFFF',
    buttonColor: '#06C755',
  },
  formType: 'multi_step',
  formCopy: {
    buttonText: '申し込む',
    successMessage: '受付しました',
  },
  localizationJa: true,
  formRedirect: {
    url: 'https://example.com/thanks',
  },
  successPages: [{
    id: 'copied-success',
    title: '完了',
    description: 'お申し込みありがとうございます',
  }],
  operationsSettings: {
    hasRecaptcha: true,
    maxSubmitCount: 100,
  },
};

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try {
        db.exec(sql);
      } catch (error) {
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
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: 'first-sync-owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    FORMALOO_API_KEY: 'first-sync-formaloo-key',
    FORMALOO_API_SECRET: 'first-sync-formaloo-secret',
    FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE: '1',
    FORMALOO_FIELD_ALIAS_AUTOSET_DISABLE: '1',
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
      Authorization: 'Bearer first-sync-owner-key',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedCopiedForm(
  id: string,
  formalooSlug: string | null,
  definition: Record<string, unknown> = COPIED_DEFINITION,
  fieldSlug: string | null = null,
) {
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, formaloo_slug, title, description, definition_json, builder_status)
     VALUES (?, ?, '初回同期フォーム のコピー', '説明', ?, 'draft')`,
  ).run(id, formalooSlug, JSON.stringify(definition));
  raw.prepare(
    `INSERT INTO formaloo_field_map
       (id, form_id, formaloo_field_slug, field_type, label, position, config_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    FIELD.id,
    id,
    fieldSlug,
    FIELD.type,
    FIELD.label,
    FIELD.position,
    JSON.stringify(FIELD.config),
  );
}

function readDefinition(id: string): Record<string, unknown> {
  const row = raw.prepare(
    'SELECT definition_json AS definition FROM formaloo_forms WHERE id = ?',
  ).get(id) as { definition: string };
  return JSON.parse(row.definition) as Record<string, unknown>;
}

interface FormalooCall {
  method: string;
  url: string;
  body: unknown;
}

function stubFormaloo(
  createdSlug = 'COPY_FORM',
  options: { failFirstFormType?: boolean } = {},
) {
  const calls: FormalooCall[] = [];
  const remoteState: Record<string, unknown> = { fields_list: [] };
  let formTypeFailed = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (!(init?.body instanceof FormData)) {
      try {
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = undefined;
      }
    }
    calls.push({ method, url, body });

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'first-sync-jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({
        data: {
          form: {
            slug: createdSlug,
            full_form_address: 'https://formaloo.example.test/copy-form',
          },
        },
      }), { status: 201 });
    }
    if (method === 'POST' && /\/v3\.0\/fields\/success-page\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { field: { slug: 'COPY_SUCCESS' } } }), { status: 201 });
    }
    if (method === 'POST' && /\/v3\.0\/fields\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { field: { slug: 'COPY_NAME' } } }), { status: 201 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      if (
        options.failFirstFormType
        && !formTypeFailed
        && body != null
        && typeof body === 'object'
        && !Array.isArray(body)
        && 'form_type' in body
      ) {
        formTypeFailed = true;
        return new Response(JSON.stringify({ error: 'forced form_type failure' }), { status: 500 });
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        Object.assign(remoteState, body);
      }
      return new Response(JSON.stringify({ data: { form: { ...remoteState } } }), { status: 200 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { ...remoteState } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

function formPatch(calls: FormalooCall[], predicate: (body: Record<string, unknown>) => boolean) {
  return calls.find((entry) => (
    entry.method === 'PATCH'
    && /\/v3\.0\/forms\/[^/]+\/$/.test(entry.url)
    && entry.body != null
    && typeof entry.body === 'object'
    && !Array.isArray(entry.body)
    && predicate(entry.body as Record<string, unknown>)
  ));
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

describe('PUT /api/forms-advanced/:id — 複製フォームの初回 Formaloo 同期', () => {
  test('未操作の保存済み設定も新規 remote form へ一度だけ seed する', async () => {
    seedCopiedForm('copy-first-sync', null);
    const calls = stubFormaloo();

    const response = await call('PUT', '/api/forms-advanced/copy-first-sync', {
      fields: [FIELD],
      logic: [],
      title: '初回同期フォーム のコピー',
      description: '説明',
      // formCopy/design/redirect/localization/successPages/operations は未操作なので absent。
    });

    expect(response.status).toBe(200);
    const data = (await response.json() as {
      data: { syncStatus: string };
    }).data;
    expect(data.syncStatus).toBe('idle');

    const successCreate = calls.find(
      (entry) => entry.method === 'POST' && /\/v3\.0\/fields\/success-page\/$/.test(entry.url),
    );
    expect(successCreate?.body).toMatchObject({
      form: 'COPY_FORM',
      title: '完了',
      description: 'お申し込みありがとうございます',
    });

    expect(formPatch(calls, (body) => body.form_type === 'multi_step')).toBeDefined();

    const settingsPatch = formPatch(calls, (body) => body.button_text === '申し込む')
      ?.body as Record<string, unknown> | undefined;
    expect(settingsPatch).toMatchObject({
      background_color: '{"r":255,"g":255,"b":255,"a":1}',
      button_color: '{"r":6,"g":199,"b":85,"a":1}',
      button_text: '申し込む',
      success_message: '受付しました',
      form_redirects_after_submit: 'https://example.com/thanks',
      has_recaptcha: true,
      max_submit_count: 100,
      localized_content: expect.any(Object),
      customized_texts: expect.any(Object),
    });

    const row = raw.prepare(
      'SELECT formaloo_slug AS slug FROM formaloo_forms WHERE id = ?',
    ).get('copy-first-sync') as { slug: string | null };
    expect(row.slug).toBe('COPY_FORM');
    expect(readDefinition('copy-first-sync').successPages).toEqual([
      expect.objectContaining({ slug: 'COPY_SUCCESS', title: '完了' }),
    ]);
  });

  test('初回 core push が途中失敗しても remote identity を保存し、重複作成せず設定 seed を再試行する', async () => {
    seedCopiedForm('copy-first-retry', null);
    const calls = stubFormaloo('COPY_RETRY', { failFirstFormType: true });
    const requestBody = {
      fields: [FIELD],
      logic: [],
      title: '初回同期フォーム のコピー',
      description: '説明',
    };

    const firstResponse = await call(
      'PUT',
      '/api/forms-advanced/copy-first-retry',
      requestBody,
    );
    expect(firstResponse.status).toBe(200);
    expect((await firstResponse.json() as {
      data: { syncStatus: string };
    }).data.syncStatus).toBe('out_of_sync');

    const created = raw.prepare(
      'SELECT formaloo_slug AS slug FROM formaloo_forms WHERE id = ?',
    ).get('copy-first-retry') as { slug: string | null };
    const mapped = raw.prepare(
      'SELECT formaloo_field_slug AS slug FROM formaloo_field_map WHERE form_id = ? AND id = ?',
    ).get('copy-first-retry', FIELD.id) as { slug: string | null };
    expect(created.slug).toBe('COPY_RETRY');
    expect(mapped.slug).toBe('COPY_NAME');
    expect(readDefinition('copy-first-retry').successPages).toEqual([
      expect.objectContaining({ slug: 'COPY_SUCCESS' }),
    ]);

    const prematureReapply = await call(
      'POST',
      '/api/forms-advanced/copy-first-retry/reapply-hosted',
    );
    expect(prematureReapply.status).toBe(409);

    const secondResponse = await call(
      'PUT',
      '/api/forms-advanced/copy-first-retry',
      requestBody,
    );
    expect(secondResponse.status).toBe(200);
    expect((await secondResponse.json() as {
      data: { syncStatus: string };
    }).data.syncStatus).toBe('idle');

    expect(calls.filter(
      (entry) => entry.method === 'POST' && /\/v3\.0\/forms\/$/.test(entry.url),
    )).toHaveLength(1);
    expect(calls.filter(
      (entry) => entry.method === 'POST' && /\/v3\.0\/fields\/$/.test(entry.url),
    )).toHaveLength(1);
    expect(formPatch(calls, (body) => (
      body.button_text === '申し込む'
      && body.form_redirects_after_submit === 'https://example.com/thanks'
      && body.has_recaptcha === true
    ))).toBeDefined();
  });

  test('既存 remote form では absent 設定を再送しない', async () => {
    const existingDefinition = structuredClone(COPIED_DEFINITION) as Record<string, unknown> & {
      successPages: Array<Record<string, unknown>>;
    };
    existingDefinition.successPages[0]!.slug = 'EXISTING_SUCCESS';
    seedCopiedForm('copy-existing', 'EXISTING_FORM', existingDefinition, 'EXISTING_NAME');
    const calls = stubFormaloo();

    const response = await call('PUT', '/api/forms-advanced/copy-existing', {
      fields: [FIELD],
      logic: [],
      title: '初回同期フォーム のコピー',
      description: '説明',
    });

    expect(response.status).toBe(200);
    expect(calls.some(
      (entry) => entry.method === 'POST' && /\/v3\.0\/fields\/success-page\/$/.test(entry.url),
    )).toBe(false);
    expect(formPatch(calls, (body) => 'form_type' in body)).toBeUndefined();

    const metadataPatch = formPatch(calls, (body) => body.title === '初回同期フォーム のコピー')
      ?.body as Record<string, unknown>;
    for (const key of [
      'background_color',
      'button_color',
      'button_text',
      'success_message',
      'form_redirects_after_submit',
      'has_recaptcha',
      'max_submit_count',
      'localized_content',
      'customized_texts',
    ]) {
      expect(metadataPatch).not.toHaveProperty(key);
    }
  });
});
