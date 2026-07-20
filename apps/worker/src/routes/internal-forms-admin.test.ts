import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createRole, jstNow, setRolePermissions } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooInstantWebhook } from './formaloo-instant-webhook.js';
import { formsAdvanced } from './forms-advanced.js';
import { internalFormsAdmin } from './internal-forms-admin.js';
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
    const statements = readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

const DEFINITION = {
  fields: [
    { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
    { id: 'contact', type: 'email', label: 'メール', required: false, position: 1, config: {} },
  ],
  logic: [],
};

let raw: Database.Database;
let DB: D1Database;
let bindingOverrides: Partial<Env['Bindings']>;

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
    FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE: 'true',
    ...bindingOverrides,
  } as Env['Bindings'];
}

function app(withInternalRouter = true) {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  if (withInternalRouter) hono.route('/', internalFormsAdmin);
  hono.route('/', formsAdvanced);
  hono.route('/', formalooInstantWebhook);
  return hono;
}

const OWNER = 'Bearer owner-key';
function call(
  method: string,
  path: string,
  body?: unknown,
  options: { auth?: string; withInternalRouter?: boolean } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== '') headers.Authorization = options.auth ?? OWNER;
  return app(options.withInternalRouter ?? true).request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(
  id: string,
  backend: 'formaloo' | 'internal' | 'db-default' = 'internal',
  options: { deleted?: number; definition?: unknown } = {},
) {
  if (backend === 'db-default') {
    raw.prepare(
      `INSERT INTO formaloo_forms (id, formaloo_slug, title, definition_json, builder_status, deleted)
       VALUES (?, ?, ?, ?, 'published', ?)`,
    ).run(id, `slug_${id}`, 'テスト', JSON.stringify(options.definition ?? DEFINITION), options.deleted ?? 0);
    return;
  }
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, formaloo_slug, title, definition_json, builder_status, render_backend, deleted)
     VALUES (?, ?, ?, ?, 'published', ?, ?)`,
  ).run(id, `slug_${id}`, 'テスト', JSON.stringify(options.definition ?? DEFINITION), backend, options.deleted ?? 0);
}

function seedFriend(id: string) {
  raw.prepare('INSERT INTO friends (id, line_user_id, display_name) VALUES (?, ?, ?)')
    .run(id, `U_${id}`, '友だち');
}

function seedInternalSubmission(
  id: string,
  formId: string,
  answers: Record<string, unknown>,
  submittedAt: string,
  friendId: string | null = null,
) {
  raw.prepare(
    `INSERT INTO internal_form_submissions
       (id, form_id, friend_id, answers_json, submitted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, formId, friendId, JSON.stringify(answers), submittedAt, submittedAt);
}

function seedFormalooSubmission(id: string, formId: string) {
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, formId, JSON.stringify({ name: '既存回答' }), '2026-07-01T10:00:00+09:00');
}

