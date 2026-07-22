// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { editTokenExp, signEditToken } from '../services/formaloo-edit-token.js';
import { initInternalFormLogic } from '../client/internal-form-logic.js';
const sheetsSyncMocks = vi.hoisted(() => ({
  syncSheetsAfterFormMutation: vi.fn(),
}));
vi.mock('../services/sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/sheets-sync-jobs.js')>(),
  syncSheetsAfterFormMutation: sheetsSyncMocks.syncSheetsAfterFormMutation,
}));
import { internalFormEditPublic } from './internal-form-edit-public.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const EDIT_SECRET = 'internal-edit-route-secret';

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

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(statement); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

const definition = {
  fields: [
    { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: { maxLength: 20 } },
    { id: 'email', type: 'email', label: 'メール', required: true, position: 1, config: {} },
    { id: 'attachment', type: 'file', label: '添付', required: true, position: 2, config: {} },
    { id: 'signature', type: 'signature', label: '署名', required: true, position: 3, config: {} },
    {
      id: 'matrix', type: 'matrix', label: '評価', required: true, position: 4,
      config: {
        matrixChoiceItems: { good: { title: '良い' }, bad: { title: '悪い' } },
        matrixChoiceGroups: [{ title: '接客' }],
      },
    },
    { id: 'repeat_name', type: 'text', label: '参加者名', required: true, position: 5, config: {} },
    { id: 'repeat_age', type: 'number', label: '年齢', required: true, position: 6, config: {} },
    {
      id: 'repeat', type: 'repeating_section', label: '参加者', required: true, position: 7,
      config: {
        repeatingColumns: [
          { columnField: 'repeat_name', title: '氏名' },
          { columnField: 'repeat_age', title: '年齢' },
        ],
        minRows: 1,
        maxRows: 3,
      },
    },
  ],
  logic: [],
};

const originalAnswers = {
  name: '佐藤 <script>',
  email: 'old@example.test',
  attachment: [{ key: 'private/file.pdf', name: '申込書.pdf', size: 123, type: 'application/pdf' }],
  signature: 'data:image/png;base64,c2lnbmF0dXJl',
  matrix: { 接客: '良い' },
  repeat: [{ repeat_name: '田中', repeat_age: 20 }],
};

const conditionalDefinition = {
  fields: [
    { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: ['個人', '法人'] } },
    { id: 'personal', type: 'text', label: 'お名前', required: true, position: 1, config: {} },
    { id: 'company', type: 'text', label: '会社名', required: true, position: 2, config: {} },
  ],
  logic: [
    { id: 'show-personal', sourceFieldId: 'kind', operator: 'equals', value: '個人', action: 'show', targetFieldId: 'personal' },
    { id: 'show-company', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'show', targetFieldId: 'company' },
  ],
};

let raw: Database.Database;
let DB: D1Database;

function bindings(
  db = DB,
  overrides: Partial<Env['Bindings']> = {},
): Env['Bindings'] {
  return {
    DB: db,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's',
    LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'c',
    LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls',
    WORKER_URL: 'https://worker.example.test',
    FORMALOO_EDIT_TOKEN_SECRET: EDIT_SECRET,
    ...overrides,
  } as Env['Bindings'];
}

function rotateEpochBeforeSubmissionUpdate(): D1Database {
  let rotated = false;
  return {
    prepare(sql: string) {
      if (!rotated && /^\s*UPDATE internal_form_submissions\b/.test(sql)) {
        raw.prepare(
          'UPDATE internal_form_notification_settings SET edit_link_epoch = edit_link_epoch + 1 WHERE form_id = ?',
        ).run('form-1');
        rotated = true;
      }
      return DB.prepare(sql);
    },
  } as D1Database;
}

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormEditPublic);
  return hono;
}

