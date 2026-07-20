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
import { internalFormsAdmin } from './internal-forms-admin.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

type D1MockOptions = {
  maxBindingBytes?: number;
  observedBindingBytes?: number[];
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
  vi.useRealTimers();
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

  test('rejects a backend switch when the saved definition is incompatible with the destination', async () => {
    seedForm('internal-only-form', 'internal', {
      definition: {
        fields: [{ id: 'appointment', type: 'datetime', label: '日時', required: true, position: 0, config: {} }],
        logic: [],
      },
    });
    seedForm('branched-form', 'formaloo', {
      definition: {
        ...DEFINITION,
        logic: [{ id: 'rule', sourceFieldId: 'name', operator: 'equals', value: 'A', action: 'show', targetFieldId: 'contact' }],
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

    const toInternal = await call('PATCH', '/api/forms-advanced/branched-form/render-backend', {
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
    expect(raw.prepare('SELECT render_backend FROM formaloo_forms WHERE id = ?').get('branched-form'))
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
        config: { maxLength: 40, unknownConfig: 'drop-me' },
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
        { id: 'name', type: 'text', label: '氏名', required: true, position: 0, config: { maxLength: 40 } },
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
        position: 0, config_json: '{"maxLength":40}',
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
        id: 'internal-form', title: '自前フォーム', builderStatus: 'draft',
        syncStatus: 'idle', syncError: null, publicUrl: null,
        design: { themeColor: '#123456', backgroundColor: '#F0F0F0' },
        operationsSettings: { maxSubmitCount: 2, submitStartTime: '2026-07-25T00:00:00+09:00' },
      },
    });
    const stored = JSON.parse((raw.prepare(
      "SELECT definition_json FROM formaloo_forms WHERE id = 'internal-form'",
    ).get() as { definition_json: string }).definition_json);
    expect(stored).toMatchObject({ formType: 'simple', design: { themeColor: '#123456' } });
    expect(externalFetch).not.toHaveBeenCalled();
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

    const published = await call('POST', '/api/forms-advanced/internal-form/publish');
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      success: true,
      data: {
        builderStatus: 'published',
        publicUrl: 'https://api.example.test/f/internal-form',
        internalAvailability: { status: 'upcoming', message: '受付開始前・7月25日から' },
      },
    });
    expect((await call('POST', '/api/forms-advanced/internal-form/publish')).status).toBe(200);

    const share = await call('GET', '/api/forms-advanced/internal-form/share');
    expect(await share.json()).toMatchObject({
      data: {
        published: true,
        publicUrl: 'https://api.example.test/f/internal-form',
        lineDistUrl: 'https://api.example.test/fo/internal-form',
        internalAvailability: { status: 'upcoming' },
      },
    });

    const unpublished = await call('POST', '/api/forms-advanced/internal-form/unpublish');
    expect(unpublished.status).toBe(200);
    expect(await unpublished.json()).toMatchObject({
      success: true,
      data: { builderStatus: 'draft', publicUrl: null },
    });
    expect(externalFetch).not.toHaveBeenCalled();
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
