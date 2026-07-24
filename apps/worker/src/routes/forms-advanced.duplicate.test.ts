import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { saveFormalooDefinition } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

const SOURCE_DEFINITION = {
  fields: [
    {
      id: 'name',
      type: 'text',
      label: '氏名',
      required: true,
      position: 0,
      config: { placeholder: '山田 花子' },
    },
    {
      id: 'plan',
      type: 'radio',
      label: '参加プラン',
      required: true,
      position: 1,
      config: { choices: ['昼', '夜'] },
    },
  ],
  logic: [
    {
      id: 'logic-1',
      sourceFieldId: 'plan',
      operator: 'equals',
      value: '夜',
      action: 'show',
      targetFieldId: 'name',
      conditions: [{ sourceFieldId: 'plan', operator: 'equals', value: '夜' }],
      actions: [{ action: 'show', targetFieldId: 'name' }],
    },
  ],
  design: {
    presetId: 'line-green',
    primaryColor: '#06C755',
    backgroundColor: '#FFFFFF',
  },
  formType: 'multi_step',
  formCopy: {
    buttonText: '申し込む',
    successMessage: '受付しました',
  },
  formRedirect: {
    url: 'https://example.com/thanks',
  },
  successPages: [
    {
      id: 'success-1',
      slug: 'remote-success-page',
      title: '完了',
      description: 'お申し込みありがとうございます',
    },
  ],
  operationsSettings: {
    closeOnLimit: true,
    responseLimit: 100,
  },
  formalooAddress: 'https://formaloo.example.test/source-form',
  rawLogic: [{ remote: 'provider-owned' }],
  logicFingerprint: 'source-provider-fingerprint',
};