function seedForm(options: {
  id?: string;
  backend?: 'formaloo' | 'internal';
  status?: string;
  epoch?: number;
  withSettings?: boolean;
  definition?: unknown;
  allowBranchEdit?: number;
} = {}): string {
  const id = options.id ?? 'form-1';
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, builder_status, render_backend, allow_branch_edit)
     VALUES (?, '回答編集テスト', ?, ?, ?, ?)`,
  ).run(
    id,
    JSON.stringify(options.definition ?? definition),
    options.status ?? 'published',
    options.backend ?? 'internal',
    options.allowBranchEdit ?? 0,
  );
  if (options.withSettings !== false) {
    raw.prepare(
      `INSERT INTO internal_form_notification_settings
         (form_id, enabled, recipient_email_field_id, message_template, edit_link_epoch, created_at, updated_at)
       VALUES (?, 1, 'email', NULL, ?, '2026-07-21T00:00:00+09:00', '2026-07-21T00:00:00+09:00')`,
    ).run(id, options.epoch ?? 4);
  }
  return id;
}

function seedSubmission(formId = 'form-1', answers = originalAnswers, editVersion = 3): string {
  const id = 'ifs-1';
  raw.prepare(
    `INSERT INTO internal_form_submissions
       (id, form_id, friend_id, answers_json, origin_channel, edit_version, submitted_at, created_at)
     VALUES (?, ?, NULL, ?, 'embed', ?, '2026-07-21T00:00:00+09:00', '2026-07-21T00:00:00+09:00')`,
  ).run(id, formId, JSON.stringify(answers), editVersion);
  return id;
}

async function token(formId = 'form-1', submissionId = 'ifs-1', options: {
  epoch?: number;
  expired?: boolean;
  secret?: string;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signed = await signEditToken({
    formId,
    rowRef: submissionId,
    epoch: options.epoch ?? 4,
    exp: options.expired ? now - 1 : editTokenExp(now, 30),
  }, options.secret ?? EDIT_SECRET);
  return signed!;
}

beforeEach(() => {
  sheetsSyncMocks.syncSheetsAfterFormMutation.mockReset().mockResolvedValue(undefined);
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => {
  vi.restoreAllMocks();
  raw.close();
});

describe('GET /ife/:token', () => {
  test('prefills current editable answers, exposes a hidden CAS version, and renders complex answers read-only', async () => {
    seedForm();
    seedSubmission();

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).toContain('<form method="post"');
    expect(html).toContain('name="editVersion" value="3"');
    expect(html).toContain('value="佐藤 &lt;script&gt;"');
    expect(html).toContain('value="old@example.test"');
    expect(html).toContain('申込書.pdf');
    expect(html).toContain('接客');
    expect(html).toContain('田中');
    expect(html).not.toContain('name="a_2"');
    expect(html).not.toContain('name="a_3"');
    expect(html).not.toContain('name="a_4"');
    expect(html).not.toContain('name="a_7"');
    expect(html).not.toContain('<script>');
  });

  test.each([
    ['expired token', { token: { expired: true } }],
    ['wrong signing key', { token: { secret: 'wrong-secret' } }],
    ['revoked epoch', { form: { epoch: 5 } }],
    ['missing settings', { form: { withSettings: false } }],
    ['draft form', { form: { status: 'draft' } }],
    ['Formaloo backend', { form: { backend: 'formaloo' as const } }],
  ])('rejects %s without exposing the stored answers', async (_label, setup) => {
    seedForm(setup.form);
    seedSubmission();
    const response = await app().request(`/ife/${await token('form-1', 'ifs-1', setup.token)}`, {}, bindings());
    const html = await response.text();

    expect(response.status).not.toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).not.toContain('old@example.test');
  });

  test('never writes the bearer token to logs when an unexpected DB error occurs', async () => {
    const signed = await token();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const brokenDb = {
      prepare() { throw new Error('database unavailable'); },
    } as unknown as D1Database;

    const response = await app().request(`/ife/${signed}`, {}, bindings(brokenDb));

    expect(response.status).toBe(500);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(signed);
  });

  test('allow_branch_edit=0 は分岐元を readonly にし、client 再評価 asset を載せない', async () => {
    seedForm({ definition: conditionalDefinition });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('aria-label="区分"');
    expect(html).not.toContain('name="a_0"');
    expect(html).toContain('name="a_1"');
    expect(html).not.toContain('data-internal-form-logic-client');
  });

  test('allow_branch_edit=1 は全分岐候補を安全な DOM に載せ、共有 client が入力時に出し分ける', async () => {
    seedForm({ definition: conditionalDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤', company: '初期非表示の秘密' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-internal-form-logic-config');
    expect(html).toContain('src="/assets/internal-form-logic.js"');
    expect(html).not.toContain('初期非表示の秘密');

    const parsed = new DOMParser().parseFromString(html, 'text/html');
    initInternalFormLogic(parsed);
    const kind = parsed.querySelector<HTMLSelectElement>('select[name="a_0"]')!;
    const personal = parsed.querySelector<HTMLElement>('[data-field-id="personal"]')!;
    const company = parsed.querySelector<HTMLElement>('[data-field-id="company"]')!;
    expect(personal.hidden).toBe(false);
    expect(company.hidden).toBe(true);

    kind.value = '法人';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    expect(personal.hidden).toBe(true);
    expect(personal.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(company.hidden).toBe(false);
    expect(company.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
    expect(company.querySelector<HTMLInputElement>('input')?.required).toBe(true);
  });

  test('logic JSON の script 終端文字列を escape して設定 script から脱出させない', async () => {
    const attack = '</script><script>globalThis.__editBranchXss = true</script>';
    const dangerousDefinition = {
      fields: [
        { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: [attack] } },
        { id: 'target', type: 'text', label: '対象', required: false, position: 1, config: {} },
      ],
      logic: [{ id: 'danger', sourceFieldId: 'kind', operator: 'equals', value: attack, action: 'show', targetFieldId: 'target' }],
    };
    seedForm({ definition: dangerousDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: attack });
    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();

    expect(html).not.toContain(attack);
    expect(html).toContain('\\u003c/script\\u003e');
    expect(new DOMParser().parseFromString(html, 'text/html').querySelectorAll('script')).toHaveLength(2);
  });

  test('control を持たない既存 readonly source も固定回答で client 評価を維持する', async () => {
    const readonlySourceDefinition = {
      fields: [
        { id: 'approval', type: 'signature', label: '承認署名', required: false, position: 0, config: {} },
        { id: 'approved_note', type: 'text', label: '承認後の連絡', required: false, position: 1, config: {} },
      ],
      logic: [{
        id: 'approved', sourceFieldId: 'approval', operator: 'equals', value: 'approved',
        action: 'show', targetFieldId: 'approved_note',
      }],
    };
    seedForm({ definition: readonlySourceDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { approval: 'approved', approved_note: '連絡済み' });
    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    initInternalFormLogic(parsed);
    expect(parsed.querySelector<HTMLElement>('[data-field-id="approved_note"]')?.hidden).toBe(false);
    expect(parsed.querySelector('[data-internal-form-logic-config]')?.textContent).toContain('fixedAnswers');
  });

  test('初期状態で非表示の readonly source は保存値を client 設定へ埋め込まない', async () => {
    const hiddenReadonlySourceDefinition = {
      fields: [
        { id: 'gate', type: 'choice', label: '表示条件', required: false, position: 0, config: { choices: ['表示する', '隠す'] } },
        { id: 'approval', type: 'signature', label: '承認署名', required: false, position: 1, config: {} },
        { id: 'approved_note', type: 'text', label: '承認後の連絡', required: false, position: 2, config: {} },
      ],
      logic: [
        { id: 'show-approval', sourceFieldId: 'gate', operator: 'equals', value: '表示する', action: 'show', targetFieldId: 'approval' },
        { id: 'approved', sourceFieldId: 'approval', operator: 'equals', value: '承認済み', action: 'show', targetFieldId: 'approved_note' },
      ],
    };
    seedForm({ definition: hiddenReadonlySourceDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { gate: '隠す', approval: '初期非表示の署名秘密値' });

    const response = await app().request(`/ife/${await token()}`, {}, bindings());
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const config = parsed.querySelector('[data-internal-form-logic-config]');

    expect(response.status).toBe(200);
    expect(config).not.toBeNull();
    expect(config?.textContent).not.toContain('初期非表示の署名秘密値');
  });

  test('compound conditions の各 source も分岐元として readonly にする', async () => {
    const compound = {
      fields: [
        { id: 'kind', type: 'choice', label: '区分', required: true, position: 0, config: { choices: ['法人'] } },
        { id: 'region', type: 'choice', label: '地域', required: true, position: 1, config: { choices: ['関東'] } },
        { id: 'target', type: 'text', label: '法人名', required: true, position: 2, config: {} },
      ],
      logic: [{
        id: 'compound', sourceFieldId: 'kind', operator: 'equals', value: '法人', action: 'show', targetFieldId: 'target',
        conditionJoin: 'and',
        conditions: [
          { sourceFieldId: 'kind', operator: 'equals', value: '法人' },
          { sourceFieldId: 'region', operator: 'equals', value: '関東' },
        ],
      }],
    };
    seedForm({ definition: compound });
    seedSubmission('form-1', { kind: '法人', region: '関東', target: 'テスト社' });
    const html = await (await app().request(`/ife/${await token()}`, {}, bindings())).text();
    expect(html).not.toContain('name="a_0"');
    expect(html).not.toContain('name="a_1"');
    expect(html).toContain('name="a_2"');
  });
});

describe('POST /ife/:token', () => {
  test('queues an immediate Sheets sync after a respondent edit is read back', async () => {
    seedForm();
    seedSubmission();
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    const signed = await token();
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const executionCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await app().fetch(new Request(`https://worker.example.test/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        editVersion: '3',
        a_0: '鈴木',
        a_1: 'new@example.test',
      }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), executionCtx);

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).toHaveBeenCalledWith(expect.objectContaining({
      db: DB,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      submissionId: 'ifs-1',
      actor: 'system_internal_form_edit',
      credentialsJson: '{}',
    }));
  });

  test('keeps a respondent edit successful when the background Sheets sync fails', async () => {
    seedForm();
    seedSubmission();
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockRejectedValueOnce(new Error('sync failed'));
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app().fetch(new Request(`https://worker.example.test/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '鈴木', a_1: 'new@example.test' }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(raw.prepare('SELECT edit_version FROM internal_form_submissions WHERE id = ?').get('ifs-1'))
      .toEqual({ edit_version: 4 });
    expect(error).toHaveBeenCalledWith('Immediate Google Sheets sync after respondent edit failed');
  });

  test('edits only the active W3 logic branch and retains the answer from the branch that became hidden', async () => {
    seedForm({ definition: conditionalDefinition, allowBranchEdit: 1 });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤', company: '旧会社名' }, 3);
    const signed = await token();

    const initial = await app().request(`/ife/${signed}`, {}, bindings());
    const initialHtml = await initial.text();
    const initialDocument = new DOMParser().parseFromString(initialHtml, 'text/html');
    expect(initialDocument.querySelector<HTMLElement>('[data-field-id="personal"]')?.hidden).toBe(false);
    expect(initialDocument.querySelector<HTMLElement>('[data-field-id="company"]')?.hidden).toBe(true);
    expect(initialHtml).not.toContain('旧会社名');

    const changedBranch = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '法人' }),
    }, bindings());
    const changedHtml = await changedBranch.text();
    expect(changedBranch.status).toBe(400);
    const changedDocument = new DOMParser().parseFromString(changedHtml, 'text/html');
    expect(changedDocument.querySelector<HTMLElement>('[data-field-id="personal"]')?.hidden).toBe(true);
    expect(changedDocument.querySelector<HTMLElement>('[data-field-id="company"]')?.hidden).toBe(false);

    const saved = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '法人', a_1: '偽造された非表示値', a_2: '株式会社テスト' }),
    }, bindings());
    expect(saved.status).toBe(200);
    const row = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string };
    expect(JSON.parse(row.answers_json)).toEqual({
      kind: '法人',
      personal: '佐藤',
      company: '株式会社テスト',
    });
  });

  test('allow_branch_edit=0 は forged branch POST を 403 で拒否し回答と版を変えない', async () => {
    seedForm({ definition: conditionalDefinition });
    seedSubmission('form-1', { kind: '個人', personal: '佐藤' }, 3);

    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '法人', a_2: '攻撃者の会社' }),
    }, bindings());

    expect(response.status).toBe(403);
    const stored = raw.prepare('SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?')
      .get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual({ kind: '個人', personal: '佐藤' });
  });

  test('validates and saves editable answers with CAS, ignores forged fields, preserves complex answers, and reads back the change', async () => {
    seedForm();
    seedSubmission();
    const signed = await token();
    const body = new URLSearchParams({
      editVersion: '3',
      a_0: '鈴木',
      a_1: 'new@example.test',
      a_999: 'unknown answer',
      fr_id: 'attacker-friend',
      friend_id: 'attacker-friend',
      form_id: 'attacker-form',
      answers_json: '{"admin":true}',
      edit_version: '999',
    });

    const response = await app().request(`/ife/${signed}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, bindings());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(html).toContain('保存しました');

    const stored = raw.prepare(
      'SELECT form_id, friend_id, answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { form_id: string; friend_id: string | null; answers_json: string; edit_version: number };
    const answers = JSON.parse(stored.answers_json) as Record<string, unknown>;
    expect(stored.form_id).toBe('form-1');
    expect(stored.friend_id).toBeNull();
    expect(stored.edit_version).toBe(4);
    expect(answers).toMatchObject({ name: '鈴木', email: 'new@example.test' });
    expect(answers.attachment).toEqual(originalAnswers.attachment);
    expect(answers.signature).toBe(originalAnswers.signature);
    expect(answers.matrix).toEqual(originalAnswers.matrix);
    expect(answers.repeat).toEqual(originalAnswers.repeat);
    expect(answers).not.toHaveProperty('fr_id');
    expect(answers).not.toHaveProperty('friend_id');
    expect(answers).not.toHaveProperty('admin');

    const readback = await app().request(`/ife/${signed}`, {}, bindings());
    expect(await readback.text()).toContain('value="鈴木"');
  });

  test.each([
    ['required', { a_0: '', a_1: 'new@example.test' }],
    ['email type', { a_0: '鈴木', a_1: 'not-an-email' }],
  ])('returns 400 for invalid %s input and leaves the row unchanged', async (_label, values) => {
    seedForm();
    seedSubmission();
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    const waitUntil = vi.fn();
    const response = await app().fetch(new Request(`https://worker.example.test/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', ...values }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(400);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual(originalAnswers);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('returns 409 for a stale hidden editVersion and does not overwrite newer answers', async () => {
    seedForm();
    seedSubmission('form-1', { ...originalAnswers, name: '先に更新済み' }, 4);
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'form-1'").run();
    const waitUntil = vi.fn();
    const response = await app().fetch(new Request(`https://worker.example.test/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '古い画面から更新', a_1: 'new@example.test' }),
    }), bindings(DB, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(4);
    expect(JSON.parse(stored.answers_json)).toMatchObject({ name: '先に更新済み' });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('returns 403 without mutation when the edit link is revoked immediately before UPDATE', async () => {
    seedForm();
    seedSubmission();

    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '失効後の更新', a_1: 'new@example.test' }),
    }, bindings(rotateEpochBeforeSubmissionUpdate()));

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual(originalAnswers);
  });
});
