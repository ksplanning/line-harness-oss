import { readFileSync, readdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createRole, jstNow, setFormalooSyncState, setRolePermissions } from '@line-crm/db';
import type { FormDesignImages, HarnessField } from '@line-crm/shared';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooInstantWebhook } from './formaloo-instant-webhook.js';
import { formsAdvanced } from './forms-advanced.js';
const sheetsSyncMocks = vi.hoisted(() => ({
  syncSheetsAfterFormMutation: vi.fn(),
}));
vi.mock('../services/sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/sheets-sync-jobs.js')>(),
  syncSheetsAfterFormMutation: sheetsSyncMocks.syncSheetsAfterFormMutation,
}));
import { internalFormsAdmin } from './internal-forms-admin.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

type D1MockOptions = {
  maxBindingBytes?: number;
  observedBindingBytes?: number[];
  beforeRun?: (sql: string) => void;
};

function bindingByteLength(value: unknown): number {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
}

function d1(db: Database.Database, options: D1MockOptions = {}): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          const sizes = args.map(bindingByteLength);
          options.observedBindingBytes?.push(...sizes);
          if (options.maxBindingBytes !== undefined && sizes.some((size) => size > options.maxBindingBytes!)) {
            throw new Error(`D1 binding exceeds ${options.maxBindingBytes} bytes`);
          }
          params = args;
          return api;
        },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          options.beforeRun?.(sql);
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

const EDITABLE_DEFINITION = {
  fields: [
    { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
    { id: 'contact', type: 'email', label: 'メール', required: false, position: 1, config: {} },
    { id: 'attachment', type: 'file', label: '添付', required: false, position: 2, config: {} },
    { id: 'signature', type: 'signature', label: '署名', required: false, position: 3, config: {} },
    {
      id: 'matrix', type: 'matrix', label: '評価', required: false, position: 4,
      config: {
        matrixChoiceItems: { good: { title: '良い' } },
        matrixChoiceGroups: [{ title: '接客' }],
      },
    },
    { id: 'repeat_name', type: 'text', label: '参加者名', required: false, position: 5, config: {} },
    {
      id: 'repeat', type: 'repeating_section', label: '参加者', required: false, position: 6,
      config: {
        repeatingColumns: [{ columnField: 'repeat_name', title: '氏名' }],
        minRows: 0,
        maxRows: 3,
      },
    },
    {
      id: 'total', type: 'variable', label: '計算値', required: false, position: 7,
      config: { variableSubType: 'formula', formula: '1+1' },
    },
    {
      id: 'kind', type: 'choice', label: '区分', required: true, position: 8,
      config: { choices: ['個人', '法人'] },
    },
    { id: 'company', type: 'text', label: '会社名', required: true, position: 9, config: {} },
  ],
  logic: [
    {
      id: 'show-company', sourceFieldId: 'kind', operator: 'equals', value: '法人',
      action: 'show', targetFieldId: 'company',
    },
  ],
};

const ADMIN_ATTACHMENT_DEFINITION = {
  ...EDITABLE_DEFINITION,
  fields: EDITABLE_DEFINITION.fields.map((field) => field.id === 'attachment'
    ? {
        ...field,
        config: {
          allowMultipleFiles: true,
          allowedExtensions: ['pdf', 'png'],
          maxSizeKb: 256,
        },
      }
    : field),
};

const D1_BINDING_LIMIT_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('\u0089PNG\r\n\u001a\n', 'latin1');
const TWO_MIB_PNG_DATA_URL = `data:image/png;base64,${Buffer.concat([
  PNG_SIGNATURE,
  Buffer.alloc(2 * 1024 * 1024 - PNG_SIGNATURE.byteLength),
]).toString('base64')}`;
const SMALL_PNG_DATA_URL = `data:image/png;base64,${PNG_SIGNATURE.toString('base64')}`;

type InternalDecorationImagePlacement = `design.${keyof FormDesignImages}` | `field.${Extract<HarnessField['type'], 'image'>}`;
const INTERNAL_DECORATION_IMAGE_PLACEMENTS = [
  'design.logo',
  'design.cover',
  'field.image',
] as const satisfies readonly InternalDecorationImagePlacement[];
type MissingInternalDecorationImagePlacement = Exclude<
  InternalDecorationImagePlacement,
  (typeof INTERNAL_DECORATION_IMAGE_PLACEMENTS)[number]
>;
const ALL_INTERNAL_DECORATION_IMAGE_PLACEMENTS_ARE_COVERED: MissingInternalDecorationImagePlacement extends never
  ? true
  : never = true;

function imageSaveBody(placement: InternalDecorationImagePlacement, dataUrl: string) {
  const fields = placement === 'field.image'
    ? [{
        id: 'hero',
        type: 'image',
        label: 'ヘッダー画像',
        required: false,
        position: 0,
        config: {
          imageWidth: 'full',
          imageUpload: { intent: 'replace', dataUrl, mimeType: 'image/png', filename: 'hero.png' },
        },
      }]
    : DEFINITION.fields;
  const designImages = placement === 'design.logo'
    ? { logo: { intent: 'replace', dataUrl, mimeType: 'image/png', filename: 'logo.png' } }
    : placement === 'design.cover'
      ? { cover: { intent: 'replace', dataUrl, mimeType: 'image/png', filename: 'background.png' } }
      : undefined;
  return {
    fields,
    logic: [],
    design: { themeColor: '#06C755' },
    ...(designImages ? { designImages } : {}),
  };
}

function storedImageUrl(definition: Record<string, unknown>, placement: InternalDecorationImagePlacement): unknown {
  if (placement === 'design.logo') return (definition.design as Record<string, unknown>)?.logoUrl;
  if (placement === 'design.cover') return (definition.design as Record<string, unknown>)?.backgroundImageUrl;
  const field = (definition.fields as Array<{ config?: Record<string, unknown> }>)[0];
  return field?.config?.imageUrl;
}

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
  options: { auth?: string; withInternalRouter?: boolean; expectedBackend?: 'formaloo' | 'internal' } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== '') headers.Authorization = options.auth ?? OWNER;
  if (options.expectedBackend) headers['X-Form-Render-Backend'] = options.expectedBackend;
  return app(options.withInternalRouter ?? true).request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function adminEditFormData(
  context: { editVersion: number; answerRevision: string },
  answers: Record<string, unknown>,
  options: {
    additions?: Record<number, File[]>;
    fieldIds?: Record<number, string>;
    removals?: Record<number, string[]>;
  } = {},
): FormData {
  const body = new FormData();
  body.set('editVersion', String(context.editVersion));
  body.set('answerRevision', context.answerRevision);
  body.set('answers', JSON.stringify(answers));
  for (const [fieldIndex, fieldId] of Object.entries(options.fieldIds ?? {})) {
    body.set(`attachment_field_${fieldIndex}`, fieldId);
  }
  for (const [fieldIndex, indexes] of Object.entries(options.removals ?? {})) {
    for (const index of indexes) body.append(`remove_a_${fieldIndex}`, index);
  }
  for (const [fieldIndex, files] of Object.entries(options.additions ?? {})) {
    for (const file of files) body.append(`a_${fieldIndex}`, file);
  }
  return body;
}

function callAdminEditFormData(
  path: string,
  body: FormData,
  options: { auth?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.auth !== '') headers.Authorization = options.auth ?? OWNER;
  return app().request(path, { method: 'PATCH', headers, body }, env());
}

function forceInternalAnswerUpdateConflict(): void {
  const base = DB;
  DB = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      if (!/UPDATE internal_form_submissions[\s\S]*SET answers_json = \?, edit_version = edit_version \+ 1/i.test(sql)) {
        return statement;
      }
      const wrapped = {
        bind(..._values: unknown[]) { return wrapped; },
        async first() { return null; },
      };
      return wrapped;
    },
  } as unknown as D1Database;
}

async function internalEditContext(formId: string, rowId: string): Promise<{
  editVersion: number;
  answerRevision: string;
}> {
  const response = await call('GET', `/api/forms-advanced/${formId}/rows/${rowId}`);
  expect(response.status).toBe(200);
  return (await response.json() as {
    data: { editVersion: number; answerRevision: string };
  }).data;
}

