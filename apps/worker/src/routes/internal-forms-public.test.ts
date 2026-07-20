import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { signFriendToken } from '../services/formaloo-friend-token.js';
import { internalFormsPublic } from './internal-forms-public.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const FRIEND_SECRET = 'internal-form-test-secret';

const fields = [
  { id: 'text', type: 'text', label: 'お名前', required: true, position: 0, config: { maxLength: 5 } },
  { id: 'textarea', type: 'textarea', label: '備考', required: false, position: 1, config: { maxLength: 100 } },
  { id: 'number', type: 'number', label: '人数', required: true, position: 2, config: {} },
  { id: 'email', type: 'email', label: 'メール', required: true, position: 3, config: {} },
  { id: 'phone', type: 'phone', label: '電話', required: true, position: 4, config: {} },
  { id: 'date', type: 'date', label: '希望日', required: true, position: 5, config: {} },
  { id: 'choice', type: 'choice', label: '区分', required: true, position: 6, config: { choices: ['個人', '法人'] } },
  { id: 'dropdown', type: 'dropdown', label: '地域', required: true, position: 7, config: { choices: ['東', '西'] } },
  { id: 'multiple', type: 'multiple_select', label: '興味', required: true, position: 8, config: { choices: ['A', 'B'] } },
];

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
    WORKER_URL: 'https://worker.example.test',
    FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_SECRET,
  } as Env['Bindings'];
}

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormsPublic);
  return hono;
}

