import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { editTokenExp, signEditToken } from '../services/formaloo-edit-token.js';
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

let raw: Database.Database;
let DB: D1Database;

function bindings(db = DB): Env['Bindings'] {
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
} = {}): string {
  const id = options.id ?? 'form-1';
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, builder_status, render_backend)
     VALUES (?, '回答編集テスト', ?, ?, ?)`,
  ).run(id, JSON.stringify(definition), options.status ?? 'published', options.backend ?? 'internal');
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
});

describe('POST /ife/:token', () => {
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
    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', ...values }),
    }, bindings());

    expect(response.status).toBe(400);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(3);
    expect(JSON.parse(stored.answers_json)).toEqual(originalAnswers);
  });

  test('returns 409 for a stale hidden editVersion and does not overwrite newer answers', async () => {
    seedForm();
    seedSubmission('form-1', { ...originalAnswers, name: '先に更新済み' }, 4);
    const response = await app().request(`/ife/${await token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ editVersion: '3', a_0: '古い画面から更新', a_1: 'new@example.test' }),
    }, bindings());

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
    const stored = raw.prepare(
      'SELECT answers_json, edit_version FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-1') as { answers_json: string; edit_version: number };
    expect(stored.edit_version).toBe(4);
    expect(JSON.parse(stored.answers_json)).toMatchObject({ name: '先に更新済み' });
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