const failNextRuns = new Map<string, number>();

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
          for (const [fragment, remaining] of failNextRuns) {
            if (remaining > 0 && sql.includes(fragment)) {
              failNextRuns.set(fragment, remaining - 1);
              throw new Error(`forced D1 failure: ${fragment}`);
            }
          }
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
    API_KEY: 'duplicate-owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
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
  return app().request(
    path,
    {
      method,
      headers: {
        Authorization: 'Bearer duplicate-owner-key',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env(),
  );
}

function seedSource(
  id: string,
  lineAccountId: string,
  title = '夢花火2026申し込み',
  definition: Record<string, unknown> = SOURCE_DEFINITION,
) {
  raw.prepare(
    `INSERT INTO formaloo_forms (
       id, formaloo_slug, title, description, definition_json,
       on_submit_actions_json, submit_message, submit_count,
       builder_status, published_at, gsheet_connected, gsheet_url,
       line_account_id, folder_id,
       allow_post_edit, allow_branch_edit, allow_edit_mail, edit_mail_field_slug, edit_link_epoch,
       friend_metadata_mappings_json,
       formaloo_webhook_enabled, formaloo_webhook_id, formaloo_webhook_secret, formaloo_webhook_url
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `remote-${id}`,
    title,
    '夏祭りの申込フォーム',
    JSON.stringify(definition),
    JSON.stringify([{ type: 'add_tag', tagId: 'festival-attendee' }]),
    'お申し込みを受け付けました',
    2,
    'published',
    '2026-07-01T10:00:00+09:00',
    1,
    'https://docs.google.com/spreadsheets/d/source',
    lineAccountId,
    null,
    1,
    1,
    1,
    'email-field',
    7,
    JSON.stringify([{ fieldSlug: 'name', metadataKey: 'display_name' }]),
    1,
    `webhook-${id}`,
    'webhook-secret',
    'https://api.example.test/webhooks/formaloo',
  );
}

function seedFieldMap(
  formId: string,
  definition: {
    fields: Array<{
      id: string;
      type: string;
      label: string;
      position: number;
      config: Record<string, unknown>;
    }>;
  },
) {
  for (const field of definition.fields) {
    raw.prepare(
      `INSERT INTO formaloo_field_map
         (id, form_id, formaloo_field_slug, field_type, label, position, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      field.id,
      formId,
      `remote-${field.id}`,
      field.type,
      field.label,
      field.position,
      JSON.stringify(field.config),
    );
  }
}

function seedSubmission(id: string, formId: string) {
  raw.prepare(
    `INSERT INTO formaloo_submissions
       (id, form_id, formaloo_slug, answers_json, submitted_at, verified)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(id, formId, `row-${id}`, JSON.stringify({ name: '回答者' }), '2026-07-20T12:00:00+09:00');
}

function readForm(id: string): Record<string, unknown> {
  return raw.prepare('SELECT * FROM formaloo_forms WHERE id = ?').get(id) as Record<string, unknown>;
}

function readSubmissions(formId: string): Array<Record<string, unknown>> {
  return raw.prepare('SELECT * FROM formaloo_submissions WHERE form_id = ? ORDER BY id').all(formId) as Array<Record<string, unknown>>;
}

function readFieldMap(formId: string): Array<Record<string, unknown>> {
  return raw.prepare('SELECT * FROM formaloo_field_map WHERE form_id = ? ORDER BY position').all(formId) as Array<Record<string, unknown>>;
}

function semanticDefinition(rawDefinition: Record<string, unknown>) {
  const definition = structuredClone(rawDefinition) as {
    fields?: Array<Record<string, unknown> & { id?: string; config?: Record<string, unknown> }>;
    logic?: Array<Record<string, unknown>>;
    successPages?: Array<Record<string, unknown> & { id?: string }>;
    [key: string]: unknown;
  };
  delete definition.formalooAddress;
  delete definition.rawLogic;
  delete definition.logicFingerprint;

  const idMap = new Map<string, string>();
  for (const [index, field] of (definition.fields ?? []).entries()) {
    if (typeof field.id === 'string') idMap.set(field.id, `field-${index}`);
  }
  for (const [index, page] of (definition.successPages ?? []).entries()) {
    if (typeof page.id === 'string') idMap.set(page.id, `success-${index}`);
    delete page.slug;
  }
  const mapId = (value: unknown) => typeof value === 'string' ? (idMap.get(value) ?? value) : value;
  const mapFormula = (value: unknown) => typeof value === 'string'
    ? value.replace(/\{([^{}]+)\}/g, (whole, id: string) => `{${String(mapId(id))}}`)
    : value;

  for (const field of definition.fields ?? []) {
    field.id = mapId(field.id) as string;
    if (field.config) {
      if ('formula' in field.config) field.config.formula = mapFormula(field.config.formula);
      if (field.config.postalAutofill && typeof field.config.postalAutofill === 'object') {
        for (const key of ['zipField', 'prefField', 'cityField', 'townField', 'addressField']) {
          const postal = field.config.postalAutofill as Record<string, unknown>;
          if (key in postal) postal[key] = mapId(postal[key]);
        }
      }
      if (Array.isArray(field.config.repeatingColumns)) {
        field.config.repeatingColumns = field.config.repeatingColumns.map((column) => {
          const next = { ...(column as Record<string, unknown>), columnField: mapId((column as Record<string, unknown>).columnField) };
          delete next.slug;
          return next;
        });
      }
      delete field.config.choiceItems;
    }
  }
  for (const [index, rule] of (definition.logic ?? []).entries()) {
    rule.id = `logic-${index}`;
    rule.sourceFieldId = mapId(rule.sourceFieldId);
    rule.targetFieldId = mapId(rule.targetFieldId);
    if (Array.isArray(rule.conditions)) {
      rule.conditions = rule.conditions.map((condition) => ({
        ...(condition as Record<string, unknown>),
        sourceFieldId: mapId((condition as Record<string, unknown>).sourceFieldId),
      }));
    }
    if (Array.isArray(rule.actions)) {
      rule.actions = rule.actions.map((action) => ({
        ...(action as Record<string, unknown>),
        targetFieldId: mapId((action as Record<string, unknown>).targetFieldId),
      }));
    }
    delete rule.raw;
  }
  for (const page of definition.successPages ?? []) page.id = mapId(page.id) as string;
  return definition;
}

async function listIds(lineAccountId: string): Promise<string[]> {
  const response = await call('GET', `/api/forms-advanced?lineAccountId=${encodeURIComponent(lineAccountId)}`);
  const body = await response.json() as { data: Array<{ id: string }> };
  return body.data.map((form) => form.id);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  failNextRuns.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/forms-advanced/:id/duplicate', () => {
  test('D-1: 定義とフォーム内設定だけをコピーし、下書き・回答0件・外部連携なしで元フォームを不変に保つ', async () => {
    seedSource('source-a', 'account-a');
    seedFieldMap('source-a', SOURCE_DEFINITION);
    seedSubmission('answer-1', 'source-a');
    seedSubmission('answer-2', 'source-a');
    const sourceBefore = structuredClone(readForm('source-a'));
    const submissionsBefore = structuredClone(readSubmissions('source-a'));
    const fieldMapBefore = structuredClone(readFieldMap('source-a'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await call(
      'POST',
      '/api/forms-advanced/source-a/duplicate',
      { lineAccountId: 'account-a' },
    );

    expect(response.status).toBe(201);
    const body = await response.json() as {
      data: {
        id: string;
        title: string;
        description: string | null;
        builderStatus: string;
        publishedAt: string | null;
        submitCount: number;
        fields: Array<{ id: string; type: string; label: string; position: number; config: Record<string, unknown> }>;
        logic: Array<Record<string, unknown>>;
        lineAccountId: string | null;
      };
    };
    expect(body.data.id).not.toBe('source-a');
    expect(body.data).toMatchObject({
      title: '夢花火2026申し込み のコピー',
      description: '夏祭りの申込フォーム',
      builderStatus: 'draft',
      publishedAt: null,
      submitCount: 0,
      lineAccountId: 'account-a',
    });

    const duplicate = readForm(body.data.id);
    const duplicateDefinition = JSON.parse(String(duplicate.definition_json)) as Record<string, unknown>;
    expect(semanticDefinition(duplicateDefinition)).toEqual(semanticDefinition(SOURCE_DEFINITION));
    expect((duplicateDefinition.fields as Array<{ id: string }>).map((field) => field.id))
      .not.toEqual(SOURCE_DEFINITION.fields.map((field) => field.id));
    expect(duplicateDefinition).not.toHaveProperty('formalooAddress');
    expect(duplicateDefinition).not.toHaveProperty('rawLogic');
    expect(duplicateDefinition).not.toHaveProperty('logicFingerprint');
    expect((duplicateDefinition.successPages as Array<Record<string, unknown>>)[0]).not.toHaveProperty('slug');
    expect(duplicate.on_submit_actions_json).toBe(sourceBefore.on_submit_actions_json);
    expect(duplicate.submit_message).toBe(sourceBefore.submit_message);
    expect(duplicate.formaloo_slug).toBeNull();
    expect(duplicate.builder_status).toBe('draft');
    expect(duplicate.published_at).toBeNull();
    expect(duplicate.submit_count).toBe(0);
    expect(duplicate.gsheet_connected).toBe(0);
    expect(duplicate.gsheet_url).toBeNull();
    expect(duplicate.formaloo_webhook_enabled).toBe(0);
    expect(duplicate.formaloo_webhook_id).toBeNull();
    expect(duplicate.formaloo_webhook_secret).toBeNull();
    expect(duplicate.formaloo_webhook_url).toBeNull();
    expect(duplicate.allow_post_edit).toBe(0);
    expect(duplicate.allow_branch_edit).toBe(0);
    expect(duplicate.allow_edit_mail).toBe(0);
    expect(duplicate.edit_mail_field_slug).toBeNull();
    expect(duplicate.edit_link_epoch).toBe(0);
    expect(duplicate.friend_metadata_mappings_json).toBe('[]');
    expect(readSubmissions(body.data.id)).toEqual([]);

    const duplicateMap = readFieldMap(body.data.id);
    expect(duplicateMap).toHaveLength(SOURCE_DEFINITION.fields.length);
    expect(duplicateMap.every((field) => field.formaloo_field_slug === null)).toBe(true);
    expect(duplicateMap.map((field) => field.id)).not.toEqual(fieldMapBefore.map((field) => field.id));

    await expect(saveFormalooDefinition(DB, body.data.id, {
      definitionJson: String(duplicate.definition_json),
      fields: body.data.fields.map((field) => ({
        id: field.id,
        fieldType: field.type,
        label: field.label,
        position: field.position,
        configJson: JSON.stringify(field.config),
      })),
    })).resolves.toBeUndefined();

    expect(readForm('source-a')).toEqual(sourceBefore);
    expect(readSubmissions('source-a')).toEqual(submissionsBefore);
    expect(readFieldMap('source-a')).toEqual(fieldMapBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('D-2: 複製後の一覧・詳細を往復でき、別アカウントには現れず別アカウントから複製できない', async () => {
    seedSource('source-a', 'account-a', 'A社イベント');
    seedSource('source-b', 'account-b', 'B社イベント');

    const response = await call(
      'POST',
      '/api/forms-advanced/source-a/duplicate',
      { lineAccountId: 'account-a' },
    );
    expect(response.status).toBe(201);
    const created = (await response.json() as { data: { id: string } }).data;

    expect(await listIds('account-a')).toContain(created.id);
    expect(await listIds('account-b')).not.toContain(created.id);

    const detail = await call('GET', `/api/forms-advanced/${created.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      data: {
        title: string;
        fields: Array<{ id: string; label: string }>;
        logic: Array<{ sourceFieldId: string; targetFieldId: string }>;
        lineAccountId: string | null;
      };
    };
    expect(detailBody.data).toMatchObject({
      title: 'A社イベント のコピー',
      lineAccountId: 'account-a',
    });
    expect(detailBody.data.fields.map((field) => field.label)).toEqual(['氏名', '参加プラン']);
    const idsByLabel = new Map(detailBody.data.fields.map((field) => [field.label, field.id]));
    expect(detailBody.data.logic[0]).toMatchObject({
      sourceFieldId: idsByLabel.get('参加プラン'),
      targetFieldId: idsByLabel.get('氏名'),
    });

    const countBefore = (raw.prepare('SELECT COUNT(*) AS count FROM formaloo_forms').get() as { count: number }).count;
    const crossAccount = await call(
      'POST',
      '/api/forms-advanced/source-b/duplicate',
      { lineAccountId: 'account-a' },
    );
    expect(crossAccount.status).toBe(404);
    expect((raw.prepare('SELECT COUNT(*) AS count FROM formaloo_forms').get() as { count: number }).count).toBe(countBefore);
  });

  test('D-2: フォルダ内のフォームは同じ account の同じフォルダへ複製され、その一覧に現れる', async () => {
    raw.prepare(
      `INSERT INTO formaloo_folders
         (id, line_account_id, name, parent_id, position, created_at, updated_at)
       VALUES ('folder-a', 'account-a', 'イベント', NULL, 0, '2026-07-24', '2026-07-24')`,
    ).run();
    seedSource('source-folder', 'account-a', 'フォルダ内フォーム');
    raw.prepare(`UPDATE formaloo_forms SET folder_id = 'folder-a' WHERE id = 'source-folder'`).run();

    const response = await call(
      'POST',
      '/api/forms-advanced/source-folder/duplicate',
      { lineAccountId: 'account-a' },
    );

    expect(response.status).toBe(201);
    const created = (await response.json() as { data: { id: string; folderId: string | null } }).data;
    expect(created.folderId).toBe('folder-a');
    expect(readForm(created.id).folder_id).toBe('folder-a');

    const list = await call(
      'GET',
      '/api/forms-advanced?lineAccountId=account-a&folderId=folder-a',
    );
    const listed = (await list.json() as { data: Array<{ id: string }> }).data;
    expect(listed.map((form) => form.id)).toContain(created.id);
  });

  test('D-1: provider choice slug・複合 raw logic・matrix identity を新フォームへ持ち込まず意味を保つ', async () => {
    const complexDefinition = structuredClone(SOURCE_DEFINITION) as Record<string, unknown> & {
      fields: Array<Record<string, unknown> & {
        id: string;
        type: string;
        label: string;
        position: number;
        config: Record<string, unknown>;
      }>;
      logic: Array<Record<string, unknown>>;
      rawLogic: unknown[];
    };
    complexDefinition.fields[1]!.config.choiceItems = [
      { title: '昼', slug: 'remote-day' },
      { title: '夜', slug: 'remote-night' },
    ];
    complexDefinition.fields.push({
      id: 'matrix',
      type: 'matrix',
      label: '満足度',
      required: false,
      position: 2,
      config: {
        matrixChoiceItems: {
          quality: { title: '良い', slug: 'REMOTE_MATRIX_CHOICE' },
        },
        matrixChoiceGroups: [
          { refId: 'REMOTE_ROW_REF', slug: 'REMOTE_ROW_SLUG', title: '接客', jsonKey: 'remote_row_key' },
        ],
      },
    });
    const rawLogicItem = {
      type: 'field',
      identifier: 'remote-plan',
      actions: [{
        action: 'show',
        args: [{ type: 'field', identifier: 'remote-name' }],
        when: {
          operation: 'and',
          args: [
            {
              operation: 'is',
              args: [
                { type: 'field', value: 'remote-plan' },
                { type: 'choice', value: 'remote-night' },
              ],
            },
            {
              operation: 'is_answered',
              args: [{ type: 'field', value: 'remote-name' }],
            },
          ],
        },
      }],
    };
    complexDefinition.logic = [{
      id: 'complex-logic',
      sourceFieldId: 'plan',
      operator: 'equals',
      value: 'remote-night',
      action: 'show',
      targetFieldId: 'name',
      conditions: [
        { sourceFieldId: 'plan', operator: 'is', value: 'remote-night' },
        { sourceFieldId: 'name', operator: 'is_answered', value: '' },
      ],
      conditionJoin: 'and',
      actions: [{ action: 'show', targetFieldId: 'name' }],
      raw: rawLogicItem,
    }];
    complexDefinition.rawLogic = [rawLogicItem];
    complexDefinition.logicFingerprint = 'source-complex-fingerprint';

    seedSource('source-complex', 'account-a', '複合フォーム', complexDefinition);
    seedFieldMap('source-complex', complexDefinition);

    const response = await call(
      'POST',
      '/api/forms-advanced/source-complex/duplicate',
      { lineAccountId: 'account-a' },
    );

    expect(response.status).toBe(201);
    const created = (await response.json() as { data: { id: string } }).data;
    const definition = JSON.parse(String(readForm(created.id).definition_json)) as {
      fields: Array<{ id: string; label: string; config: Record<string, unknown> }>;
      logic: Array<Record<string, unknown>>;
      rawLogic?: unknown;
      rawLogicTemplate?: unknown;
      logicFingerprint?: string;
    };
    const choice = definition.fields.find((field) => field.label === '参加プラン');
    const matrix = definition.fields.find((field) => field.label === '満足度');
    expect(choice?.config).not.toHaveProperty('choiceItems');
    expect(definition.logic[0]?.value).toBe('夜');
    expect((definition.logic[0]?.conditions as Array<Record<string, unknown>>)[0]?.value).toBe('夜');
    expect(definition.logic[0]).not.toHaveProperty('raw');
    expect(definition.rawLogic).toBeUndefined();
    expect(Array.isArray(definition.rawLogicTemplate)).toBe(true);
    expect(definition.logicFingerprint).toBeTruthy();
    expect(JSON.stringify(definition.rawLogicTemplate)).toContain('"夜"');
    expect(JSON.stringify(definition.rawLogicTemplate)).toContain('__harnessChoiceFieldId');
    expect(JSON.stringify(definition)).not.toMatch(
      /remote-plan|remote-name|remote-night|REMOTE_MATRIX_CHOICE|REMOTE_ROW_REF|REMOTE_ROW_SLUG|remote_row_key/,
    );
    expect(matrix?.config.matrixChoiceGroups).toEqual([{ title: '接客' }]);
    expect(matrix?.config.matrixChoiceItems).toEqual({ column_1: { title: '良い' } });
  });

  test('D-1: 途中失敗と子行 cleanup 失敗が重なっても部分フォームを一覧へ残さない', async () => {
    seedSource('source-cleanup', 'account-a', 'cleanup test');
    seedFieldMap('source-cleanup', SOURCE_DEFINITION);
    failNextRuns.set('INSERT INTO formaloo_field_map', 1);
    failNextRuns.set('DELETE FROM formaloo_choice_lists WHERE form_id = ?', 1);

    const response = await call(
      'POST',
      '/api/forms-advanced/source-cleanup/duplicate',
      { lineAccountId: 'account-a' },
    );

    expect(response.status).toBe(500);
    const copies = raw.prepare(
      `SELECT id, deleted FROM formaloo_forms WHERE id <> 'source-cleanup'`,
    ).all() as Array<{ id: string; deleted: number }>;
    expect(copies).toHaveLength(1);
    expect(copies[0]?.deleted).toBe(1);
    expect(await listIds('account-a')).toEqual(['source-cleanup']);
  });

  test('D-1: 途中失敗後の論理削除まで失敗しても部分フォームを一覧へ露出しない', async () => {
    seedSource('source-hidden-cleanup', 'account-a', 'hidden cleanup test');
    seedFieldMap('source-hidden-cleanup', SOURCE_DEFINITION);
    failNextRuns.set('INSERT INTO formaloo_field_map', 1);
    failNextRuns.set('UPDATE formaloo_forms SET deleted = 1', 1);

    const response = await call(
      'POST',
      '/api/forms-advanced/source-hidden-cleanup/duplicate',
      { lineAccountId: 'account-a' },
    );

    expect(response.status).toBe(500);
    const copies = raw.prepare(
      `SELECT id, deleted FROM formaloo_forms WHERE id <> 'source-hidden-cleanup'`,
    ).all() as Array<{ id: string; deleted: number }>;
    expect(copies).toHaveLength(1);
    expect(copies[0]?.deleted).toBe(1);
    expect(await listIds('account-a')).toEqual(['source-hidden-cleanup']);
  });

  test('D-1: フォーム内の管理選択肢リストを独立コピーし、元フォームURLへの参照を残さない', async () => {
    const sourceDefinition = structuredClone(SOURCE_DEFINITION) as Record<string, unknown> & {
      fields: Array<Record<string, unknown>>;
    };
    sourceDefinition.fields.push({
      id: 'venue',
      type: 'choice_fetch',
      label: '会場',
      required: true,
      position: 2,
      config: {
        choiceListId: 'list-source',
        choicesSource: 'https://api.example.test/formaloo/choices/source-choice/list-source',
        choiceFetchItems: [
          { label: '第一会場', value: 'venue-1' },
          { label: '第二会場', value: 'venue-2' },
        ],
      },
    });
    seedSource('source-choice', 'account-a', '会場申込', sourceDefinition);
    raw.prepare(
      `INSERT INTO formaloo_choice_lists (id, form_id, name, items_json)
       VALUES (?, ?, ?, ?)`,
    ).run(
      'list-source',
      'source-choice',
      '会場一覧',
      JSON.stringify([
        { label: '第一会場', value: 'venue-1' },
        { label: '第二会場', value: 'venue-2' },
      ]),
    );
    const sourceListBefore = raw.prepare(
      'SELECT * FROM formaloo_choice_lists WHERE id = ?',
    ).get('list-source') as Record<string, unknown>;

    const response = await call(
      'POST',
      '/api/forms-advanced/source-choice/duplicate',
      { lineAccountId: 'account-a' },
    );

    expect(response.status).toBe(201);
    const created = (await response.json() as { data: { id: string } }).data;
    const definition = JSON.parse(String(readForm(created.id).definition_json)) as {
      fields: Array<{ label: string; config: Record<string, unknown> }>;
    };
    const choiceField = definition.fields.find((field) => field.label === '会場');
    expect(choiceField).toBeTruthy();
    expect(choiceField?.config.choiceListId).not.toBe('list-source');
    expect(choiceField?.config.choicesSource).toBe(
      `https://api.example.test/formaloo/choices/${created.id}/${String(choiceField?.config.choiceListId)}`,
    );
    expect(String(choiceField?.config.choicesSource)).not.toContain('/source-choice/');

    const targetLists = raw.prepare(
      'SELECT id, form_id, name, items_json FROM formaloo_choice_lists WHERE form_id = ?',
    ).all(created.id) as Array<Record<string, unknown>>;
    expect(targetLists).toHaveLength(1);
    expect(targetLists[0]).toMatchObject({
      id: choiceField?.config.choiceListId,
      form_id: created.id,
      name: '会場一覧',
      items_json: sourceListBefore.items_json,
    });
    expect(raw.prepare('SELECT * FROM formaloo_choice_lists WHERE id = ?').get('list-source'))
      .toEqual(sourceListBefore);
  });
});