function seedForm(
  id: string,
  options: { backend?: 'formaloo' | 'internal'; status?: string; definition?: unknown } = {},
): void {
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, title, description, definition_json, builder_status, render_backend,
        on_submit_tag_id, on_submit_scenario_id, submit_message)
     VALUES (?, ?, ?, ?, ?, ?, 'tag-1', 'scenario-1', ?)`,
  ).run(
    id,
    '申込 <script>alert(1)</script>',
    '必要事項を入力してください',
    JSON.stringify(options.definition ?? { fields, logic: [] }),
    options.status ?? 'published',
    options.backend ?? 'internal',
    '受付完了 <b>ありがとうございます</b>',
  );
}

function validBody(): URLSearchParams {
  const body = new URLSearchParams({
    a_0: '佐藤',
    a_1: 'よろしくお願いします',
    a_2: '2',
    a_3: 'sato@example.com',
    a_4: '090-1234-5678',
    a_5: '2026-08-01',
    a_6: '個人',
    a_7: '東',
  });
  body.append('a_8', 'A');
  body.append('a_8', 'B');
  return body;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  raw.prepare("INSERT INTO friends (id, line_user_id, display_name) VALUES ('friend-1', 'U1', '佐藤')").run();
  raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', '回答済み')").run();
  raw.prepare("INSERT INTO scenarios (id, name, trigger_type) VALUES ('scenario-1', '回答後', 'manual')").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe('internal public form GET /f/:formId', () => {
  test('renders the nine W1 field types as mobile-first HTML and escapes stored copy', async () => {
    seedForm('fa_internal');
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const response = await app().request(`/f/fa_internal?fr_id=${encodeURIComponent(token!)}`, {}, env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<form method="post" action="/f/fa_internal">');
    expect(html).toMatch(/<input[^>]+type="text"[^>]+name="a_0"/);
    expect(html).toMatch(/<textarea[^>]+name="a_1"/);
    expect(html).toMatch(/<input[^>]+type="number"[^>]+name="a_2"/);
    expect(html).toMatch(/<input[^>]+type="email"[^>]+name="a_3"/);
    expect(html).toMatch(/<input[^>]+type="tel"[^>]+name="a_4"/);
    expect(html).toMatch(/<input[^>]+type="date"[^>]+name="a_5"/);
    expect(html).toMatch(/<input[^>]+type="radio"[^>]+name="a_6"/);
    expect(html).toMatch(/<select[^>]+name="a_7"/);
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+name="a_8"/);
    const multipleInputs = html.match(/<input type="checkbox" name="a_8"[^>]*>/g) ?? [];
    expect(multipleInputs).toHaveLength(2);
    expect(multipleInputs.every((input) => !input.includes(' required'))).toBe(true);
    expect(html).toContain(`name="fr_id" value="${token}"`);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('does not serve Formaloo-backed, draft, or unsupported internal forms', async () => {
    seedForm('fa_formaloo', { backend: 'formaloo' });
    seedForm('fa_draft', { status: 'draft' });
    seedForm('fa_unsupported', {
      definition: { fields: [{ id: 'rating', type: 'rating', label: '評価', required: false, position: 0, config: {} }], logic: [] },
    });

    expect((await app().request('/f/fa_formaloo', {}, env())).status).toBe(404);
    expect((await app().request('/f/fa_draft', {}, env())).status).toBe(404);
    expect((await app().request('/f/fa_unsupported', {}, env())).status).toBe(422);
  });
});

describe('internal public form POST /f/:formId', () => {
  test.each([
    ['required', (body: URLSearchParams) => body.delete('a_0'), 'お名前 は必須項目です'],
    ['maxLength', (body: URLSearchParams) => body.set('a_0', '123456'), 'お名前 は5文字以内で入力してください'],
    ['number', (body: URLSearchParams) => body.set('a_2', 'two'), '人数 の形式が正しくありません'],
    ['email', (body: URLSearchParams) => body.set('a_3', 'invalid'), 'メール の形式が正しくありません'],
    ['phone', (body: URLSearchParams) => body.set('a_4', 'call-me'), '電話 の形式が正しくありません'],
    ['date', (body: URLSearchParams) => body.set('a_5', '2026-02-30'), '希望日 の形式が正しくありません'],
    ['choice', (body: URLSearchParams) => body.set('a_6', '不正'), '区分 の選択肢が正しくありません'],
    ['dropdown', (body: URLSearchParams) => body.set('a_7', '不正'), '地域 の選択肢が正しくありません'],
    ['multiple', (body: URLSearchParams) => body.append('a_8', '不正'), '興味 の選択肢が正しくありません'],
  ])('rejects %s server-side before persistence', async (_name, mutate, expected) => {
    seedForm('fa_internal');
    const body = validBody();
    mutate(body);

    const response = await app().request('/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env());

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(expected);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('stores normalized answers, runs basic friend post-processing, and shows configured completion copy', async () => {
    seedForm('fa_internal');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = validBody();
    body.set('fr_id', token!);

    const response = await app().request('/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('受付完了 &lt;b&gt;ありがとうございます&lt;/b&gt;');
    expect(html).not.toContain('<b>ありがとうございます</b>');
    const submission = raw.prepare(
      'SELECT form_id, friend_id, answers_json FROM internal_form_submissions',
    ).get() as { form_id: string; friend_id: string; answers_json: string };
    expect(submission.form_id).toBe('fa_internal');
    expect(submission.friend_id).toBe('friend-1');
    expect(JSON.parse(submission.answers_json)).toEqual({
      text: '佐藤', textarea: 'よろしくお願いします', number: 2,
      email: 'sato@example.com', phone: '090-1234-5678', date: '2026-08-01',
      choice: '個人', dropdown: '東', multiple: ['A', 'B'],
    });
    expect(raw.prepare('SELECT friend_id, tag_id FROM friend_tags').get())
      .toEqual({ friend_id: 'friend-1', tag_id: 'tag-1' });
    expect(raw.prepare('SELECT friend_id, scenario_id, status FROM friend_scenarios').get())
      .toEqual({ friend_id: 'friend-1', scenario_id: 'scenario-1', status: 'completed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('keeps an invalid friend token anonymous and ignores unknown answer keys', async () => {
    seedForm('fa_internal');
    const body = validBody();
    body.set('fr_id', 'friend-1.tampered');
    body.set('admin', 'true');

    const response = await app().request('/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env());

    expect(response.status).toBe(200);
    const row = raw.prepare('SELECT friend_id, answers_json FROM internal_form_submissions').get() as {
      friend_id: string | null;
      answers_json: string;
    };
    expect(row.friend_id).toBeNull();
    expect(JSON.parse(row.answers_json)).not.toHaveProperty('admin');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
  });
});