async function currentPublishRevision(id: string): Promise<string> {
  const response = await call('GET', `/api/forms-advanced/${id}`);
  const json = await response.json() as { data?: { publishRevision?: unknown } };
  expect(response.status).toBe(200);
  expect(typeof json.data?.publishRevision).toBe('string');
  return json.data!.publishRevision as string;
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

function beforeFormalooSaveClaim(callback: () => void): void {
  const base = DB;
  let called = false;
  DB = {
    prepare(sql: string) {
      if (!sql.includes('INSERT') || !sql.includes('formaloo_sync_state')) return base.prepare(sql);
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async run() {
          if (!called) {
            called = true;
            callback();
          }
          return base.prepare(sql).bind(...params).run();
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function failFormReadAfterStatusCommit(status: 'published' | 'draft'): void {
  const base = DB;
  let published = false;
  DB = {
    prepare(sql: string) {
      if (published && /SELECT \* FROM formaloo_forms WHERE id = \?/i.test(sql)) {
        throw new Error('injected post-commit read failure');
      }
      const statement = base.prepare(sql);
      const literalPublish = /UPDATE formaloo_forms[\s\S]*builder_status = 'published'/i.test(sql);
      const literalDraft = /UPDATE formaloo_forms[\s\S]*builder_status = 'draft'/i.test(sql);
      const parameterizedStatus = /UPDATE formaloo_forms[\s\S]*SET builder_status = \?/i.test(sql);
      if (!literalPublish && !literalDraft && !parameterizedStatus) return statement;
      let params: unknown[] = [];
      const wrapped = {
        bind(...values: unknown[]) { params = values; return wrapped; },
        async run() {
          const result = await statement.bind(...params).run();
          if ((result.meta?.changes ?? 0) === 1
            && ((status === 'published' && literalPublish)
              || (status === 'draft' && literalDraft)
              || (parameterizedStatus && params[0] === status))) {
            published = true;
          }
          return result;
        },
      };
      return wrapped;
    },
  } as unknown as D1Database;
}

function afterInternalDefinitionSave(callback: () => void): void {
  const base = DB;
  let called = false;
  DB = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      if (!/UPDATE formaloo_forms[\s\S]*SET definition_json = \?/i.test(sql)) return statement;
      let params: unknown[] = [];
      const wrapped = {
        bind(...values: unknown[]) { params = values; return wrapped; },
        async run() {
          const result = await statement.bind(...params).run();
          if (!called && (result.meta?.changes ?? 0) === 1) {
            called = true;
            callback();
          }
          return result;
        },
      };
      return wrapped;
    },
  } as unknown as D1Database;
}

function beforeInternalUnpublishCommit(callback: () => void): void {
  const base = DB;
  let called = false;
  DB = {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      const literalDraft = /UPDATE formaloo_forms[\s\S]*SET builder_status = 'draft'/i.test(sql);
      const parameterizedStatus = /UPDATE formaloo_forms[\s\S]*SET builder_status = \?/i.test(sql);
      if (!literalDraft && !parameterizedStatus) return statement;
      let params: unknown[] = [];
      const wrapped = {
        bind(...values: unknown[]) { params = values; return wrapped; },
        async run() {
          if (!called && (literalDraft || params[0] === 'draft')) {
            called = true;
            callback();
          }
          return statement.bind(...params).run();
        },
      };
      return wrapped;
    },
  } as unknown as D1Database;
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
  sheetsSyncMocks.syncSheetsAfterFormMutation.mockReset().mockResolvedValue(undefined);
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  bindingOverrides = {};
});

afterEach(() => {
  raw.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('internal form render backend selector', () => {
  test('internal PUT/GET round-trips ordered submit actions including explicit empty', async () => {
    seedForm('internal-actions');
    const submitActions = [
      { type: 'add_tag', tagId: 'tag-a' },
      { type: 'set_field', fieldId: 'field-a', value: '済' },
      { type: 'clear_field', fieldId: 'field-a' },
    ];

    const saved = await call('PUT', '/api/forms-advanced/internal-actions', {
      submitActions,
    }, { expectedBackend: 'internal' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ data: { submitActions } });
    expect(JSON.parse(raw.prepare(
      "SELECT on_submit_actions_json FROM formaloo_forms WHERE id = 'internal-actions'",
    ).pluck().get() as string)).toEqual(submitActions);

    const cleared = await call('PUT', '/api/forms-advanced/internal-actions', {
      submitActions: [],
    }, { expectedBackend: 'internal' });
    expect(cleared.status).toBe(200);
    const reloaded = await call('GET', '/api/forms-advanced/internal-actions');
    expect(await reloaded.json()).toMatchObject({ data: { submitActions: [] } });
  });

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
    expect(await patched.json()).toEqual({
      success: true,
      data: { renderBackend: 'internal', builderStatus: 'draft' },
    });
    expect(raw.prepare(
      'SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('default-form')).toEqual({ render_backend: 'internal', builder_status: 'draft' });
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

  test('rejects a backend switch when the saved definition is incompatible with the destination', async () => {
    seedForm('internal-only-form', 'internal', {
      definition: {
        fields: [{ id: 'appointment', type: 'datetime', label: '日時', required: true, position: 0, config: {} }],
        logic: [],
      },
    });
    seedForm('unsupported-form', 'formaloo', {
      definition: {
        fields: [{
          id: 'remote-options',
          type: 'choice_fetch',
          label: '動的選択肢',
          required: false,
          position: 0,
          config: { choicesSource: 'https://example.test/options' },
        }],
        logic: [],
      },
    });
    seedForm('internal-config-form', 'internal', {
      definition: {
        fields: [{ id: 'name', type: 'text', label: '名前', required: true, position: 0, config: { placeholder: '入力例' } }],
        logic: [],
      },
    });

    const toFormaloo = await call('PATCH', '/api/forms-advanced/internal-only-form/render-backend', {
      renderBackend: 'formaloo',
    });
    expect(toFormaloo.status).toBe(409);
    expect(await toFormaloo.json()).toMatchObject({ error: expect.stringMatching(/切り替えられません/) });

    const toInternal = await call('PATCH', '/api/forms-advanced/unsupported-form/render-backend', {
      renderBackend: 'internal',
    });
    expect(toInternal.status).toBe(409);
    expect(await toInternal.json()).toMatchObject({ error: expect.stringMatching(/切り替えられません/) });

    const configToFormaloo = await call('PATCH', '/api/forms-advanced/internal-config-form/render-backend', {
      renderBackend: 'formaloo',
    });
    expect(configToFormaloo.status).toBe(409);
    expect(await configToFormaloo.json()).toMatchObject({ error: expect.stringMatching(/切り替えられません/) });

    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('internal-only-form'))
      .toEqual({ render_backend: 'internal' });
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('unsupported-form'))
      .toEqual({ render_backend: 'formaloo' });
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('internal-config-form'))
      .toEqual({ render_backend: 'internal' });
  });
});

describe('internal definition save boundary', () => {
  test('2 MiB fixture は logo / cover / image field の全 upload slot を静的列挙する', () => {
    expect(ALL_INTERNAL_DECORATION_IMAGE_PLACEMENTS_ARE_COVERED).toBe(true);
    expect(INTERNAL_DECORATION_IMAGE_PLACEMENTS).toEqual([
      'design.logo',
      'design.cover',
      'field.image',
    ]);
  });

  test.each(INTERNAL_DECORATION_IMAGE_PLACEMENTS)(
    '2 MiB PNG at %s is moved to R2 before every D1 binding',
    async (placement) => {
      seedForm('internal-image-form', 'internal');
      const observedBindingBytes: number[] = [];
      DB = d1(raw, { maxBindingBytes: D1_BINDING_LIMIT_BYTES, observedBindingBytes });
      const puts: Array<{ key: string; size: number }> = [];
      bindingOverrides = {
        IMAGES: {
          put: vi.fn(async (key: string, value: Uint8Array) => {
            puts.push({ key, size: value.byteLength });
          }),
        } as unknown as R2Bucket,
      };

      const response = await call(
        'PUT',
        '/api/forms-advanced/internal-image-form/internal-definition',
        imageSaveBody(placement, TWO_MIB_PNG_DATA_URL),
      );

      expect(response.status).toBe(200);
      expect(puts).toHaveLength(1);
      expect(puts[0].size).toBe(2 * 1024 * 1024);
      const stored = raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
        .get('internal-image-form') as { definition_json: string };
      const definition = JSON.parse(stored.definition_json) as Record<string, unknown>;
      expect(stored.definition_json).not.toContain('data:image');
      expect(storedImageUrl(definition, placement)).toBe(`https://api.example.test/images/${puts[0].key}`);
      expect(Math.max(...observedBindingBytes)).toBeLessThanOrEqual(D1_BINDING_LIMIT_BYTES);
    },
  );

  test('one save resolves all decoration placements and leaves zero data:image bytes in definition_json', async () => {
    seedForm('internal-all-images', 'internal');
    const observedBindingBytes: number[] = [];
    DB = d1(raw, { maxBindingBytes: D1_BINDING_LIMIT_BYTES, observedBindingBytes });
    const puts: Array<{ key: string; size: number }> = [];
    bindingOverrides = {
      IMAGES: {
        put: vi.fn(async (key: string, value: Uint8Array) => {
          puts.push({ key, size: value.byteLength });
        }),
      } as unknown as R2Bucket,
    };
    const fieldBody = imageSaveBody('field.image', TWO_MIB_PNG_DATA_URL);

    const response = await call('PUT', '/api/forms-advanced/internal-all-images/internal-definition', {
      ...fieldBody,
      designImages: {
        logo: { intent: 'replace', dataUrl: TWO_MIB_PNG_DATA_URL, mimeType: 'image/png', filename: 'logo.png' },
        cover: { intent: 'replace', dataUrl: TWO_MIB_PNG_DATA_URL, mimeType: 'image/png', filename: 'background.png' },
      },
    });

    expect(response.status).toBe(200);
    expect(puts).toHaveLength(3);
    expect(puts.map((put) => put.size)).toEqual([2 * 1024 * 1024, 2 * 1024 * 1024, 2 * 1024 * 1024]);
    const stored = raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
      .get('internal-all-images') as { definition_json: string };
    const definition = JSON.parse(stored.definition_json) as Record<string, unknown>;
    expect(stored.definition_json).not.toContain('data:image');
    for (const placement of INTERNAL_DECORATION_IMAGE_PLACEMENTS) {
      expect(storedImageUrl(definition, placement)).toMatch(/^https:\/\/api\.example\.test\/images\/media\/form-image\//);
    }
    expect(Math.max(...observedBindingBytes)).toBeLessThanOrEqual(D1_BINDING_LIMIT_BYTES);
  });

  test.each(INTERNAL_DECORATION_IMAGE_PLACEMENTS)(
    'R2 failure at %s returns an honest 4xx and does not mutate D1',
    async (placement) => {
      seedForm('internal-image-failure', 'internal');
      const before = raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
        .get('internal-image-failure');
      bindingOverrides = {
        IMAGES: {
          put: vi.fn(async () => { throw new Error('secret R2 detail'); }),
        } as unknown as R2Bucket,
      };

      const response = await call(
        'PUT',
        '/api/forms-advanced/internal-image-failure/internal-definition',
        imageSaveBody(placement, SMALL_PNG_DATA_URL),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: '画像の保存に失敗しました (サイズ/形式)',
      });
      expect(raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
        .get('internal-image-failure')).toEqual(before);
    },
  );

  test('a residual data:image value is rejected before D1 and can never survive definition_json', async () => {
    seedForm('internal-residual-image', 'internal', {
      definition: {
        ...DEFINITION,
        design: { logoUrl: SMALL_PNG_DATA_URL },
      },
    });
    const before = raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
      .get('internal-residual-image');

    const response = await call('PUT', '/api/forms-advanced/internal-residual-image/internal-definition', {
      fields: DEFINITION.fields,
      logic: [],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: '画像の保存に失敗しました (サイズ/形式)',
    });
    expect(raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
      .get('internal-residual-image')).toEqual(before);
  });

  test('saves only the local definition, preserves unrelated keys, and ignores stale Formaloo sync state', async () => {
    seedForm('internal-form', 'internal', {
      definition: {
        ...DEFINITION,
        design: { primaryColor: '#06C755' },
        futureInternalSetting: { enabled: true },
        formCopy: { buttonText: '以前の文言' },
        formType: 'simple',
      },
    });
    raw.prepare(
      `INSERT INTO formaloo_field_map
         (id, form_id, formaloo_field_slug, field_type, label, position, config_json)
       VALUES ('name', 'internal-form', 'remote-name', 'text', 'お名前', 0, '{}')`,
    ).run();
    await setFormalooSyncState(DB, 'internal-form', {
      syncStatus: 'out_of_sync',
      lastError: '以前の Formaloo 同期エラー',
    });
    const externalFetch = vi.fn(async () => { throw new Error('Formaloo must not be called'); });
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'must-not-be-used', FORMALOO_API_SECRET: 'must-not-be-used' };

    const nextFields = [
      {
        id: 'name', type: 'text', label: '氏名', required: true, position: 0,
        config: { maxLength: 40, editLocked: true, unknownConfig: 'drop-me' },
      },
      { id: 'memo', type: 'textarea', label: '備考', required: false, position: 1, config: {} },
    ];
    const response = await call('PUT', '/api/forms-advanced/internal-form/internal-definition', {
      fields: nextFields,
      logic: [],
      title: ' 自前フォーム ',
      description: '',
      formCopy: { buttonText: ' 送信する ', successMessage: ' 完了 ', evil: 'drop-me' },
      formType: 'multi_step',
      design: { primaryColor: '#000000' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    const stored = raw.prepare(
      'SELECT title, description, definition_json FROM formaloo_forms WHERE id = ?',
    ).get('internal-form') as { title: string; description: string | null; definition_json: string };
    expect(stored.title).toBe('自前フォーム');
    expect(stored.description).toBeNull();
    expect(JSON.parse(stored.definition_json)).toEqual({
      fields: [
        {
          id: 'name',
          type: 'text',
          label: '氏名',
          required: true,
          position: 0,
          config: { maxLength: 40, editLocked: true },
        },
        { id: 'memo', type: 'textarea', label: '備考', required: false, position: 1, config: {} },
      ],
      logic: [],
      design: { primaryColor: '#06C755' },
      futureInternalSetting: { enabled: true },
      formCopy: { buttonText: '送信する', successMessage: '完了' },
      formType: 'multi_step',
    });
    expect(raw.prepare(
      'SELECT id, formaloo_field_slug, field_type, label, position, config_json FROM formaloo_field_map WHERE form_id = ? ORDER BY position',
    ).all('internal-form')).toEqual([
      {
        id: 'name', formaloo_field_slug: 'remote-name', field_type: 'text', label: '氏名',
        position: 0, config_json: '{"maxLength":40,"editLocked":true}',
      },
      {
        id: 'memo', formaloo_field_slug: null, field_type: 'textarea', label: '備考',
        position: 1, config_json: '{}',
      },
    ]);
    expect(raw.prepare('SELECT sync_status, last_error FROM formaloo_sync_state WHERE form_id = ?').get('internal-form'))
      .toEqual({ sync_status: 'out_of_sync', last_error: '以前の Formaloo 同期エラー' });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test('rejects non-empty logic and unsupported runtime fields without mutating the stored definition', async () => {
    seedForm('internal-form', 'internal');
    const before = raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?')
      .get('internal-form') as { definition_json: string };

    const withLogic = await call('PUT', '/api/forms-advanced/internal-form/internal-definition', {
      fields: DEFINITION.fields,
      logic: [{ id: 'logic-1' }],
    });
    expect(withLogic.status).toBe(400);

    const unsupported = await call('PUT', '/api/forms-advanced/internal-form/internal-definition', {
      fields: [{
        id: 'fetch', type: 'choice_fetch', label: '動的選択肢', required: false, position: 0,
        config: { choicesSource: 'https://example.test/options' },
      }],
      logic: [],
    });
    expect(unsupported.status).toBe(400);
    expect(raw.prepare('SELECT definition_json FROM formaloo_forms WHERE id = ?').get('internal-form'))
      .toEqual(before);
  });

  test('does not handle or mutate a Formaloo-backed form', async () => {
    seedForm('formaloo-form', 'formaloo');
    const before = raw.prepare('SELECT title, definition_json FROM formaloo_forms WHERE id = ?')
      .get('formaloo-form');
    const externalFetch = vi.fn(async () => { throw new Error('Formaloo must not be called'); });
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'must-not-be-used', FORMALOO_API_SECRET: 'must-not-be-used' };

    const response = await call('PUT', '/api/forms-advanced/formaloo-form/internal-definition', {
      fields: [], logic: [], title: '変更してはいけない',
    });

    expect(response.status).toBe(404);
    expect(raw.prepare('SELECT title, definition_json FROM formaloo_forms WHERE id = ?').get('formaloo-form'))
      .toEqual(before);
    expect(externalFetch).not.toHaveBeenCalled();
  });
});

describe('internal form render backend publication guards', () => {
  test('switching a published Formaloo form validates the definition and atomically returns it to draft', async () => {
    seedForm('valid-form', 'formaloo');

    const switched = await call('PATCH', '/api/forms-advanced/valid-form/render-backend', {
      renderBackend: 'internal',
    });

    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      success: true,
      data: { renderBackend: 'internal', builderStatus: 'draft' },
    });
    expect(raw.prepare(
      'SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('valid-form')).toEqual({ render_backend: 'internal', builder_status: 'draft' });
  });

  test('rejects switching an internal form back to Formaloo without a lossless full-sync path', async () => {
    seedForm('internal-live', 'internal');
    const externalFetch = vi.fn(async () => {
      throw new Error('Formaloo must not be called');
    });
    vi.stubGlobal('fetch', externalFetch);

    const switched = await call('PATCH', '/api/forms-advanced/internal-live/render-backend', {
      renderBackend: 'formaloo',
    });

    expect(switched.status).toBe(409);
    expect(await switched.json()).toEqual({
      success: false,
      error: '自前配信で編集した内容を失わないため、Formaloo 配信には戻せません',
    });
    expect(externalFetch).not.toHaveBeenCalled();
    expect(raw.prepare(
      'SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('internal-live')).toEqual({ render_backend: 'internal', builder_status: 'published' });
  });

  test('rejects stale builder mutations after another tab switched the provider', async () => {
    seedForm('now-internal', 'internal');
    const staleFormalooSave = await call('PUT', '/api/forms-advanced/now-internal', {
      title: '古い Formaloo 画面からの保存',
      fields: DEFINITION.fields,
      logic: [],
    }, { expectedBackend: 'formaloo' });
    expect(staleFormalooSave.status).toBe(409);
    expect(raw.prepare('SELECT title, render_backend FROM formaloo_forms WHERE id = ?').get('now-internal'))
      .toEqual({ title: 'テスト', render_backend: 'internal' });

    seedForm('now-formaloo', 'formaloo');
    const staleInternalUnpublish = await call(
      'POST',
      '/api/forms-advanced/now-formaloo/unpublish',
      undefined,
      { expectedBackend: 'internal' },
    );
    expect(staleInternalUnpublish.status).toBe(409);
    expect(raw.prepare('SELECT builder_status, render_backend FROM formaloo_forms WHERE id = ?').get('now-formaloo'))
      .toEqual({ builder_status: 'published', render_backend: 'formaloo' });
  });

  test('does not switch provider while a Formaloo definition save owns the sync claim', async () => {
    seedForm('saving-form', 'formaloo');
    raw.prepare(
      "INSERT INTO formaloo_sync_state (form_id, sync_status) VALUES ('saving-form', 'pushing')",
    ).run();

    const response = await call('PATCH', '/api/forms-advanced/saving-form/render-backend', {
      renderBackend: 'internal',
    });

    expect(response.status).toBe(409);
    expect(raw.prepare(
      'SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('saving-form')).toEqual({ render_backend: 'formaloo', builder_status: 'published' });
  });

  test('does not switch internal-only channel logic to Formaloo where it would be silently lost', async () => {
    seedForm('channel-form', 'internal', { definition: {
      ...DEFINITION,
      logic: [{
        id: 'web-only', sourceFieldId: '__channel__', operator: 'equals', value: 'web',
        action: 'show', targetFieldId: 'contact',
      }],
    } });

    const response = await call('PATCH', '/api/forms-advanced/channel-form/render-backend', {
      renderBackend: 'formaloo',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: '自前配信で編集した内容を失わないため、Formaloo 配信には戻せません',
    });
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('channel-form'))
      .toEqual({ render_backend: 'internal' });
  });

  test('does not switch one-page ordinary-field branching to Formaloo where it only works multi-step', async () => {
    seedForm('one-page-branch', 'internal', { definition: {
      ...DEFINITION,
      formType: 'simple',
      logic: [{
        id: 'show-contact', sourceFieldId: 'name', operator: 'equals', value: 'A',
        action: 'show', targetFieldId: 'contact',
      }],
    } });

    const response = await call('PATCH', '/api/forms-advanced/one-page-branch/render-backend', {
      renderBackend: 'formaloo',
    });

    expect(response.status).toBe(409);
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('one-page-branch'))
      .toEqual({ render_backend: 'internal' });
  });

  test('does not switch one-page terminal submission branching to Formaloo', async () => {
    seedForm('one-page-submit', 'internal', { definition: {
      ...DEFINITION,
      formType: 'simple',
      logic: [{
        id: 'finish-a', sourceFieldId: 'name', operator: 'equals', value: 'A',
        action: 'submit', targetFieldId: 'done-a', terminalTrigger: 'on_answered',
      }],
      successPages: [{ id: 'done-a', title: 'A完了' }],
    } });

    const response = await call('PATCH', '/api/forms-advanced/one-page-submit/render-backend', {
      renderBackend: 'formaloo',
    });

    expect(response.status).toBe(409);
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('one-page-submit'))
      .toEqual({ render_backend: 'internal' });
  });

  test('does not switch compound internal logic to a Formaloo save path that cannot preserve it', async () => {
    seedForm('compound-branch', 'internal', { definition: {
      ...DEFINITION,
      formType: 'multi_step',
      logic: [{
        id: 'compound', sourceFieldId: 'name', operator: 'equals', value: 'A',
        action: 'show', targetFieldId: 'contact', conditionJoin: 'and',
        conditions: [
          { sourceFieldId: 'name', operator: 'equals', value: 'A' },
          { sourceFieldId: 'contact', operator: 'equals', value: 'a@example.com' },
        ],
        actions: [{ action: 'show', targetFieldId: 'contact' }],
      }],
    } });

    const response = await call('PATCH', '/api/forms-advanced/compound-branch/render-backend', {
      renderBackend: 'formaloo',
    });

    expect(response.status).toBe(409);
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('compound-branch'))
      .toEqual({ render_backend: 'internal' });
  });

  test('a Formaloo save that loses the provider claim stops before local mapping or external mutation', async () => {
    seedForm('formaloo-race', 'formaloo');
    const externalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'key', FORMALOO_API_SECRET: 'secret' };
    beforeFormalooSaveClaim(() => {
      raw.prepare(
        "UPDATE formaloo_forms SET render_backend = 'internal', builder_status = 'draft' WHERE id = 'formaloo-race'",
      ).run();
    });

    const response = await call('PUT', '/api/forms-advanced/formaloo-race', {
      title: '競合保存', fields: DEFINITION.fields, logic: [],
    });

    expect(response.status).toBe(409);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM formaloo_field_map WHERE form_id = 'formaloo-race'").get())
      .toEqual({ n: 0 });
    expect(raw.prepare('SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?').get('formaloo-race'))
      .toEqual({ render_backend: 'internal', builder_status: 'draft' });
  });

  test('a Formaloo save that loses its loaded form revision stops before mutation', async () => {
    seedForm('formaloo-stale-save', 'formaloo');
    const externalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'key', FORMALOO_API_SECRET: 'secret' };
    beforeFormalooSaveClaim(() => {
      raw.prepare(
        "UPDATE formaloo_forms SET updated_at = '2099-01-01T00:00:00.000+09:00' WHERE id = 'formaloo-stale-save'",
      ).run();
    });

    const response = await call('PUT', '/api/forms-advanced/formaloo-stale-save', {
      title: '古い保存', fields: DEFINITION.fields, logic: [],
    });

    expect(response.status).toBe(409);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test('does not switch a Formaloo form with an active recurring answer to internal', async () => {
    seedForm('recurring-active', 'formaloo');
    raw.prepare(
      `INSERT INTO formaloo_recurring_submissions
       (id, form_id, idempotency_key, request_fingerprint, schedule_json,
        submission_data_json, status, sync_state)
       VALUES ('frs_switch_guard', 'recurring-active', 'attempt', 'fingerprint', ?, '{}', 'resumed', 'synced')`,
    ).run(JSON.stringify({ interval: {}, start_time: '2026-07-20T00:00:00Z' }));

    const response = await call('PATCH', '/api/forms-advanced/recurring-active/render-backend', {
      renderBackend: 'internal',
    });

    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toContain('定期自動回答');
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('recurring-active'))
      .toEqual({ render_backend: 'formaloo' });
  });

  test('a hosted reapply that loses the provider claim stops before Formaloo mutation', async () => {
    seedForm('reapply-race', 'formaloo');
    const externalFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'key', FORMALOO_API_SECRET: 'secret' };
    beforeFormalooSaveClaim(() => {
      raw.prepare(
        "UPDATE formaloo_forms SET render_backend = 'internal', builder_status = 'draft' WHERE id = 'reapply-race'",
      ).run();
    });

    const response = await call('POST', '/api/forms-advanced/reapply-race/reapply-hosted');

    expect(response.status).toBe(409);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?').get('reapply-race'))
      .toEqual({ render_backend: 'internal', builder_status: 'draft' });
  });

  test('rejects switching an unsupported published definition without exposing it on the internal host', async () => {
    seedForm('unsupported-form', 'formaloo', {
      definition: {
        fields: [{
          id: 'remote-options',
          type: 'choice_fetch',
          label: '動的選択肢',
          required: false,
          position: 0,
          config: { choicesSource: 'https://example.test/options' },
        }],
        logic: [],
      },
    });

    const response = await call('PATCH', '/api/forms-advanced/unsupported-form/render-backend', {
      renderBackend: 'internal',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: '現在のフォーム定義では配信先を切り替えられません: 未対応の項目を含むため自前配信できません',
    });
    expect(raw.prepare(
      'SELECT render_backend, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('unsupported-form')).toEqual({ render_backend: 'formaloo', builder_status: 'published' });
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

  test('filters and approves pending external edits without changing answers or syncing Sheets', async () => {
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:00:00+09:00',
           external_edit_changes_json = ?
       WHERE id = 'sub-1'`,
    ).run(JSON.stringify([
      { fieldId: 'name', before: '変更前', after: '一郎' },
    ]));
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'sheet',
           external_edited_at = '2026-07-23T10:01:00+09:00',
           external_edit_approved_at = '2026-07-23T10:02:00+09:00'
       WHERE id = 'sub-2'`,
    ).run();
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:03:00+09:00',
           external_edit_changes_json = '[]'
       WHERE id = 'sub-3'`,
    ).run();

    const unfiltered = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?page=1&pageSize=25',
    );
    const unfilteredData = (await unfiltered.json() as {
      data: {
        rows: Array<{
          id: string;
          formId: string;
          externalEditSource: string | null;
          externalEditedAt: string | null;
          externalEditApprovedAt: string | null;
          externalEditChanges: Array<{ fieldId: string; before: unknown; after: unknown }>;
        }>;
        total: number;
        externalEditPendingCount: number;
      };
    }).data;
    expect(unfilteredData.total).toBe(3);
    expect(unfilteredData.externalEditPendingCount).toBe(1);
    expect(unfilteredData.rows.find((row) => row.id === 'sub-1')).toMatchObject({
      formId: 'internal-form',
      externalEditSource: 'edit_link',
      externalEditedAt: '2026-07-23T10:00:00+09:00',
      externalEditApprovedAt: null,
      externalEditChanges: [
        { fieldId: 'name', before: '変更前', after: '一郎' },
      ],
    });
    const pendingStats = await call('GET', '/api/forms-advanced/internal-form/stats');
    expect((await pendingStats.json() as { data: { externalEditPending: number } }).data)
      .toMatchObject({ externalEditPending: 1 });

    const filtered = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?externalEdit=pending&page=1&pageSize=25',
    );
    const filteredData = (await filtered.json() as {
      data: {
        rows: Array<{ id: string }>;
        total: number;
        externalEditPendingCount: number;
      };
    }).data;
    expect(filteredData).toMatchObject({
      rows: [{ id: 'sub-1' }],
      total: 1,
      externalEditPendingCount: 1,
    });

    const answersBefore = (raw.prepare(
      `SELECT answers_json FROM internal_form_submissions WHERE id = 'sub-1'`,
    ).get() as { answers_json: string }).answers_json;
    const approved = await call(
      'POST',
      '/api/forms-advanced/internal-form/rows/sub-1/approve-external-edit',
      {
        expectedExternalEditSource: 'edit_link',
        expectedExternalEditedAt: '2026-07-23T10:00:00+09:00',
      },
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      success: true,
      data: {
        id: 'sub-1',
        externalEditSource: 'edit_link',
        externalEditApprovedAt: expect.any(String),
      },
    });
    expect((raw.prepare(
      `SELECT answers_json FROM internal_form_submissions WHERE id = 'sub-1'`,
    ).get() as { answers_json: string }).answers_json).toBe(answersBefore);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();

    const after = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?externalEdit=pending&page=1&pageSize=25',
    );
    expect((await after.json() as {
      data: { rows: unknown[]; total: number; externalEditPendingCount: number };
    }).data).toEqual(expect.objectContaining({
      rows: [],
      total: 0,
      externalEditPendingCount: 0,
    }));
    const stats = await call('GET', '/api/forms-advanced/internal-form/stats');
    expect((await stats.json() as { data: { externalEditPending: number } }).data)
      .toMatchObject({ externalEditPending: 0 });
  });

  test('returns 409 instead of approving an external edit that races the review', async () => {
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:00:00+09:00'
       WHERE id = 'sub-1'`,
    ).run();
    let injectedRace = false;
    DB = d1(raw, {
      beforeRun(sql) {
        if (injectedRace || !sql.includes('SET external_edit_approved_at')) return;
        injectedRace = true;
        raw.prepare(
          `UPDATE internal_form_submissions
           SET answers_json = '{"name":"承認直前の再編集"}',
               external_edit_source = 'sheet',
               external_edited_at = '2026-07-23T10:01:00+09:00',
               external_edit_approved_at = NULL
           WHERE id = 'sub-1'`,
        ).run();
      },
    });

    const response = await call(
      'POST',
      '/api/forms-advanced/internal-form/rows/sub-1/approve-external-edit',
      {
        expectedExternalEditSource: 'edit_link',
        expectedExternalEditedAt: '2026-07-23T10:00:00+09:00',
      },
    );

    expect(response.status).toBe(409);
    expect(injectedRace).toBe(true);
    expect(raw.prepare(
      `SELECT answers_json, external_edit_source, external_edited_at,
              external_edit_approved_at
       FROM internal_form_submissions WHERE id = 'sub-1'`,
    ).get()).toEqual({
      answers_json: '{"name":"承認直前の再編集"}',
      external_edit_source: 'sheet',
      external_edited_at: '2026-07-23T10:01:00+09:00',
      external_edit_approved_at: null,
    });
  });

  test('returns 409 when the browser approves an older displayed external edit', async () => {
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:00:00+09:00'
       WHERE id = 'sub-1'`,
    ).run();
    const displayed = {
      expectedExternalEditSource: 'edit_link',
      expectedExternalEditedAt: '2026-07-23T10:00:00+09:00',
    };
    raw.prepare(
      `UPDATE internal_form_submissions
       SET answers_json = '{"name":"画面表示後のシート編集"}',
           external_edit_source = 'sheet',
           external_edited_at = '2026-07-23T10:01:00+09:00',
           external_edit_approved_at = NULL
       WHERE id = 'sub-1'`,
    ).run();

    const response = await call(
      'POST',
      '/api/forms-advanced/internal-form/rows/sub-1/approve-external-edit',
      displayed,
    );

    expect(response.status).toBe(409);
    expect(raw.prepare(
      `SELECT answers_json, external_edit_source, external_edited_at,
              external_edit_approved_at
       FROM internal_form_submissions WHERE id = 'sub-1'`,
    ).get()).toEqual({
      answers_json: '{"name":"画面表示後のシート編集"}',
      external_edit_source: 'sheet',
      external_edited_at: '2026-07-23T10:01:00+09:00',
      external_edit_approved_at: null,
    });
  });

  test('filters, marks, and dynamically resolves duplicate-review rows within one form', async () => {
    seedInternalSubmission(
      'sub-4',
      'internal-form',
      { name: '二郎（再送）', contact: 'two@example.test' },
      '2026-07-03T09:00:00+09:00',
      'friend-1',
    );
    seedInternalSubmission(
      'sub-5',
      'internal-form',
      { name: '一郎', contact: 'one@example.test' },
      '2026-07-04T09:00:00+09:00',
    );
    seedInternalSubmission(
      'other-form-same-friend',
      'other-internal-form',
      { name: '別フォーム', contact: 'two@example.test' },
      '2026-07-05T09:00:00+09:00',
      'friend-1',
    );

    const unfiltered = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?page=1&pageSize=25',
    );
    expect(unfiltered.status).toBe(200);
    const unfilteredData = (await unfiltered.json() as {
      data: {
        rows: Array<{
          id: string;
          duplicateGroupId: string | null;
          duplicateGroupSize: number | null;
          duplicateContentMatch: 'identical' | 'different' | null;
          duplicateReviewedAt: string | null;
          duplicateReviewRevision: string | null;
        }>;
        duplicateReviewPendingCount: number;
      };
    }).data;
    expect(unfilteredData.duplicateReviewPendingCount).toBe(4);
    expect(unfilteredData.rows.find((row) => row.id === 'sub-1')).toMatchObject({
      duplicateGroupSize: 2,
      duplicateContentMatch: 'identical',
      duplicateReviewedAt: null,
      duplicateReviewRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(unfilteredData.rows.find((row) => row.id === 'sub-2')).toMatchObject({
      duplicateGroupSize: 2,
      duplicateContentMatch: 'different',
    });

    const stats = await call('GET', '/api/forms-advanced/internal-form/stats');
    expect((await stats.json() as { data: { duplicateReviewPending: number } }).data)
      .toMatchObject({ duplicateReviewPending: 4 });

    const filtered = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?duplicateReview=pending&page=1&pageSize=25',
    );
    const filteredData = (await filtered.json() as {
      data: {
        rows: Array<{
          id: string;
          duplicateGroupId: string;
          duplicateReviewRevision: string;
        }>;
        total: number;
        duplicateReviewPendingCount: number;
      };
    }).data;
    expect(filteredData.total).toBe(4);
    expect(filteredData.duplicateReviewPendingCount).toBe(4);
    expect(filteredData.rows.map((row) => row.id)).toEqual([
      'sub-5',
      'sub-1',
      'sub-4',
      'sub-2',
    ]);
    expect(filteredData.rows[0]?.duplicateGroupId).toBe(filteredData.rows[1]?.duplicateGroupId);
    expect(filteredData.rows[2]?.duplicateGroupId).toBe(filteredData.rows[3]?.duplicateGroupId);
    expect(filteredData.rows[0]?.duplicateGroupId).not.toBe(filteredData.rows[2]?.duplicateGroupId);

    const displayed = filteredData.rows.find((row) => row.id === 'sub-4');
    expect(displayed).toBeTruthy();
    const answersBefore = raw.prepare(
      `SELECT answers_json FROM internal_form_submissions WHERE id = 'sub-4'`,
    ).pluck().get() as string;
    const confirmed = await call(
      'POST',
      '/api/forms-advanced/internal-form/rows/sub-4/confirm-duplicate',
      { expectedDuplicateReviewRevision: displayed!.duplicateReviewRevision },
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      success: true,
      data: {
        id: 'sub-4',
        duplicateGroupSize: 2,
        duplicateReviewedAt: expect.any(String),
      },
    });
    expect(raw.prepare(
      `SELECT answers_json FROM internal_form_submissions WHERE id = 'sub-4'`,
    ).pluck().get()).toBe(answersBefore);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();

    const afterConfirmation = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?duplicateReview=pending&page=1&pageSize=25',
    );
    expect((await afterConfirmation.json() as {
      data: { rows: Array<{ id: string }>; total: number; duplicateReviewPendingCount: number };
    }).data).toMatchObject({
      rows: [{ id: 'sub-5' }, { id: 'sub-1' }, { id: 'sub-2' }],
      total: 3,
      duplicateReviewPendingCount: 3,
    });

    expect((await call(
      'DELETE',
      '/api/forms-advanced/internal-form/rows/sub-5',
    )).status).toBe(200);
    const afterDelete = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?duplicateReview=pending&page=1&pageSize=25',
    );
    expect((await afterDelete.json() as {
      data: { rows: Array<{ id: string }>; total: number; duplicateReviewPendingCount: number };
    }).data).toMatchObject({
      rows: [{ id: 'sub-2' }],
      total: 1,
      duplicateReviewPendingCount: 1,
    });
  });

  test('returns 409 instead of confirming a duplicate group that changed after display', async () => {
    seedInternalSubmission(
      'sub-4',
      'internal-form',
      { name: '二郎（再送）', contact: 'two@example.test' },
      '2026-07-03T09:00:00+09:00',
      'friend-1',
    );
    const listed = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows?duplicateReview=pending&page=1&pageSize=25',
    );
    const displayed = (await listed.json() as {
      data: { rows: Array<{ id: string; duplicateReviewRevision: string }> };
    }).data.rows.find((row) => row.id === 'sub-4');
    expect(displayed).toBeTruthy();

    raw.prepare(
      `UPDATE internal_form_submissions
       SET answers_json = '{"name":"表示後に変更","contact":"two@example.test"}'
       WHERE id = 'sub-4'`,
    ).run();
    const response = await call(
      'POST',
      '/api/forms-advanced/internal-form/rows/sub-4/confirm-duplicate',
      { expectedDuplicateReviewRevision: displayed!.duplicateReviewRevision },
    );

    expect(response.status).toBe(409);
    expect(raw.prepare(
      `SELECT duplicate_reviewed_at
       FROM internal_form_submissions WHERE id = 'sub-4'`,
    ).get()).toEqual({ duplicate_reviewed_at: null });
  });

  test('DELETE soft-deletes only the requested form-scoped answer and hides it from admin reads', async () => {
    const crossed = await call('DELETE', '/api/forms-advanced/internal-form/rows/not-in-this-form');
    expect(crossed.status).toBe(404);
    expect(await crossed.json()).toEqual({ success: false, error: '回答が見つかりません' });

    seedInternalSubmission(
      'not-in-this-form',
      'other-internal-form',
      { name: '別フォーム' },
      '2026-07-03T09:00:00+09:00',
    );
    expect((await call(
      'DELETE',
      '/api/forms-advanced/internal-form/rows/not-in-this-form',
    )).status).toBe(404);

    const response = await call('DELETE', '/api/forms-advanced/internal-form/rows/sub-2');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(raw.prepare(
      'SELECT answers_json, deleted_at FROM internal_form_submissions WHERE id = ?',
    ).get('sub-2')).toMatchObject({
      answers_json: '{"name":"二郎","contact":"two@example.test"}',
      deleted_at: expect.any(String),
    });

    const list = await call('GET', '/api/forms-advanced/internal-form/rows?page=1&pageSize=25');
    expect((await list.json() as { data: { total: number; rows: Array<{ id: string }> } }).data)
      .toMatchObject({ total: 2, rows: [{ id: 'sub-3' }, { id: 'sub-1' }] });
    expect((await call('GET', '/api/forms-advanced/internal-form/rows/sub-2')).status).toBe(404);
    const stats = await call('GET', '/api/forms-advanced/internal-form/stats');
    expect((await stats.json() as { data: { total: number; verified: number } }).data)
      .toMatchObject({ total: 2, verified: 0 });
    expect(raw.prepare(
      'SELECT deleted_at FROM internal_form_submissions WHERE id = ?',
    ).get('not-in-this-form')).toEqual({ deleted_at: null });
  });

  test('DELETE queues an immediate Sheets sync after the internal answer is soft-deleted', async () => {
    raw.prepare('UPDATE formaloo_forms SET line_account_id = ? WHERE id = ?')
      .run('acc-1', 'internal-form');
    bindingOverrides = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockImplementationOnce(async () => {
      expect(raw.prepare(
        'SELECT deleted_at FROM internal_form_submissions WHERE id = ?',
      ).get('sub-2')).toEqual({ deleted_at: expect.any(String) });
    });
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });

    const response = await app().fetch(new Request(
      'https://worker.example.test/api/forms-advanced/internal-form/rows/sub-2',
      { method: 'DELETE', headers: { Authorization: OWNER } },
    ), env(), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).toHaveBeenCalledWith(expect.objectContaining({
      db: DB,
      lineAccountId: 'acc-1',
      formId: 'internal-form',
      submissionId: 'sub-2',
      actor: expect.any(String),
      credentialsJson: '{}',
    }));
  });

  test('DELETE keeps Sheets side effects disabled without service-account credentials', async () => {
    raw.prepare('UPDATE formaloo_forms SET line_account_id = ? WHERE id = ?')
      .run('acc-1', 'internal-form');
    const waitUntil = vi.fn();

    const response = await app().fetch(new Request(
      'https://worker.example.test/api/forms-advanced/internal-form/rows/sub-2',
      { method: 'DELETE', headers: { Authorization: OWNER } },
    ), env(), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('DELETE keeps the existing authentication and forms_advanced permission boundary', async () => {
    expect((await call(
      'DELETE',
      '/api/forms-advanced/internal-form/rows/sub-1',
      undefined,
      { auth: '' },
    )).status).toBe(401);

    const roleId = (await createRole(DB, { name: '回答削除担当' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('delete-staff', 'delete-key', roleId);
    expect((await call(
      'DELETE',
      '/api/forms-advanced/internal-form/rows/sub-1',
      undefined,
      { auth: 'Bearer delete-key' },
    )).status).toBe(403);

    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: true }]);
    expect((await call(
      'DELETE',
      '/api/forms-advanced/internal-form/rows/sub-1',
      undefined,
      { auth: 'Bearer delete-key' },
    )).status).toBe(200);
  });

  test('detail exposes allow_post_edit, real field editability, editVersion, and form scope', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({
        name: '二郎',
        contact: 'two@example.test',
        attachment: [{ key: 'private/file.pdf', name: '申込書.pdf' }],
        signature: 'data:image/png;base64,c2ln',
        matrix: { 接客: '良い' },
        repeat: [{ repeat_name: '参加者' }],
        total: 2,
        kind: '個人',
      }), 'sub-2');

    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-2');
    expect(response.status).toBe(200);
    const data = (await response.json() as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      id: 'sub-2',
      friendId: 'friend-1',
      verified: true,
      source: 'internal',
      allowPostEdit: 1,
      editVersion: 0,
      answerRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      lastEdit: null,
    });
    expect(data.fields).toEqual([
      { slug: 'name', label: 'お名前', type: 'text', required: true, editable: true, editableWhenVisible: true, visible: true },
      { slug: 'contact', label: 'メール', type: 'email', required: false, editable: true, editableWhenVisible: true, visible: true },
      {
        slug: 'attachment', label: '添付', type: 'file', required: false,
        editable: false, editableWhenVisible: false, visible: true,
        attachmentManageable: true,
        attachmentConfig: { allowMultipleFiles: false, allowedExtensions: [], maxSizeKb: 2048 },
      },
      { slug: 'signature', label: '署名', type: 'signature', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'matrix', label: '評価', type: 'matrix', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'repeat_name', label: '参加者名', type: 'text', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'repeat', label: '参加者', type: 'repeating_section', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'total', label: '計算値', type: 'variable', required: false, editable: false, editableWhenVisible: false, visible: true },
      { slug: 'kind', label: '区分', type: 'choice', required: true, editable: true, editableWhenVisible: true, visible: true },
      { slug: 'company', label: '会社名', type: 'text', required: true, editable: false, editableWhenVisible: true, visible: false },
    ]);
    expect((await call('GET', '/api/forms-advanced/other-internal-form/rows/sub-2')).status).toBe(404);

    raw.prepare("UPDATE formaloo_forms SET allow_post_edit = 0 WHERE id = 'internal-form'").run();
    const disabled = await call('GET', '/api/forms-advanced/internal-form/rows/sub-2');
    const disabledData = (await disabled.json() as {
      data: { allowPostEdit: number; fields: Array<{ editable: boolean }> };
    }).data;
    expect(disabledData.allowPostEdit).toBe(0);
    expect(disabledData.fields.every((field) => !field.editable)).toBe(true);
  });

  test('PATCH validates, preserves read-only answers, and detects stale admin screens', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'internal-form');
    const original = {
      name: '二郎',
      contact: 'two@example.test',
      attachment: [{ key: 'private/file.pdf', name: '申込書.pdf' }],
      signature: 'data:image/png;base64,c2ln',
      matrix: { 接客: '良い' },
      repeat: [{ repeat_name: '参加者' }],
      total: 2,
      kind: '個人',
    };
    raw.prepare(
      `UPDATE internal_form_submissions
       SET answers_json = ?,
           external_edit_source = 'sheet',
           external_edited_at = '2026-07-23T09:00:00+09:00',
           external_edit_approved_at = '2026-07-23T09:01:00+09:00',
           external_edit_changes_json = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(original),
      JSON.stringify([{ fieldId: 'name', before: '変更前', after: '二郎' }]),
      'sub-2',
    );
    const context = await internalEditContext('internal-form', 'sub-2');

    const saved = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '更新後', contact: 'new@example.test', kind: '個人' },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      success: true,
      data: {
        id: 'sub-2', source: 'internal', editVersion: 1,
        answerRevision: expect.stringMatching(/^[a-f0-9]{64}$/), lastEdit: null,
        externalEditChanges: [{ fieldId: 'name', before: '変更前', after: '二郎' }],
        answers: {
          name: '更新後',
          contact: 'new@example.test',
          attachment: original.attachment,
          signature: original.signature,
          matrix: original.matrix,
          repeat: original.repeat,
          total: 2,
          kind: '個人',
        },
      },
    });
    expect(raw.prepare(
      `SELECT friend_id, submitted_at, edit_version, external_edit_source,
              external_edited_at, external_edit_approved_at,
              external_edit_changes_json
       FROM internal_form_submissions WHERE id = ?`,
    )
      .get('sub-2')).toEqual({
        friend_id: 'friend-1',
        submitted_at: '2026-07-01T10:00:00+09:00',
        edit_version: 1,
        external_edit_source: 'sheet',
        external_edited_at: '2026-07-23T09:00:00+09:00',
        external_edit_approved_at: '2026-07-23T09:01:00+09:00',
        external_edit_changes_json:
          '[{"fieldId":"name","before":"変更前","after":"二郎"}]',
      });

    const stale = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '古い画面の値', contact: 'old-screen@example.test', kind: '個人' },
    });
    expect(stale.status).toBe(409);
    expect(JSON.parse((raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('sub-2') as { answers_json: string }).answers_json)).toMatchObject({ name: '更新後' });
  });

  test('admin PATCH can still change an editLocked field', async () => {
    const editLockedAdminDefinition = {
      ...EDITABLE_DEFINITION,
      fields: EDITABLE_DEFINITION.fields.map((field) => field.id === 'name'
        ? { ...field, config: { ...field.config, editLocked: true } }
        : field),
    };
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(editLockedAdminDefinition), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '管理画面の変更前', contact: 'two@example.test', kind: '個人' }), 'sub-2');

    const detail = await call('GET', '/api/forms-advanced/internal-form/rows/sub-2');
    const detailData = (await detail.json() as {
      data: { fields: Array<{ slug: string; editable: boolean }> };
    }).data;
    expect(detailData.fields).toContainEqual(expect.objectContaining({
      slug: 'name',
      editable: true,
    }));
    const context = await internalEditContext('internal-form', 'sub-2');

    const saved = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '管理画面から更新', contact: 'two@example.test', kind: '個人' },
    });

    expect(saved.status).toBe(200);
    expect((await saved.json() as { data: { answers: Record<string, unknown> } }).data.answers)
      .toMatchObject({ name: '管理画面から更新' });
  });

  test('multipart PATCH removes and adds attachments through the shared final-list contract, then GET returns the same list', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(ADMIN_ATTACHMENT_DEFINITION), 'internal-form');
    const removed = {
      key: 'internal-form-submissions/internal-form/attachment/removed.pdf',
      name: '削除対象.pdf', size: 12, type: 'application/pdf',
    };
    const kept = {
      key: 'internal-form-submissions/internal-form/attachment/kept.pdf',
      name: '残す資料.pdf', size: 34, type: 'application/pdf',
    };
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({
        name: '二郎', contact: 'two@example.test', attachment: [removed, kept], kind: '個人',
      }), 'sub-2');
    const put = vi.fn(async () => ({}));
    const del = vi.fn(async () => undefined);
    bindingOverrides = { IMAGES: { put, delete: del } as unknown as R2Bucket };
    const context = await internalEditContext('internal-form', 'sub-2');
    const added = new File(['new'], '追加画像.png', { type: 'image/png' });

    const saved = await callAdminEditFormData(
      '/api/forms-advanced/internal-form/rows/sub-2',
      adminEditFormData(
        context,
        { name: '更新後', contact: 'new@example.test', kind: '法人', company: '株式会社追加' },
        { fieldIds: { 2: 'attachment' }, removals: { 2: ['0'] }, additions: { 2: [added] } },
      ),
    );

    expect(saved.status).toBe(200);
    const savedData = (await saved.json() as {
      data: { answers: Record<string, unknown>; editVersion: number; answerRevision: string };
    }).data;
    const finalAttachments = savedData.answers.attachment as Array<Record<string, unknown>>;
    expect(finalAttachments).toHaveLength(2);
    expect(finalAttachments[0]).toEqual(kept);
    expect(finalAttachments[1]).toMatchObject({
      name: '追加画像.png', size: 3, type: 'image/png',
    });
    expect(finalAttachments[1]?.key).toMatch(/^internal-form-submissions\/internal-form\/attachment\/[0-9a-f-]+\.png$/);
    expect(savedData.answers).toMatchObject({
      name: '更新後', contact: 'new@example.test', kind: '法人', company: '株式会社追加',
    });
    expect(savedData.editVersion).toBe(1);
    expect(savedData.answerRevision).not.toBe(context.answerRevision);
    expect(put).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalledWith(removed.key);

    const readback = await call('GET', '/api/forms-advanced/internal-form/rows/sub-2');
    expect(readback.status).toBe(200);
    expect((await readback.json() as { data: { answers: Record<string, unknown> } }).data.answers)
      .toEqual(savedData.answers);
  });

  test('multipart PATCH validates fields revealed by the final attachment list in the same save', async () => {
    const attachmentBranchDefinition = {
      ...ADMIN_ATTACHMENT_DEFINITION,
      logic: [{
        id: 'show-company-from-attachment',
        sourceFieldId: 'attachment',
        operator: 'equals',
        value: 'unused',
        action: 'show',
        targetFieldId: 'company',
        conditionJoin: 'and',
        conditions: [{ sourceFieldId: 'attachment', operator: 'is_answered', value: '' }],
      }],
    };
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(attachmentBranchDefinition), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人' }), 'sub-2');
    const put = vi.fn(async () => ({}));
    bindingOverrides = { IMAGES: { put, delete: vi.fn(async () => undefined) } as unknown as R2Bucket };
    const context = await internalEditContext('internal-form', 'sub-2');

    const response = await callAdminEditFormData(
      '/api/forms-advanced/internal-form/rows/sub-2',
      adminEditFormData(
        context,
        { name: '二郎', contact: 'two@example.test', kind: '個人', company: '株式会社追加' },
        {
          fieldIds: { 2: 'attachment' },
          additions: { 2: [new File(['new'], '追加.pdf', { type: 'application/pdf' })] },
        },
      ),
    );

    expect(response.status).toBe(200);
    const savedAnswers = (await response.json() as {
      data: { answers: Record<string, unknown> };
    }).data.answers;
    expect(savedAnswers).toMatchObject({ company: '株式会社追加' });
    expect(savedAnswers.attachment).toEqual([
      expect.objectContaining({ name: '追加.pdf', size: 3, type: 'application/pdf' }),
    ]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  test('multipart PATCH accepts a file revealed by another file added in the same final list', async () => {
    const chainedFileDefinition = {
      ...ADMIN_ATTACHMENT_DEFINITION,
      fields: [
        ...ADMIN_ATTACHMENT_DEFINITION.fields,
        {
          id: 'supplement', type: 'file', label: '追加資料', required: true, position: 10,
          config: { allowMultipleFiles: false, allowedExtensions: ['pdf'], maxSizeKb: 256 },
        },
      ],
      logic: [
        ...ADMIN_ATTACHMENT_DEFINITION.logic,
        {
          id: 'show-supplement-from-attachment',
          sourceFieldId: 'attachment',
          operator: 'equals',
          value: 'unused',
          action: 'show',
          targetFieldId: 'supplement',
          conditionJoin: 'and',
          conditions: [{ sourceFieldId: 'attachment', operator: 'is_answered', value: '' }],
        },
      ],
    };
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(chainedFileDefinition), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人' }), 'sub-2');
    const put = vi.fn(async () => ({}));
    bindingOverrides = { IMAGES: { put, delete: vi.fn(async () => undefined) } as unknown as R2Bucket };
    const context = await internalEditContext('internal-form', 'sub-2');

    const response = await callAdminEditFormData(
      '/api/forms-advanced/internal-form/rows/sub-2',
      adminEditFormData(
        context,
        { name: '二郎', contact: 'two@example.test', kind: '個人' },
        {
          fieldIds: { 2: 'attachment', 10: 'supplement' },
          additions: {
            2: [new File(['source'], '分岐元.pdf', { type: 'application/pdf' })],
            10: [new File(['target'], '分岐先.pdf', { type: 'application/pdf' })],
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    const answers = (await response.json() as { data: { answers: Record<string, unknown> } }).data.answers;
    expect(answers.attachment).toEqual([expect.objectContaining({ name: '分岐元.pdf' })]);
    expect(answers.supplement).toEqual([expect.objectContaining({ name: '分岐先.pdf' })]);
    expect(put).toHaveBeenCalledTimes(2);
  });

  test('multipart PATCH rejects forged removals and the shared count, extension, and size limits without uploading', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(ADMIN_ATTACHMENT_DEFINITION), 'internal-form');
    const put = vi.fn(async () => ({}));
    const del = vi.fn(async () => undefined);
    bindingOverrides = { IMAGES: { put, delete: del } as unknown as R2Bucket };
    const baseAnswers = { name: '二郎', contact: 'two@example.test', kind: '個人' };
    const cases = [
      {
        label: '存在しない削除 index',
        existing: [{
          key: 'internal-form-submissions/internal-form/attachment/one.pdf',
          name: 'one.pdf', size: 1, type: 'application/pdf',
        }],
        removals: ['9'],
        additions: [] as File[],
      },
      {
        label: '許可外拡張子', existing: [], removals: [],
        additions: [new File(['bad'], 'bad.exe', { type: 'application/octet-stream' })],
      },
      {
        label: 'サイズ上限', existing: [], removals: [],
        additions: [new File([new Uint8Array(256 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' })],
      },
      {
        label: '個数上限',
        existing: Array.from({ length: 10 }, (_, index) => ({
          key: `internal-form-submissions/internal-form/attachment/${index}.pdf`,
          name: `${index}.pdf`, size: 1, type: 'application/pdf',
        })),
        removals: [],
        additions: [new File(['one-more'], 'extra.pdf', { type: 'application/pdf' })],
      },
      {
        label: '項目並び替え後の古い field id',
        existing: [], removals: [],
        additions: [new File(['stale'], 'stale.pdf', { type: 'application/pdf' })],
        fieldId: 'different-file-field',
      },
    ];

    for (const scenario of cases) {
      const answers = { ...baseAnswers, attachment: scenario.existing };
      raw.prepare('UPDATE internal_form_submissions SET answers_json = ?, edit_version = 0 WHERE id = ?')
        .run(JSON.stringify(answers), 'sub-2');
      const context = await internalEditContext('internal-form', 'sub-2');
      put.mockClear();
      del.mockClear();

      const response = await callAdminEditFormData(
        '/api/forms-advanced/internal-form/rows/sub-2',
        adminEditFormData(context, baseAnswers, {
          fieldIds: { 2: scenario.fieldId ?? 'attachment' },
          ...(scenario.removals.length > 0 ? { removals: { 2: scenario.removals } } : {}),
          ...(scenario.additions.length > 0 ? { additions: { 2: scenario.additions } } : {}),
        }),
      );

      expect(response.status, scenario.label).toBe(400);
      expect(JSON.parse((raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
        .get('sub-2') as { answers_json: string }).answers_json), scenario.label).toEqual(answers);
      expect(put, scenario.label).not.toHaveBeenCalled();
      expect(del, scenario.label).not.toHaveBeenCalled();
    }
  });

  test('multipart PATCH rolls back only the newly uploaded object when the admin CAS loses', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(ADMIN_ATTACHMENT_DEFINITION), 'internal-form');
    const existing = {
      key: 'internal-form-submissions/internal-form/attachment/existing.pdf',
      name: '既存.pdf', size: 10, type: 'application/pdf',
    };
    const answers = { name: '二郎', contact: 'two@example.test', attachment: [existing], kind: '個人' };
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify(answers), 'sub-2');
    const put = vi.fn(async () => ({}));
    const del = vi.fn(async () => undefined);
    bindingOverrides = { IMAGES: { put, delete: del } as unknown as R2Bucket };
    const context = await internalEditContext('internal-form', 'sub-2');
    forceInternalAnswerUpdateConflict();

    const response = await callAdminEditFormData(
      '/api/forms-advanced/internal-form/rows/sub-2',
      adminEditFormData(context, { name: '二郎', contact: 'two@example.test', kind: '個人' }, {
        fieldIds: { 2: 'attachment' },
        additions: { 2: [new File(['new'], 'new.pdf', { type: 'application/pdf' })] },
      }),
    );

    expect(response.status).toBe(409);
    expect(put).toHaveBeenCalledTimes(1);
    const uploadedKey = String(put.mock.calls[0]?.[0]);
    expect(del).toHaveBeenCalledWith(uploadedKey);
    expect(del).not.toHaveBeenCalledWith(existing.key);
    expect(JSON.parse((raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('sub-2') as { answers_json: string }).answers_json)).toEqual(answers);
  });

  test('PATCH queues an immediate Sheets sync after an internal admin answer edit', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ?, line_account_id = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'acc-1', 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人' }), 'sub-2');
    const context = await internalEditContext('internal-form', 'sub-2');
    bindingOverrides = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const executionCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await app().fetch(new Request(
      'https://worker.example.test/api/forms-advanced/internal-form/rows/sub-2',
      {
        method: 'PATCH',
        headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...context,
          answers: { name: '管理画面更新', contact: 'admin@example.test', kind: '個人' },
        }),
      },
    ), env(), executionCtx);

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).toHaveBeenCalledWith(expect.objectContaining({
      db: DB,
      lineAccountId: 'acc-1',
      formId: 'internal-form',
      submissionId: 'sub-2',
      actor: expect.any(String),
      credentialsJson: '{}',
    }));
  });

  test('PATCH keeps an admin answer edit successful when the background Sheets sync fails', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ?, line_account_id = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'acc-1', 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人' }), 'sub-2');
    const context = await internalEditContext('internal-form', 'sub-2');
    bindingOverrides = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockRejectedValueOnce(new Error('sync failed'));
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app().fetch(new Request(
      'https://worker.example.test/api/forms-advanced/internal-form/rows/sub-2',
      {
        method: 'PATCH',
        headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...context,
          answers: { name: '管理画面更新', contact: 'admin@example.test', kind: '個人' },
        }),
      },
    ), env(), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(raw.prepare('SELECT edit_version FROM internal_form_submissions WHERE id = ?').get('sub-2'))
      .toEqual({ edit_version: 1 });
    expect(error).toHaveBeenCalledWith('Immediate Google Sheets sync after admin answer edit failed');
  });

  test.each([
    ['read-only field', { name: '更新', attachment: [] }],
    ['unknown identity field', { name: '更新', friendId: 'attacker' }],
    ['required empty', { name: '' }],
    ['invalid email type', { name: '更新', contact: 'not-an-email' }],
  ] as const)('PATCH rejects %s without mutating the row', async (_label, answers) => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ?, line_account_id = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'acc-1', 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人', attachment: [] }), 'sub-2');
    const before = raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('sub-2');
    const context = await internalEditContext('internal-form', 'sub-2');
    bindingOverrides = { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
    const waitUntil = vi.fn();

    const response = await app().fetch(new Request(
      'https://worker.example.test/api/forms-advanced/internal-form/rows/sub-2',
      {
        method: 'PATCH',
        headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...context, answers }),
      },
    ), env(), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(400);
    expect(raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('sub-2')).toEqual(before);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('PATCH enforces allow_post_edit, form scope, and existing admin authentication', async () => {
    const disabled = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      editVersion: 0,
      answers: { name: '更新' },
    });
    expect(disabled.status).toBe(403);

    raw.prepare("UPDATE formaloo_forms SET allow_post_edit = 1 WHERE id = 'internal-form'").run();
    const context = await internalEditContext('internal-form', 'sub-2');
    seedInternalSubmission('other-sub', 'other-internal-form', { name: '別フォーム' }, '2026-07-03T09:00:00+09:00');
    const crossed = await call('PATCH', '/api/forms-advanced/internal-form/rows/other-sub', {
      ...context,
      answers: { name: '越境更新' },
    });
    expect(crossed.status).toBe(404);
    expect((raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('other-sub') as { answers_json: string }).answers_json).toBe('{"name":"別フォーム"}');

    expect((await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '無認証更新' },
    }, { auth: '' })).status).toBe(401);

    const roleId = (await createRole(DB, { name: '回答編集不可' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('edit-denied', 'edit-denied-key', roleId);
    expect((await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '権限なし更新' },
    }, { auth: 'Bearer edit-denied-key' })).status).toBe(403);
  });

  test('PATCH switches to a newly visible required logic branch in one save', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人' }), 'sub-2');
    const context = await internalEditContext('internal-form', 'sub-2');

    const response = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: {
        name: '二郎', contact: 'two@example.test', kind: '法人', company: '株式会社テスト',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.clone().json()).toMatchObject({
      success: true,
      data: {
        allowPostEdit: 1,
        fields: expect.arrayContaining([
          expect.objectContaining({
            slug: 'company', editable: true, editableWhenVisible: true, visible: true,
          }),
        ]),
      },
    });
    const stored = JSON.parse((raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('sub-2') as { answers_json: string }).answers_json) as Record<string, unknown>;
    expect(stored).toMatchObject({ kind: '法人', company: '株式会社テスト' });
  });

  test('PATCH removes read-only definition answers hidden by the final branch and GET returns the overwritten result', async () => {
    const branchDefinition = {
      ...EDITABLE_DEFINITION,
      logic: [
        ...EDITABLE_DEFINITION.logic,
        {
          id: 'show-attachment', sourceFieldId: 'kind', operator: 'equals', value: '法人',
          action: 'show', targetFieldId: 'attachment',
        },
      ],
    };
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(branchDefinition), 'internal-form');
    const original = {
      name: '二郎',
      contact: 'two@example.test',
      kind: '法人',
      company: '旧会社名',
      attachment: [{ key: 'private/file.pdf', name: '申込書.pdf' }],
      signature: 'data:image/png;base64,c2ln',
      matrix: { 接客: '良い' },
      repeat: [{ repeat_name: '参加者' }],
      total: 2,
      legacy_unknown: { keep: true },
    };
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify(original), 'sub-2');
    const context = await internalEditContext('internal-form', 'sub-2');

    const response = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '二郎', contact: 'two@example.test', kind: '個人' },
    });

    expect(response.status).toBe(200);
    const savedAnswers = (await response.json() as {
      data: { answers: Record<string, unknown> };
    }).data.answers;
    expect(savedAnswers).toMatchObject({
      name: '二郎',
      contact: 'two@example.test',
      kind: '個人',
      signature: original.signature,
      matrix: original.matrix,
      repeat: original.repeat,
      total: 2,
      legacy_unknown: { keep: true },
    });
    expect(savedAnswers).not.toHaveProperty('company');
    expect(savedAnswers).not.toHaveProperty('attachment');

    const storedAnswers = JSON.parse((raw.prepare(
      'SELECT answers_json FROM internal_form_submissions WHERE id = ?',
    ).get('sub-2') as { answers_json: string }).answers_json) as Record<string, unknown>;
    expect(storedAnswers).toEqual(savedAnswers);

    const readback = await call('GET', '/api/forms-advanced/internal-form/rows/sub-2');
    expect(readback.status).toBe(200);
    const readbackData = (await readback.json() as {
      data: {
        answers: Record<string, unknown>;
        fields: Array<{ slug: string; visible: boolean; editable: boolean }>;
      };
    }).data;
    expect(readbackData.answers).toEqual(savedAnswers);
    expect(readbackData.answers).not.toHaveProperty('company');
    expect(readbackData.answers).not.toHaveProperty('attachment');
    expect(readbackData.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'attachment', visible: false, editable: false }),
      expect.objectContaining({ slug: 'signature', visible: true, editable: false }),
    ]));
  });

  test('PATCH rejects a field that stays hidden before and after the edit', async () => {
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(EDITABLE_DEFINITION), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', contact: 'two@example.test', kind: '個人' }), 'sub-2');
    const before = raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('sub-2');
    const context = await internalEditContext('internal-form', 'sub-2');

    const response = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: {
        name: '二郎', contact: 'two@example.test', kind: '個人', company: 'forged',
      },
    });

    expect(response.status).toBe(400);
    expect(raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('sub-2')).toEqual(before);
  });

  test('PATCH keeps yes/no and delimiter-containing multiple selections across consecutive saves', async () => {
    const typedDefinition = {
      fields: [
        { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
        { id: 'consent', type: 'yes_no', label: '同意', required: true, position: 1, config: {} },
        {
          id: 'tags', type: 'multiple_select', label: '希望', required: false, position: 2,
          config: { choices: ['A, Inc.', '和食、洋食', ' 前後空白 '] },
        },
      ],
      logic: [],
    };
    const exactSelections = ['A, Inc.', '和食、洋食', ' 前後空白 '];
    raw.prepare('UPDATE formaloo_forms SET allow_post_edit = 1, definition_json = ? WHERE id = ?')
      .run(JSON.stringify(typedDefinition), 'internal-form');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run(JSON.stringify({ name: '二郎', consent: 'yes', tags: exactSelections }), 'sub-2');
    const firstContext = await internalEditContext('internal-form', 'sub-2');

    const first = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...firstContext,
      answers: { name: '二郎', consent: 'yes', tags: exactSelections },
    });
    expect(first.status).toBe(200);
    const firstData = (await first.json() as {
      data: {
        editVersion: number;
        answerRevision: string;
        answers: Record<string, unknown>;
        fields: Array<{ slug: string; choices?: string[] }>;
      };
    }).data;
    expect(firstData.answers).toMatchObject({ consent: true, tags: exactSelections });
    expect(firstData.fields).toContainEqual(expect.objectContaining({
      slug: 'tags', choices: exactSelections,
    }));

    const second = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      editVersion: firstData.editVersion,
      answerRevision: firstData.answerRevision,
      answers: { name: '二郎', consent: 'no', tags: exactSelections },
    });
    expect(second.status).toBe(200);
    expect((await second.json() as { data: { answers: Record<string, unknown> } }).data.answers)
      .toMatchObject({ consent: false, tags: exactSelections });
  });

  test('PATCH rejects a screen snapshot made stale by a Sheets answer update', async () => {
    raw.prepare("UPDATE formaloo_forms SET allow_post_edit = 1 WHERE id = 'internal-form'").run();
    const context = await internalEditContext('internal-form', 'sub-2');
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run('{"name":"シート側更新","contact":"sheet@example.test"}', 'sub-2');

    const response = await call('PATCH', '/api/forms-advanced/internal-form/rows/sub-2', {
      ...context,
      answers: { name: '古い画面の更新', contact: 'old-screen@example.test' },
    });

    expect(response.status).toBe(409);
    expect((raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('sub-2'))).toEqual({
        answers_json: '{"name":"シート側更新","contact":"sheet@example.test"}',
        edit_version: 0,
      });
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
        externalEditPending: 0,
        duplicateReviewPending: 0,
      },
    });
  });
});