function seedStaff(id: string, apiKey: string, roleId: string) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members
       (id, name, email, role, api_key, is_active, created_at, updated_at, role_id)
     VALUES (?, ?, NULL, 'staff', ?, 1, ?, ?, ?)`,
  ).run(id, id, apiKey, now, now, roleId);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  bindingOverrides = {};
});

afterEach(() => {
  raw.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('internal form render backend selector', () => {
  test('GET observes the DB default as formaloo and PATCH switches only the local enum', async () => {
    seedForm('default-form', 'db-default');
    const externalFetch = vi.fn(async () => { throw new Error('external fetch must not run'); });
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'unused', FORMALOO_API_SECRET: 'unused' };

    const initial = await call('GET', '/api/forms-advanced/default-form/render-backend');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ success: true, data: { renderBackend: 'formaloo' } });

    const patched = await call('PATCH', '/api/forms-advanced/default-form/render-backend', {
      renderBackend: 'internal',
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ success: true, data: { renderBackend: 'internal' } });
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('default-form'))
      .toEqual({ render_backend: 'internal' });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test('invalid enum is 400 without mutation; missing and deleted forms are 404', async () => {
    seedForm('valid-form', 'formaloo');
    seedForm('deleted-form', 'internal', { deleted: 1 });

    const invalid = await call('PATCH', '/api/forms-advanced/valid-form/render-backend', {
      renderBackend: 'other',
    });
    expect(invalid.status).toBe(400);
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('valid-form'))
      .toEqual({ render_backend: 'formaloo' });

    for (const id of ['missing-form', 'deleted-form']) {
      expect((await call('GET', `/api/forms-advanced/${id}/render-backend`)).status).toBe(404);
      expect((await call('PATCH', `/api/forms-advanced/${id}/render-backend`, {
        renderBackend: 'internal',
      })).status).toBe(404);
    }
  });
});

describe('internal answer admin read path', () => {
  beforeEach(() => {
    seedForm('internal-form', 'internal');
    seedForm('other-internal-form', 'internal');
    seedFriend('friend-1');
    seedInternalSubmission('sub-1', 'internal-form', { name: '一郎', contact: 'one@example.test' }, '2026-07-01T09:00:00+09:00');
    seedInternalSubmission('sub-2', 'internal-form', { name: '二郎', contact: 'two@example.test' }, '2026-07-01T10:00:00+09:00', 'friend-1');
    seedInternalSubmission('sub-3', 'internal-form', { name: '三郎', contact: '' }, '2026-07-02T11:00:00+09:00');
  });

  test('list paginates in existing RowsPage shape and maps field ids to labels', async () => {
    const externalFetch = vi.fn(async () => { throw new Error('external fetch must not run'); });
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'unused', FORMALOO_API_SECRET: 'unused' };

    const response = await call('GET', '/api/forms-advanced/internal-form/rows?page=1&pageSize=2');
    expect(response.status).toBe(200);
    const data = (await response.json() as {
      data: {
        rows: Array<{ id: string; friendId: string | null; verified: boolean }>;
        fields: Array<{ slug: string; label: string }>;
        total: number;
        page: number;
        pageSize: number;
      };
    }).data;
    expect(data).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(data.fields).toEqual([
      { slug: 'name', label: 'お名前' },
      { slug: 'contact', label: 'メール' },
    ]);
    expect(data.rows.map((row) => row.id)).toEqual(['sub-3', 'sub-2']);
    expect(data.rows[1]).toMatchObject({ friendId: 'friend-1', verified: true });
    expect(data.rows[0]).toMatchObject({ friendId: null, verified: false });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test('list honors the existing q/from/to/sort controls with a filtered total', async () => {
    const searched = await call(
      'GET',
      `/api/forms-advanced/internal-form/rows?q=${encodeURIComponent('二郎')}&sort=asc&page=1&pageSize=25`,
    );
    expect(searched.status).toBe(200);
    expect((await searched.json() as { data: { rows: Array<{ id: string }>; total: number } }).data)
      .toMatchObject({ rows: [{ id: 'sub-2' }], total: 1 });

    const ranged = await call(
      'GET',
      `/api/forms-advanced/internal-form/rows?from=${encodeURIComponent('2026-07-01T09:30:00+09:00')}&to=${encodeURIComponent('2026-07-02T11:00:00+09:00')}&sort=asc&page=1&pageSize=25`,
    );
    expect(ranged.status).toBe(200);
    const rangeData = (await ranged.json() as { data: { rows: Array<{ id: string }>; total: number } }).data;
    expect(rangeData.total).toBe(2);
    expect(rangeData.rows.map((row) => row.id)).toEqual(['sub-2', 'sub-3']);
  });

  test('detail is local-only, non-editable, and scoped to the selected form', async () => {
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-2');
    expect(response.status).toBe(200);
    const data = (await response.json() as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      id: 'sub-2',
      friendId: 'friend-1',
      verified: true,
      source: 'internal',
      allowPostEdit: 0,
      lastEdit: null,
    });
    expect(data.fields).toEqual([
      { slug: 'name', label: 'お名前', type: 'text', required: true, editable: false },
      { slug: 'contact', label: 'メール', type: 'email', required: false, editable: false },
    ]);
    expect((await call('GET', '/api/forms-advanced/other-internal-form/rows/sub-2')).status).toBe(404);
  });

  test('stats are computed only from internal rows and expose formaloo:null', async () => {
    const response = await call('GET', '/api/forms-advanced/internal-form/stats');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        total: 3,
        verified: 1,
        daily: [
          { day: '2026-07-01', count: 2 },
          { day: '2026-07-02', count: 1 },
        ],
        formaloo: null,
      },
    });
  });
});

describe('internal hosting provider boundary', () => {
  test('share exposes only the published local /f URL without Formaloo, embed, or Sheets data', async () => {
    seedForm('internal-form', 'internal');
    const externalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = {
      WORKER_URL: 'https://internal.example.test/base/',
      FORMALOO_API_KEY: 'must-not-be-used',
      FORMALOO_API_SECRET: 'must-not-be-used',
    };

    const published = await call('GET', '/api/forms-advanced/internal-form/share');
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({
      success: true,
      data: {
        published: true,
        publicUrl: 'https://internal.example.test/base/f/internal-form',
        lineDistUrl: null,
        iframeCode: null,
        scriptCode: null,
        gsheetConnected: false,
        gsheetUrl: null,
      },
    });

    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const draft = await call('GET', '/api/forms-advanced/internal-form/share');
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({
      success: true,
      data: { published: false, publicUrl: null },
    });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', '/api/forms-advanced/internal-form/export.csv', undefined],
    ['POST', '/api/forms-advanced/internal-form/reapply-hosted', undefined],
    ['PATCH', '/api/forms-advanced/internal-form/rows/formaloo-sub', { answers: { name: '変更' } }],
    ['POST', '/api/forms-advanced/internal-form/import', { csv: 'name\n一郎' }],
    ['POST', '/api/forms-advanced/internal-form/rows/bulk-delete', { ids: ['formaloo-sub'] }],
    ['POST', '/api/forms-advanced/internal-form/gsheet/connect', undefined],
    ['PUT', '/api/forms-advanced/internal-form/instant-webhook', { enabled: true }],
  ] as const)('%s %s is 409 before any Formaloo request', async (method, path, body) => {
    seedForm('internal-form', 'internal');
    seedFormalooSubmission('formaloo-sub', 'internal-form');
    raw.prepare("UPDATE formaloo_forms SET allow_post_edit = 1 WHERE id = 'internal-form'").run();
    const externalFetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = {
      FORMALOO_API_KEY: 'must-not-be-used',
      FORMALOO_API_SECRET: 'must-not-be-used',
      FORM_POST_EDIT_ENABLED: 'true',
      WORKER_PUBLIC_URL: 'https://worker.example.test',
    };

    const response = await call(method, path, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: '自前配信では Formaloo 専用操作を利用できません',
    });
    expect(externalFetch).not.toHaveBeenCalled();
  });
});

describe('auth, permission, and Formaloo passthrough regression', () => {
  test('selector remains authenticated and uses the existing forms_advanced permission gate', async () => {
    seedForm('internal-form', 'internal');
    expect((await call('GET', '/api/forms-advanced/internal-form/render-backend', undefined, { auth: '' })).status)
      .toBe(401);

    const roleId = (await createRole(DB, { name: 'フォーム閲覧不可' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('denied-staff', 'denied-key', roleId);
    expect((await call('GET', '/api/forms-advanced/internal-form/render-backend', undefined, {
      auth: 'Bearer denied-key',
    })).status).toBe(403);
  });

  test.each([
    '/api/forms-advanced/formaloo-form/rows?page=1&pageSize=25',
    '/api/forms-advanced/formaloo-form/rows/formaloo-sub',
    '/api/forms-advanced/formaloo-form/stats',
    '/api/forms-advanced/formaloo-form/share',
    '/api/forms-advanced/formaloo-form/export.csv',
  ])('formaloo response status/body is identical with the pre-router: %s', async (path) => {
    seedForm('formaloo-form', 'formaloo');
    seedFormalooSubmission('formaloo-sub', 'formaloo-form');

    const existing = await call('GET', path, undefined, { withInternalRouter: false });
    const existingStatus = existing.status;
    const existingBody = await existing.text();
    const stacked = await call('GET', path);

    expect(stacked.status).toBe(existingStatus);
    expect(await stacked.text()).toBe(existingBody);
  });

  test.each([
    ['POST', '/api/forms-advanced/formaloo-form/reapply-hosted', undefined],
    ['PATCH', '/api/forms-advanced/formaloo-form/rows/formaloo-sub', { answers: { name: '変更' } }],
    ['POST', '/api/forms-advanced/formaloo-form/import', { csv: '' }],
    ['POST', '/api/forms-advanced/formaloo-form/rows/bulk-delete', { ids: [] }],
    ['POST', '/api/forms-advanced/formaloo-form/gsheet/connect', undefined],
    ['PUT', '/api/forms-advanced/formaloo-form/instant-webhook', { enabled: 'invalid' }],
  ] as const)('formaloo mutation response is byte-identical with the pre-router: %s %s', async (method, path, body) => {
    seedForm('formaloo-form', 'formaloo');
    seedFormalooSubmission('formaloo-sub', 'formaloo-form');

    const existing = await call(method, path, body, { withInternalRouter: false });
    const existingStatus = existing.status;
    const existingBody = await existing.text();
    const stacked = await call(method, path, body);

    expect(stacked.status).toBe(existingStatus);
    expect(await stacked.text()).toBe(existingBody);
  });

  test('index mounts the pre-router before formsAdvanced', () => {
    const source = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    const preRouterMount = source.indexOf("app.route('/', internalFormsAdmin);");
    const formalooMount = source.indexOf("app.route('/', formsAdvanced);");
    expect(preRouterMount).toBeGreaterThan(-1);
    expect(preRouterMount).toBeLessThan(formalooMount);
  });
});