describe('internal attachment download route', () => {
  const FILE_DEFINITION = {
    fields: [
      { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
      { id: 'docs', type: 'file', label: '添付資料', required: false, position: 1, config: { allowMultipleFiles: true } },
    ],
    logic: [],
  };
  const FILE_ANSWERS = {
    name: '一郎',
    docs: [
      { key: 'internal-form-submissions/internal-form/docs/uuid-1.pdf', name: '見積/書.pdf', size: 1234, type: 'application/pdf' },
      { key: 'internal-form-submissions/other-internal-form/docs/uuid-2.png', name: '他フォーム.png', size: 10, type: 'image/png' },
      { key: 'internal-form-submissions/internal-form/docs/uuid-3.bin', name: 'evil.bin', size: 5, type: 'text/html\r\nX-Evil: 1' },
      { key: 'internal-form-submissions/internal-form/docs/uuid-4.pdf', name: "O'Reilly (final)\r\n.pdf", size: 6, type: 'application/pdf' },
      { key: 'internal-form-submissions/internal-form/docs/uuid-5.pdf', name: `${'a'.repeat(79)}😀.pdf`, size: 7, type: 'application/pdf' },
    ],
  };

  function stubImagesGet(body: string | null = 'file-bytes') {
    const get = vi.fn(async () => (body === null ? null : { body } as unknown as R2ObjectBody));
    bindingOverrides = { IMAGES: { get } as unknown as R2Bucket };
    return get;
  }

  beforeEach(() => {
    seedForm('internal-form', 'internal', { definition: FILE_DEFINITION });
    seedForm('other-internal-form', 'internal', { definition: FILE_DEFINITION });
    seedInternalSubmission('sub-1', 'internal-form', FILE_ANSWERS, '2026-07-22T09:00:00+09:00');
  });

  test('rejects unauthenticated requests before touching R2', async () => {
    const get = stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/0', undefined, { auth: '' });
    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  test('rejects authenticated staff without forms_advanced permission before touching R2', async () => {
    const get = stubImagesGet();
    const roleId = (await createRole(DB, { name: '添付閲覧不可' })).id;
    await setRolePermissions(DB, roleId, [
      { feature_key: 'forms_advanced', allowed: false },
    ]);
    seedStaff('attachment-denied', 'attachment-denied-key', roleId);

    const response = await call(
      'GET',
      '/api/forms-advanced/internal-form/rows/sub-1/files/docs/0',
      undefined,
      { auth: 'Bearer attachment-denied-key' },
    );

    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  test('streams the stored object with sanitized attachment headers', async () => {
    const get = stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/0');
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('internal-form-submissions/internal-form/docs/uuid-1.pdf');
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Disposition'))
      .toBe(`attachment; filename*=UTF-8''${encodeURIComponent('見積_書.pdf')}`);
    expect(await response.text()).toBe('file-bytes');
  });

  test('rejects a rowId that belongs to another form', async () => {
    const get = stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/other-internal-form/rows/sub-1/files/docs/0');
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  test('rejects out-of-range, malformed index, and non-file fields', async () => {
    const get = stubImagesGet();
    expect((await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/9')).status).toBe(404);
    expect((await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/abc')).status).toBe(404);
    expect((await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/-1')).status).toBe(404);
    expect((await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/name/0')).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  test('rejects stored keys outside the form own prefix (defense in depth)', async () => {
    const get = stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/1');
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  test('returns 404 when the R2 object is gone', async () => {
    stubImagesGet(null);
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/0');
    expect(response.status).toBe(404);
  });

  // reviewer fix: 保存 entry.type は利用者入力由来 — 不正 MIME は octet-stream へ落とす (header injection 防御)。
  test('falls back to octet-stream for malformed stored MIME types (header injection defense)', async () => {
    stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/2');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('X-Evil')).toBeNull();
  });

  test('uses RFC 5987 encoding and strips control characters from the original filename', async () => {
    stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/3');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition'))
      .toBe("attachment; filename*=UTF-8''O%27Reilly%20%28final%29__.pdf");
    expect(response.headers.get('X-Evil')).toBeNull();
  });

  test('truncates filenames without splitting a Unicode code point', async () => {
    stubImagesGet();
    const response = await call('GET', '/api/forms-advanced/internal-form/rows/sub-1/files/docs/4');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition'))
      .toBe(`attachment; filename*=UTF-8''${'a'.repeat(79)}%F0%9F%98%80`);
  });

  test('falls through to the Formaloo router for formaloo forms', async () => {
    const get = stubImagesGet();
    seedForm('formaloo-form', 'formaloo');
    seedFormalooSubmission('formaloo-sub', 'formaloo-form');
    const response = await call('GET', '/api/forms-advanced/formaloo-form/rows/formaloo-sub/files/docs/0');
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('internal hosting provider boundary', () => {
  test('admin preview copy keeps a legacy submit message when definition copy is absent', async () => {
    seedForm('legacy-copy-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET submit_message = '以前からの完了案内' WHERE id = 'legacy-copy-form'").run();

    const response = await call('GET', '/api/forms-advanced/legacy-copy-form');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { formCopy: { successMessage: '以前からの完了案内' } },
    });
  });

  test('definition save stays local and returns an internally consistent admin view', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const externalFetch = vi.fn(async () => { throw new Error('Formaloo must not run'); });
    vi.stubGlobal('fetch', externalFetch);
    bindingOverrides = { FORMALOO_API_KEY: 'unused', FORMALOO_API_SECRET: 'unused' };

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      title: '自前フォーム',
      description: '自社で受付します',
      fields: DEFINITION.fields,
      logic: [],
      formType: 'simple',
      formCopy: { buttonText: '申し込む', successMessage: 'お申し込み完了' },
      design: { themeColor: '#123456', backgroundColor: '#F0F0F0' },
      operationsSettings: {
        maxSubmitCount: 2,
        submitStartTime: '2026-07-25T00:00:00+09:00',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        id: 'internal-form', title: '自前フォーム', renderBackend: 'internal', builderStatus: 'draft',
        syncStatus: 'idle', syncError: null, publicUrl: null,
        formCopy: { buttonText: '申し込む', successMessage: 'お申し込み完了', errorMessage: '送信に失敗しました' },
        design: { themeColor: '#123456', backgroundColor: '#F0F0F0' },
        operationsSettings: { maxSubmitCount: 2, submitStartTime: '2026-07-25T00:00:00+09:00' },
      },
    });
    const stored = JSON.parse((raw.prepare(
      "SELECT definition_json FROM formaloo_forms WHERE id = 'internal-form'",
    ).get() as { definition_json: string }).definition_json);
    expect(stored).toMatchObject({
      formType: 'simple',
      formCopy: { buttonText: '申し込む', successMessage: 'お申し込み完了' },
      design: { themeColor: '#123456' },
    });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test('edit flags survive internal save, publish, exact GET, and list readback', async () => {
    seedForm('internal-edit-flags', 'internal');

    const saved = await call('PUT', '/api/forms-advanced/internal-edit-flags', {
      fields: DEFINITION.fields,
      logic: [],
      allowPostEdit: '1',
      allowBranchEdit: true,
      allowEditMail: 1,
      editMailFieldId: 'contact',
    });

    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as {
      data: {
        allowPostEdit: number;
        allowBranchEdit: number;
        allowEditMail: number;
        editMailFieldId: string | null;
        publishRevision: string;
      };
    };
    expect(savedBody.data).toMatchObject({
      allowPostEdit: 1,
      allowBranchEdit: 1,
      allowEditMail: 1,
      editMailFieldId: 'contact',
    });
    expect(raw.prepare(
      `SELECT allow_post_edit, allow_branch_edit, allow_edit_mail, edit_mail_field_slug
       FROM formaloo_forms WHERE id = ?`,
    ).get('internal-edit-flags')).toEqual({
      allow_post_edit: 1,
      allow_branch_edit: 1,
      allow_edit_mail: 1,
      edit_mail_field_slug: 'contact',
    });

    const published = await call('POST', '/api/forms-advanced/internal-edit-flags/publish', {
      publishRevision: savedBody.data.publishRevision,
    });
    expect(published.status).toBe(200);

    const loaded = await call('GET', '/api/forms-advanced/internal-edit-flags');
    expect(loaded.status).toBe(200);
    expect((await loaded.json() as { data: Record<string, unknown> }).data).toMatchObject({
      builderStatus: 'published',
      allowPostEdit: 1,
      allowBranchEdit: 1,
      allowEditMail: 1,
      editMailFieldId: 'contact',
    });

    const listed = await call('GET', '/api/forms-advanced');
    expect(listed.status).toBe(200);
    const listItem = (await listed.json() as { data: Array<Record<string, unknown>> }).data
      .find((form) => form.id === 'internal-edit-flags');
    expect(listItem).toMatchObject({
      allowPostEdit: 1,
      allowBranchEdit: 1,
      allowEditMail: 1,
      editMailFieldId: 'contact',
    });
  });

  test('internal edit flags use present-key updates and reject a non-email recipient field', async () => {
    seedForm('internal-edit-flags-present-key', 'internal');
    raw.prepare(
      `UPDATE formaloo_forms
       SET allow_post_edit = 1, allow_branch_edit = 1, allow_edit_mail = 1, edit_mail_field_slug = 'contact'
       WHERE id = ?`,
    ).run('internal-edit-flags-present-key');

    const omitted = await call('PUT', '/api/forms-advanced/internal-edit-flags-present-key', {
      title: 'フラグを維持する保存',
      fields: DEFINITION.fields,
      logic: [],
    });
    expect(omitted.status).toBe(200);
    expect((await omitted.json() as { data: Record<string, unknown> }).data).toMatchObject({
      allowPostEdit: 1,
      allowBranchEdit: 1,
      allowEditMail: 1,
      editMailFieldId: 'contact',
    });

    const invalid = await call('PUT', '/api/forms-advanced/internal-edit-flags-present-key', {
      fields: DEFINITION.fields,
      logic: [],
      allowPostEdit: 0,
      allowBranchEdit: 0,
      allowEditMail: 0,
      editMailFieldId: 'name',
    });
    expect(invalid.status).toBe(400);
    expect(raw.prepare(
      `SELECT allow_post_edit, allow_branch_edit, allow_edit_mail, edit_mail_field_slug
       FROM formaloo_forms WHERE id = ?`,
    ).get('internal-edit-flags-present-key')).toEqual({
      allow_post_edit: 1,
      allow_branch_edit: 1,
      allow_edit_mail: 1,
      edit_mail_field_slug: 'contact',
    });

    const cleared = await call('PUT', '/api/forms-advanced/internal-edit-flags-present-key', {
      fields: DEFINITION.fields,
      logic: [],
      allowPostEdit: null,
      allowBranchEdit: '0',
      allowEditMail: false,
      editMailFieldId: null,
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { data: Record<string, unknown> }).data).toMatchObject({
      allowPostEdit: 0,
      allowBranchEdit: 0,
      allowEditMail: 0,
      editMailFieldId: null,
    });
    expect(raw.prepare(
      `SELECT allow_post_edit, allow_branch_edit, allow_edit_mail, edit_mail_field_slug
       FROM formaloo_forms WHERE id = ?`,
    ).get('internal-edit-flags-present-key')).toEqual({
      allow_post_edit: 0,
      allow_branch_edit: 0,
      allow_edit_mail: 0,
      edit_mail_field_slug: null,
    });
  });

  test('an edit flag save invalidates an older publish revision', async () => {
    seedForm('internal-edit-flags-revision', 'internal');
    raw.prepare(
      "UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-edit-flags-revision'",
    ).run();
    const baseline = await call('PUT', '/api/forms-advanced/internal-edit-flags-revision', {
      fields: DEFINITION.fields,
      logic: [],
    });
    expect(baseline.status).toBe(200);
    const staleRevision = (await baseline.json() as { data: { publishRevision: string } })
      .data.publishRevision;

    const saved = await call('PUT', '/api/forms-advanced/internal-edit-flags-revision', {
      fields: DEFINITION.fields,
      logic: [],
      allowBranchEdit: 1,
    });
    expect(saved.status).toBe(200);
    const currentRevision = (await saved.json() as { data: { publishRevision: string } })
      .data.publishRevision;
    expect(currentRevision).not.toBe(staleRevision);

    const stalePublish = await call('POST', '/api/forms-advanced/internal-edit-flags-revision/publish', {
      publishRevision: staleRevision,
    });
    expect(stalePublish.status).toBe(409);
    const currentPublish = await call('POST', '/api/forms-advanced/internal-edit-flags-revision/publish', {
      publishRevision: currentRevision,
    });
    expect(currentPublish.status).toBe(200);
  });

  test('definition and edit flags are committed by one internal row update', async () => {
    seedForm('internal-edit-flags-atomic', 'internal');
    const base = DB;
    DB = {
      prepare(sql: string) {
        if (/UPDATE formaloo_forms/i.test(sql)
          && /allow_post_edit/i.test(sql)
          && !/definition_json/i.test(sql)) {
          throw new Error('split settings update rejected');
        }
        return base.prepare(sql);
      },
    } as D1Database;

    const saved = await call('PUT', '/api/forms-advanced/internal-edit-flags-atomic', {
      title: '設定も同時保存',
      fields: DEFINITION.fields,
      logic: [],
      allowPostEdit: 1,
      allowBranchEdit: 1,
      allowEditMail: 1,
      editMailFieldId: 'contact',
    });

    expect(saved.status).toBe(200);
    expect(raw.prepare(
      `SELECT title, allow_post_edit, allow_branch_edit, allow_edit_mail, edit_mail_field_slug
       FROM formaloo_forms WHERE id = ?`,
    ).get('internal-edit-flags-atomic')).toEqual({
      title: '設定も同時保存',
      allow_post_edit: 1,
      allow_branch_edit: 1,
      allow_edit_mail: 1,
      edit_mail_field_slug: 'contact',
    });
  });

  test.each([
    [
      'legacy text',
      [
        {
          id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
      ],
    ],
    [
      'native postal',
      [
        {
          id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'prefecture', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'address_city', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'address_street', label: '町名・番地', required: false, position: 3, config: {} },
      ],
    ],
  ] as const)('normal PUT and GET preserve the existing four-key postal shape for %s fields', async (kind, fields) => {
    const formId = kind === 'legacy text' ? 'legacy-postal-save' : 'native-postal-save';
    seedForm(formId, 'internal', { definition: { fields, logic: [] } });

    const saved = await call('PUT', `/api/forms-advanced/${formId}`, { fields, logic: [] });
    expect(saved.status).toBe(200);

    const loaded = await call('GET', `/api/forms-advanced/${formId}`);
    expect(loaded.status).toBe(200);
    const loadedBody = await loaded.json() as {
      data: { fields: Array<{ id: string; type: string; config: Record<string, unknown> }> };
    };
    const source = loadedBody.data.fields.find((field) => field.id === 'zip');
    expect(source?.type).toBe(fields[0].type);
    expect(source?.config.postalAutofill).toEqual({
      zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town',
    });
    expect(Object.keys(source?.config.postalAutofill as object)).toEqual([
      'zipField', 'prefField', 'cityField', 'townField',
    ]);

    const stored = JSON.parse((raw.prepare(
      'SELECT definition_json FROM formaloo_forms WHERE id = ?',
    ).get(formId) as { definition_json: string }).definition_json) as {
      fields: Array<{ id: string; type: string; config: Record<string, unknown> }>;
    };
    expect(stored.fields.find((field) => field.id === 'zip')).toEqual(source);
  });

  test('normal PUT and GET preserve the exact three-key combined postal shape', async () => {
    const fields = [
      {
        id: 'zip', type: 'postal_code', label: '郵便番号', required: true, position: 0,
        config: { postalAutofill: { mode: 'combined', zipField: 'zip', addressField: 'address' } },
      },
      { id: 'address', type: 'address', label: '住所', required: true, position: 1, config: {} },
    ];
    seedForm('combined-postal-save', 'internal', { definition: { fields, logic: [] } });

    const saved = await call('PUT', '/api/forms-advanced/combined-postal-save', { fields, logic: [] });
    expect(saved.status).toBe(200);

    const loaded = await call('GET', '/api/forms-advanced/combined-postal-save');
    expect(loaded.status).toBe(200);
    const loadedBody = await loaded.json() as {
      data: { fields: Array<{ id: string; type: string; config: Record<string, unknown> }> };
    };
    const source = loadedBody.data.fields.find((field) => field.id === 'zip');
    expect(source?.config.postalAutofill).toEqual({
      mode: 'combined', zipField: 'zip', addressField: 'address',
    });
    expect(Object.keys(source?.config.postalAutofill as object)).toEqual([
      'mode', 'zipField', 'addressField',
    ]);

    const stored = JSON.parse((raw.prepare(
      'SELECT definition_json FROM formaloo_forms WHERE id = ?',
    ).get('combined-postal-save') as { definition_json: string }).definition_json) as {
      fields: Array<{ id: string; config: Record<string, unknown> }>;
    };
    expect(stored.fields.find((field) => field.id === 'zip')?.config.postalAutofill).toEqual(
      source?.config.postalAutofill,
    );
  });

  test('internal save preserves every existing Formaloo field mapping byte-for-byte', async () => {
    seedForm('internal-form', 'internal');
    const now = jstNow();
    raw.prepare(
      `INSERT INTO formaloo_field_map
         (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'name', 'internal-form', 'remote-name', 'text', 'お名前', 0, '{"remote":"keep"}', now, now,
      'legacy', 'internal-form', 'remote-legacy', 'text', '旧項目', 1, '{"legacy":true}', now, now,
    );
    const before = raw.prepare(
      'SELECT * FROM formaloo_field_map WHERE form_id = ? ORDER BY rowid',
    ).all('internal-form');

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      title: '自前保存', fields: DEFINITION.fields, logic: [], formType: 'simple',
    });

    expect(response.status).toBe(200);
    expect(raw.prepare(
      'SELECT * FROM formaloo_field_map WHERE form_id = ? ORDER BY rowid',
    ).all('internal-form')).toEqual(before);
  });

  test('resolves internal logo and background replace intents through the existing R2 image host', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const put = vi.fn(async () => undefined);
    bindingOverrides = { IMAGES: { put } as unknown as R2Bucket };

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      fields: DEFINITION.fields,
      logic: [],
      design: {
        themeColor: '#123456',
        logoUrl: 'https://old.example.test/logo.png',
        backgroundImageUrl: 'https://old.example.test/background.png',
      },
      designImages: {
        logo: {
          intent: 'replace',
          dataUrl: 'data:image/png;base64,TE9HTw==',
          mimeType: 'image/png',
          filename: 'logo.png',
        },
        cover: {
          intent: 'replace',
          dataUrl: 'data:image/webp;base64,Q09WRVI=',
          mimeType: 'image/webp',
          filename: 'cover.webp',
        },
      },
    });

    expect(response.status).toBe(200);
    const json = await response.json() as { data: { design: { logoUrl: string; backgroundImageUrl: string } } };
    expect(json.data.design.logoUrl).toMatch(
      /^https:\/\/api\.example\.test\/images\/media\/form-image\/internal-form\/[0-9a-f-]+\.png$/,
    );
    expect(json.data.design.backgroundImageUrl).toMatch(
      /^https:\/\/api\.example\.test\/images\/media\/form-image\/internal-form\/[0-9a-f-]+\.webp$/,
    );
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.[0]).toMatch(/^media\/form-image\/internal-form\/.+\.png$/);
    expect(put.mock.calls[0]?.[2]).toEqual({ httpMetadata: { contentType: 'image/png' } });
    expect(put.mock.calls[1]?.[0]).toMatch(/^media\/form-image\/internal-form\/.+\.webp$/);
    expect(put.mock.calls[1]?.[2]).toEqual({ httpMetadata: { contentType: 'image/webp' } });

    const stored = JSON.parse((raw.prepare(
      "SELECT definition_json FROM formaloo_forms WHERE id = 'internal-form'",
    ).get() as { definition_json: string }).definition_json) as { design: Record<string, string> };
    expect(stored.design).toMatchObject({
      themeColor: '#123456',
      logoUrl: json.data.design.logoUrl,
      backgroundImageUrl: json.data.design.backgroundImageUrl,
    });
  });

  test('failed internal design image upload rejects the save and preserves definition and publish state for retry', async () => {
    seedForm('internal-form', 'internal', {
      definition: {
        ...DEFINITION,
        design: { themeColor: '#123456', logoUrl: 'https://old.example.test/logo.png' },
      },
    });
    const before = raw.prepare(
      "SELECT definition_json, builder_status FROM formaloo_forms WHERE id = 'internal-form'",
    ).get() as { definition_json: string; builder_status: string };
    bindingOverrides = {
      IMAGES: { put: vi.fn(async () => { throw new Error('R2 unavailable'); }) } as unknown as R2Bucket,
    };

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      fields: DEFINITION.fields,
      logic: [],
      design: { themeColor: '#654321', logoUrl: 'https://old.example.test/logo.png' },
      designImages: {
        logo: {
          intent: 'replace',
          dataUrl: 'data:image/png;base64,TE9HTw==',
          mimeType: 'image/png',
        },
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('画像の保存に失敗しました'),
    });
    expect(raw.prepare(
      "SELECT definition_json, builder_status FROM formaloo_forms WHERE id = 'internal-form'",
    ).get()).toEqual(before);
  });

  test('applies remove and keep internal design image intents without touching R2', async () => {
    seedForm('internal-form', 'internal', {
      definition: {
        ...DEFINITION,
        design: {
          logoUrl: 'https://old.example.test/logo.png',
          backgroundImageUrl: 'https://old.example.test/background.png',
        },
      },
    });
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const put = vi.fn(async () => undefined);
    bindingOverrides = { IMAGES: { put } as unknown as R2Bucket };

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      fields: DEFINITION.fields,
      logic: [],
      design: {
        logoUrl: 'https://old.example.test/logo.png',
        backgroundImageUrl: 'https://old.example.test/background.png',
      },
      designImages: {
        logo: { intent: 'remove' },
        cover: { intent: 'keep' },
      },
    });

    expect(response.status).toBe(200);
    const json = await response.json() as { data: { design: Record<string, string> } };
    expect(json.data.design.logoUrl).toBeUndefined();
    expect(json.data.design.backgroundImageUrl).toBe('https://old.example.test/background.png');
    expect(put).not.toHaveBeenCalled();
  });

  test('keep intent preserves an existing image when the design patch omits its URL', async () => {
    seedForm('internal-form', 'internal', {
      definition: {
        ...DEFINITION,
        design: { logoUrl: 'https://old.example.test/logo.png', themeColor: '#123456' },
      },
    });
    const put = vi.fn(async () => undefined);
    bindingOverrides = { IMAGES: { put } as unknown as R2Bucket };

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      fields: DEFINITION.fields,
      logic: [],
      design: { themeColor: '#654321' },
      designImages: { logo: { intent: 'keep' } },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { design: { themeColor: '#654321', logoUrl: 'https://old.example.test/logo.png' } },
    });
    expect(put).not.toHaveBeenCalled();
  });

  test('editing a published definition returns it to draft until publish is confirmed again', async () => {
    seedForm('internal-form', 'internal');

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      title: '公開内容を変更',
      fields: DEFINITION.fields,
      logic: [],
      formType: 'simple',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        builderStatus: 'draft',
        publicUrl: null,
        title: '公開内容を変更',
      },
    });
    expect(raw.prepare(
      'SELECT builder_status, title FROM formaloo_forms WHERE id = ?',
    ).get('internal-form')).toEqual({ builder_status: 'draft', title: '公開内容を変更' });
  });

  test('a definition save always wins a concurrent publish by atomically ending in draft', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    raw.exec(`
      CREATE TRIGGER publish_during_definition_replace
      BEFORE UPDATE OF definition_json ON formaloo_forms
      BEGIN
        UPDATE formaloo_forms SET builder_status = 'published' WHERE id = OLD.id;
      END
    `);

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      title: '競合後の定義', fields: DEFINITION.fields, logic: [], formType: 'simple',
    });

    expect(response.status).toBe(200);
    expect(raw.prepare(
      'SELECT builder_status, title FROM formaloo_forms WHERE id = ?',
    ).get('internal-form')).toEqual({ builder_status: 'draft', title: '競合後の定義' });
  });

  test('a successful save responds with its own snapshot when a later save wins before the response', async () => {
    seedForm('internal-form', 'internal');
    const laterDefinition = {
      fields: [{ id: 'later', type: 'text', label: '後から保存', required: false, position: 0, config: {} }],
      logic: [],
    };
    afterInternalDefinitionSave(() => {
      raw.prepare(
        `UPDATE formaloo_forms
         SET definition_json = ?, title = ?, builder_status = 'draft', updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(laterDefinition), '後から保存した内容', '2026-07-21T08:30:00+09:00', 'internal-form');
    });

    const response = await call('PUT', '/api/forms-advanced/internal-form', {
      title: '先に保存した内容',
      fields: [{ id: 'first', type: 'text', label: '先に保存', required: false, position: 0, config: {} }],
      logic: [],
      formType: 'simple',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        title: '先に保存した内容',
        fields: [{ id: 'first', label: '先に保存' }],
      },
    });
    expect(raw.prepare('SELECT title FROM formaloo_forms WHERE id = ?').get('internal-form'))
      .toEqual({ title: '後から保存した内容' });
  });

  test('publish compare-and-set rejects a definition changed after confirmation was loaded', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const publishRevision = await currentPublishRevision('internal-form');
    const baseDb = DB;
    let changed = false;
    DB = {
      prepare(sql: string) {
        if (!changed && sql.includes('UPDATE formaloo_forms') && sql.includes('builder_status')) {
          changed = true;
          raw.prepare(
            "UPDATE formaloo_forms SET definition_json = '{\"fields\":[],\"logic\":[],\"version\":2}' WHERE id = 'internal-form'",
          ).run();
        }
        return baseDb.prepare(sql);
      },
    } as D1Database;

    const response = await call('POST', '/api/forms-advanced/internal-form/publish', { publishRevision });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'フォーム内容が更新されたため、もう一度確認して公開してください',
    });
    expect(raw.prepare(
      'SELECT builder_status FROM formaloo_forms WHERE id = ?',
    ).get('internal-form')).toEqual({ builder_status: 'draft' });
  });

  test('publish rejects a browser confirmation revision after another editor changes only the title', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const publishRevision = await currentPublishRevision('internal-form');
    raw.prepare(
      "UPDATE formaloo_forms SET title = '別の編集者のタイトル', updated_at = '2026-07-21T15:00:00.000+09:00' WHERE id = 'internal-form'",
    ).run();

    const response = await call('POST', '/api/forms-advanced/internal-form/publish', { publishRevision });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'フォーム内容が更新されたため、もう一度確認して公開してください',
    });
    expect(raw.prepare(
      'SELECT builder_status FROM formaloo_forms WHERE id = ?',
    ).get('internal-form')).toEqual({ builder_status: 'draft' });
  });

  test('publish rejects a corrupt internal definition and keeps the draft unavailable', async () => {
    seedForm('corrupt-form', 'internal', { definition: { fields: 'broken', logic: [] } });
    raw.prepare(
      "UPDATE formaloo_forms SET builder_status = 'draft', published_at = NULL WHERE id = 'corrupt-form'",
    ).run();

    const response = await call('POST', '/api/forms-advanced/corrupt-form/publish', { publishRevision: 'invalid' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: 'フォーム項目を読み込めません',
    });
    expect(raw.prepare(
      'SELECT builder_status, published_at FROM formaloo_forms WHERE id = ?',
    ).get('corrupt-form')).toEqual({ builder_status: 'draft', published_at: null });
  });

  test('publishes a draft directly, is retry-safe, exposes honest upcoming state, and unpublishes locally', async () => {
    seedForm('internal-form', 'internal', {
      definition: {
        ...DEFINITION,
        operationsSettings: { submitStartTime: '2099-07-25T00:00:00+09:00' },
      },
    });
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft', published_at = NULL WHERE id = 'internal-form'").run();
    const externalFetch = vi.fn(async () => { throw new Error('Formaloo must not run'); });
    vi.stubGlobal('fetch', externalFetch);

    const publishRevision = await currentPublishRevision('internal-form');
    const published = await call('POST', '/api/forms-advanced/internal-form/publish', { publishRevision });
    expect(published.status).toBe(200);
    const publishedBody = await published.json() as { data: { updatedAt: string } };
    expect(publishedBody).toMatchObject({
      success: true,
      data: {
        builderStatus: 'published',
        publicUrl: 'https://api.example.test/f/internal-form',
        internalAvailability: { status: 'upcoming', message: '受付開始前・7月25日から' },
      },
    });
    const retriedPublish = await call('POST', '/api/forms-advanced/internal-form/publish', {
      publishRevision,
    });
    expect(retriedPublish.status).toBe(200);
    const retriedPublishBody = await retriedPublish.json() as { data: { updatedAt: string } };

    const share = await call('GET', '/api/forms-advanced/internal-form/share');
    expect(await share.json()).toMatchObject({
      data: {
        published: true,
        publicUrl: 'https://api.example.test/f/internal-form',
        lineDistUrl: 'https://api.example.test/fo/internal-form',
        internalAvailability: { status: 'upcoming' },
      },
    });

    const unpublished = await call('POST', '/api/forms-advanced/internal-form/unpublish', {
      expectedUpdatedAt: retriedPublishBody.data.updatedAt,
    });
    expect(unpublished.status).toBe(200);
    expect(await unpublished.json()).toMatchObject({
      success: true,
      data: { builderStatus: 'draft', publicUrl: null },
    });
    expect(externalFetch).not.toHaveBeenCalled();
  });

  test('returns success without a fallible form read after the publish commit', async () => {
    seedForm('publish-read-failure', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft', published_at = NULL WHERE id = 'publish-read-failure'").run();
    const publishRevision = await currentPublishRevision('publish-read-failure');
    failFormReadAfterStatusCommit('published');

    const response = await call('POST', '/api/forms-advanced/publish-read-failure/publish', { publishRevision });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { builderStatus: 'published', publicUrl: 'https://api.example.test/f/publish-read-failure' },
    });
    expect(raw.prepare('SELECT builder_status FROM formaloo_forms WHERE id = ?').get('publish-read-failure'))
      .toEqual({ builder_status: 'published' });
  });

  test('returns success without a fallible form read after the unpublish commit', async () => {
    seedForm('unpublish-read-failure', 'internal');
    const displayed = raw.prepare(
      'SELECT updated_at FROM formaloo_forms WHERE id = ?',
    ).get('unpublish-read-failure') as { updated_at: string };
    failFormReadAfterStatusCommit('draft');

    const response = await call('POST', '/api/forms-advanced/unpublish-read-failure/unpublish', {
      expectedUpdatedAt: displayed.updated_at,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { builderStatus: 'draft', publicUrl: null },
    });
    expect(raw.prepare('SELECT builder_status FROM formaloo_forms WHERE id = ?').get('unpublish-read-failure'))
      .toEqual({ builder_status: 'draft' });
  });

  test('a stale browser cannot unpublish a newer internal revision', async () => {
    seedForm('stale-unpublish', 'internal');
    const displayed = raw.prepare(
      'SELECT updated_at FROM formaloo_forms WHERE id = ?',
    ).get('stale-unpublish') as { updated_at: string };
    raw.prepare(
      `UPDATE formaloo_forms
       SET title = '別の編集者が公開した内容', updated_at = '2026-07-21T16:00:00.000+09:00'
       WHERE id = 'stale-unpublish'`,
    ).run();

    const response = await call('POST', '/api/forms-advanced/stale-unpublish/unpublish', {
      expectedUpdatedAt: displayed.updated_at,
    });

    expect(response.status).toBe(409);
    expect(raw.prepare(
      'SELECT title, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('stale-unpublish')).toEqual({
      title: '別の編集者が公開した内容',
      builder_status: 'published',
    });
  });

  test('unpublish compare-and-set rejects a newer revision committed after request validation', async () => {
    seedForm('unpublish-race', 'internal');
    const displayed = raw.prepare(
      'SELECT updated_at FROM formaloo_forms WHERE id = ?',
    ).get('unpublish-race') as { updated_at: string };
    beforeInternalUnpublishCommit(() => {
      raw.prepare(
        `UPDATE formaloo_forms
         SET title = '競合後に公開された内容', updated_at = '2026-07-21T16:30:00.000+09:00'
         WHERE id = 'unpublish-race'`,
      ).run();
    });

    const response = await call('POST', '/api/forms-advanced/unpublish-race/unpublish', {
      expectedUpdatedAt: displayed.updated_at,
    });

    expect(response.status).toBe(409);
    expect(raw.prepare(
      'SELECT title, builder_status FROM formaloo_forms WHERE id = ?',
    ).get('unpublish-race')).toEqual({
      title: '競合後に公開された内容',
      builder_status: 'published',
    });
  });

  test('does not introduce a review step for internal forms', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'internal-form'").run();
    const response = await call('POST', '/api/forms-advanced/internal-form/submit-for-review');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: '自前配信は公開確認画面から直接公開してください',
    });
  });

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
        lineDistUrl: 'https://internal.example.test/base/fo/internal-form',
        iframeCode: null,
        scriptCode: null,
        gsheetConnected: false,
        gsheetUrl: null,
        internalAvailability: { status: 'open', message: null },
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
    ['DELETE', '/api/forms-advanced/internal-form', undefined],
    ['GET', '/api/forms-advanced/internal-form/pull', undefined],
    ['GET', '/api/forms-advanced/internal-form/embed', undefined],
    ['GET', '/api/forms-advanced/internal-form/export.csv', undefined],
    ['POST', '/api/forms-advanced/internal-form/reapply-hosted', undefined],
    ['POST', '/api/forms-advanced/internal-form/import', { csv: 'name\n一郎' }],
    ['POST', '/api/forms-advanced/internal-form/rows/bulk-delete', { ids: ['formaloo-sub'] }],
    ['POST', '/api/forms-advanced/internal-form/gsheet/connect', undefined],
    ['GET', '/api/forms-advanced/internal-form/recurring-submissions', undefined],
    ['POST', '/api/forms-advanced/internal-form/recurring-submissions', {}],
    ['PUT', '/api/forms-advanced/internal-form/recurring-submissions/rs_1', {}],
    ['PATCH', '/api/forms-advanced/internal-form/recurring-submissions/rs_1', {}],
    ['DELETE', '/api/forms-advanced/internal-form/recurring-submissions/rs_1', undefined],
    ['GET', '/api/forms-advanced/internal-form/instant-webhook', undefined],
    ['PUT', '/api/forms-advanced/internal-form/instant-webhook', { enabled: true }],
    ['GET', '/api/forms-advanced/internal-form/drift-events', undefined],
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

describe('admin-origin edit URL issuance', () => {
  test('inherits admin auth, binds one internal row, and returns only an opaque /ife/ URL', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare("UPDATE formaloo_forms SET allow_post_edit = 1 WHERE id = 'internal-form'").run();
    seedInternalSubmission(
      'sub-1',
      'internal-form',
      { name: '一郎', contact: 'one@example.test' },
      '2026-07-01T10:00:00+09:00',
    );
    raw.prepare(
      `INSERT INTO internal_form_notification_settings
         (form_id, enabled, edit_link_epoch, created_at, updated_at)
       VALUES ('internal-form', 1, 4, '2026-07-23T00:00:00+09:00', '2026-07-23T00:00:00+09:00')`,
    ).run();
    bindingOverrides = { FORMALOO_EDIT_TOKEN_SECRET: 'admin-origin-test-secret' };
    const path = '/api/forms-advanced/internal-form/rows/sub-1/admin-edit-url';

    expect((await call('POST', path, undefined, { auth: '' })).status).toBe(401);

    const roleId = (await createRole(DB, { name: '回答編集URL発行不可' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('edit-url-denied', 'edit-url-denied-key', roleId);
    expect((await call('POST', path, undefined, {
      auth: 'Bearer edit-url-denied-key',
    })).status).toBe(403);

    const issued = await call('POST', path);
    expect(issued.status).toBe(200);
    const data = (await issued.json() as { data: { editUrl: string } }).data;
    expect(data.editUrl).toMatch(/^https:\/\/api\.example\.test\/ife\/[^/?#]+$/);
    expect(data.editUrl).not.toContain('sub-1');

    expect((await call(
      'POST',
      '/api/forms-advanced/internal-form/rows/other-row/admin-edit-url',
    )).status).toBe(404);
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

  test('internal form detail exposes workspaceId to owners only', async () => {
    seedForm('internal-form', 'internal');
    raw.prepare(
      "UPDATE formaloo_forms SET workspace_id = 'workspace-secret' WHERE id = 'internal-form'",
    ).run();
    const roleId = (await createRole(DB, { name: 'フォーム閲覧可' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: true }]);
    seedStaff('allowed-staff', 'allowed-key', roleId);

    const owner = await call('GET', '/api/forms-advanced/internal-form');
    expect(owner.status).toBe(200);
    expect((await owner.json() as { data: Record<string, unknown> }).data)
      .toHaveProperty('workspaceId', 'workspace-secret');

    const staff = await call('GET', '/api/forms-advanced/internal-form', undefined, {
      auth: 'Bearer allowed-key',
    });
    expect(staff.status).toBe(200);
    expect((await staff.json() as { data: Record<string, unknown> }).data)
      .not.toHaveProperty('workspaceId');
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
    ['PUT', '/api/forms-advanced/formaloo-form', { title: '' }],
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

  test('formaloo publish transition response remains byte-identical through the pre-router', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T04:30:00.000Z'));
    seedForm('formaloo-form', 'formaloo');
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'in_review', published_at = NULL WHERE id = 'formaloo-form'").run();
    const existing = await call('POST', '/api/forms-advanced/formaloo-form/publish', undefined, { withInternalRouter: false });
    const expectedStatus = existing.status;
    const expectedBody = await existing.text();

    raw.prepare("UPDATE formaloo_forms SET builder_status = 'in_review', published_at = NULL WHERE id = 'formaloo-form'").run();
    const stacked = await call('POST', '/api/forms-advanced/formaloo-form/publish');
    expect(stacked.status).toBe(expectedStatus);
    expect(await stacked.text()).toBe(expectedBody);
  });

  test('index mounts the pre-router before formsAdvanced', () => {
    const source = readFileSync(join(__dirname, '../index.ts'), 'utf8');
    const preRouterMount = source.indexOf("app.route('/', internalFormsAdmin);");
    const formalooMount = source.indexOf("app.route('/', formsAdvanced);");
    expect(preRouterMount).toBeGreaterThan(-1);
    expect(preRouterMount).toBeLessThan(formalooMount);
  });
});
