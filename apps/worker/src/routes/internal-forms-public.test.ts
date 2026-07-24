import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createSheetsConnection } from '@line-crm/db';
import { signFriendToken, verifyFriendToken } from '../services/formaloo-friend-token.js';

const notificationMocks = vi.hoisted(() => ({
  notifyInternalFormSubmission: vi.fn(),
}));
const sheetsSyncMocks = vi.hoisted(() => ({
  syncSheetsAfterFormMutation: vi.fn(),
}));
const staffNotificationMocks = vi.hoisted(() => ({
  dispatchStaffNotification: vi.fn(),
}));

vi.mock('../services/internal-submission-notifier.js', () => notificationMocks);
vi.mock('../services/staff-notify/router.js', () => staffNotificationMocks);
vi.mock('../services/sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/sheets-sync-jobs.js')>(),
  syncSheetsAfterFormMutation: sheetsSyncMocks.syncSheetsAfterFormMutation,
}));
import { internalFormsPublic } from './internal-forms-public.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const FRIEND_SECRET = 'internal-form-test-secret';

const fields = [
  { id: 'text', type: 'text', label: 'お名前', required: true, position: 0, config: { maxLength: 5, placeholder: '例：佐藤' } },
  { id: 'textarea', type: 'textarea', label: '備考', required: false, position: 1, config: { maxLength: 100, placeholder: '自由に入力' } },
  { id: 'number', type: 'number', label: '人数', required: true, position: 2, config: { placeholder: '2' } },
  { id: 'email', type: 'email', label: 'メール', required: true, position: 3, config: { placeholder: 'name@example.jp' } },
  { id: 'phone', type: 'phone', label: '電話', required: true, position: 4, config: { placeholder: '090-0000-0000' } },
  { id: 'date', type: 'date', label: '希望日', required: true, position: 5, config: { placeholder: '希望日を選択' } },
  { id: 'choice', type: 'choice', label: '区分', required: true, position: 6, config: { choices: ['個人', '法人'], placeholder: 'どちらか選択' } },
  { id: 'dropdown', type: 'dropdown', label: '地域', required: true, position: 7, config: { choices: ['東', '西'], placeholder: '地域を選択' } },
  { id: 'multiple', type: 'multiple_select', label: '興味', required: true, position: 8, config: { choices: ['A', 'B'], placeholder: '複数選べます' } },
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

function beforeAtomicSubmission(callback: () => void): void {
  const base = DB;
  let called = false;
  DB = {
    prepare(sql: string) {
      if (!sql.includes('INSERT INTO internal_form_submissions') || !sql.includes("builder_status = 'published'")) {
        return base.prepare(sql);
      }
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

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
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
    ...overrides,
  } as Env['Bindings'];
}

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', internalFormsPublic);
  return hono;
}

function postForm(id: string, body: URLSearchParams) {
  return app().request(`/f/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, env());
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
  vi.clearAllMocks();
  notificationMocks.notifyInternalFormSubmission.mockResolvedValue({
    line: { status: 'skipped', reason: 'disabled' },
    email: { status: 'skipped', reason: 'disabled' },
  });
  staffNotificationMocks.dispatchStaffNotification.mockReset().mockResolvedValue([]);
  sheetsSyncMocks.syncSheetsAfterFormMutation.mockReset().mockResolvedValue(undefined);
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  raw.prepare("INSERT INTO friends (id, line_user_id, display_name) VALUES ('friend-1', 'U1', '佐藤')").run();
  raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', '回答済み')").run();
  raw.prepare("INSERT INTO scenarios (id, name, trigger_type) VALUES ('scenario-1', '回答後', 'manual')").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raw.close();
});

describe('internal public form GET /f/:formId', () => {
  test('住所を折り返し欄で配信し、改行を除いて保存する', async () => {
    seedForm('fa_address', {
      definition: {
        fields: [{ id: 'address', type: 'address', label: '住所', required: true, position: 0, config: {} }],
        logic: [],
      },
    });

    const getResponse = await app().request('/f/fa_address', {}, env());
    const html = await getResponse.text();
    expect(getResponse.status).toBe(200);
    expect(html).toMatch(/<textarea[^>]+rows="2"[^>]+data-single-line-address[^>]+data-answer-field="address"/);
    expect(html).toContain('/assets/internal-form-logic.js');

    const response = await postForm('fa_address', new URLSearchParams({
      a_0: ' 東京都\r\n千代田区\n千代田1-1\r本館 ',
    }));
    expect(response.status).toBe(200);
    const stored = raw.prepare(
      "SELECT answers_json FROM internal_form_submissions WHERE form_id = 'fa_address'",
    ).get() as { answers_json: string };
    expect(JSON.parse(stored.answers_json)).toEqual({ address: '東京都 千代田区 千代田1-1 本館' });
    expect(stored.answers_json).not.toMatch(/\\[nr]/);
  });

  test('住所の改行を分岐評価前にも1行化してプレビューと同じ条件結果にする', async () => {
    seedForm('fa_address_logic', {
      definition: {
        fields: [
          { id: 'address', type: 'address', label: '住所', required: true, position: 0, config: {} },
          { id: 'note', type: 'text', label: '配送メモ', required: true, position: 1, config: {} },
        ],
        logic: [{
          id: 'show-note', sourceFieldId: 'address', operator: 'equals',
          value: '東京都 千代田区', action: 'show', targetFieldId: 'note',
        }],
      },
    });

    const response = await postForm('fa_address_logic', new URLSearchParams({
      a_0: '東京都\n千代田区',
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('配送メモ は必須項目です');
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_address_logic'",
    ).get()).toEqual({ n: 0 });
  });

  test('renders the nine W1 field types as mobile-first HTML and escapes stored copy', async () => {
    seedForm('fa_internal');
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const response = await app().request(`/f/fa_internal?fr_id=${encodeURIComponent(token!)}`, {}, env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<form method="post" action="/f/fa_internal">');
    expect(html).not.toContain('enctype="multipart/form-data"');
    expect(html).not.toContain('data-file-attachment');
    expect(html).not.toContain('src="/assets/internal-form-logic.js"');
    expect(html).toMatch(/<input[^>]+type="text"[^>]+name="a_0"/);
    expect(html).toMatch(/<textarea[^>]+name="a_1"/);
    expect(html).toMatch(/<input[^>]+type="number"[^>]+name="a_2"/);
    expect(html).toMatch(/<input[^>]+type="email"[^>]+name="a_3"/);
    expect(html).toMatch(/<input[^>]+type="tel"[^>]+name="a_4"/);
    expect(html).toMatch(/<input[^>]+type="date"[^>]+name="a_5"/);
    expect(html).toMatch(/<input[^>]+type="radio"[^>]+name="a_6"/);
    expect(html).toMatch(/<select[^>]+name="a_7"/);
    expect(html).toMatch(/<input[^>]+type="checkbox"[^>]+name="a_8"/);
    expect(html).toContain('placeholder="例：佐藤"');
    expect(html).toContain('placeholder="自由に入力"');
    expect(html).toContain('placeholder="2"');
    expect(html).toContain('placeholder="name@example.jp"');
    expect(html).toContain('placeholder="090-0000-0000"');
    expect(html).toContain('希望日を選択');
    expect(html).toContain('どちらか選択');
    expect(html).toContain('<option value="">地域を選択</option>');
    expect(html).toContain('複数選べます');
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
      definition: {
        fields: [{
          id: 'remote', type: 'choice_fetch', label: '動的選択肢', required: false, position: 0,
          config: { choicesSource: 'https://choices.example.test/public' },
        }],
        logic: [],
      },
    });

    expect((await app().request('/f/fa_formaloo', {}, env())).status).toBe(404);
    expect((await app().request('/f/fa_draft', {}, env())).status).toBe(404);
    expect((await app().request('/f/fa_unsupported', {}, env())).status).toBe(422);
  });

  test.each([
    [
      'upcoming',
      { submitStartTime: '2099-07-25T00:00:00+09:00' },
      '受付開始前・7月25日から',
    ],
    [
      'ended',
      { submitEndTime: '2000-07-25T00:00:00+09:00' },
      '受付は終了しました',
    ],
  ])('honestly renders %s availability without exposing or accepting the form', async (_name, operationsSettings, message) => {
    seedForm('fa_window', { definition: { fields: [fields[0]], logic: [], operationsSettings } });

    const getResponse = await app().request('/f/fa_window', {}, env());
    expect(getResponse.status).toBe(200);
    const getHtml = await getResponse.text();
    expect(getHtml).toContain(message);
    expect(getHtml).not.toContain('<form');

    const postResponse = await postForm('fa_window', new URLSearchParams({ a_0: '佐藤' }));
    expect(postResponse.status).toBe(200);
    expect(await postResponse.text()).toContain(message);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('applies the saved theme, images, explicit CJK font, mobile sizing, and native postal controls', async () => {
    seedForm('fa_design', { definition: {
      fields: [
        {
          id: 'zip', type: 'text', label: '郵便番号', required: true, position: 0,
          config: { postalAutofill: { zipField: 'zip', prefField: 'pref', cityField: 'city', townField: 'town' } },
        },
        { id: 'pref', type: 'text', label: '都道府県', required: true, position: 1, config: {} },
        { id: 'city', type: 'text', label: '市区町村', required: true, position: 2, config: {} },
        { id: 'town', type: 'text', label: '町域', required: false, position: 3, config: {} },
      ],
      logic: [],
      design: {
        themeColor: '#112233', backgroundColor: '#223344', buttonColor: '#334455',
        textColor: '#F0F1F2', fieldColor: '#445566', borderColor: '#778899',
        submitTextColor: '#FFFFFF', logoUrl: 'https://img.example.test/logo.png',
        backgroundImageUrl: 'https://img.example.test/background.png', presetId: 'matcha-wa',
      },
    } });

    const response = await app().request('/f/fa_design', {}, env());
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('--form-theme: #112233');
    expect(html).toContain('--form-background: #223344');
    expect(html).toContain('--form-button: #334455');
    expect(html).toContain('--form-text: #F0F1F2');
    expect(html).toContain('--form-field: #445566');
    expect(html).toContain('--form-border: #778899');
    expect(html).toContain('--form-submit-text: #FFFFFF');
    expect(html).toContain('--form-font:');
    expect(html).toContain('https://img.example.test/background.png');
    expect(html).toContain('<img class="form-logo" src="https://img.example.test/logo.png"');
    expect(html).toContain('min-height: 48px');
    expect(html).toContain('@media (min-width: 600px)');
    expect(html).toContain('type="button" class="postal-lookup"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-internal-form-logic-config');
    expect(html).toContain('src="/assets/internal-form-logic.js"');
    expect(html).not.toContain('postal lookup failed');
    expect(html).not.toContain("replace(/[\\s-]/g, '')");
  });

  test('ships the same internal logic engine for one-page ABC and channel branching', async () => {
    seedForm('fa_logic', { definition: logicDefinition() });
    const response = await app().request('/f/fa_logic', {}, env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-internal-form-logic-config');
    expect(html).toContain('src="/assets/internal-form-logic.js"');
    expect(html).not.toContain('function evaluateInternalFormLogic');
    expect(html).toContain('data-field-id="page-a"');
    expect(html).toContain('data-field-id="page-b"');
    expect(html).toContain('data-form-type="simple"');
    expect(html).toContain('data-channel="web"');
    expect(html).toContain('"sourceFieldId":"kind"');
  });

  test('別 LINE account の署名済み fr_id は web 経由として匿名表示する', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-A', 'ch-A', 'A', 'token-A', 'secret-A'), ('acc-B', 'ch-B', 'B', 'token-B', 'secret-B')`).run();
    seedForm('fa_scoped_get', { definition: logicDefinition() });
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-A' WHERE id = 'fa_scoped_get'").run();
    raw.prepare("UPDATE friends SET line_account_id = 'acc-B' WHERE id = 'friend-1'").run();
    const token = await signFriendToken('friend-1', FRIEND_SECRET);

    const response = await app().request(
      `/f/fa_scoped_get?fr_id=${encodeURIComponent(token!)}`,
      {},
      env(),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-channel="web"');
    expect(html).not.toContain('name="fr_id"');
    expect(html).toContain('name="_notification_origin" value="invalid"');
  });
});

function logicDefinition() {
  return {
    fields: [
      { id: 'kind', type: 'choice', label: '希望ルート', required: true, position: 0, config: { choices: ['A', 'B'] } },
      { id: 'page-a', type: 'page_break', label: 'Aルート', required: false, position: 1, config: {} },
      { id: 'answer-a', type: 'text', label: 'A回答', required: true, position: 2, config: {} },
      { id: 'page-b', type: 'page_break', label: 'Bルート', required: false, position: 3, config: {} },
      { id: 'answer-b', type: 'text', label: 'B回答', required: true, position: 4, config: {} },
      { id: 'email-web', type: 'email', label: 'メール', required: true, position: 5, config: {} },
    ],
    logic: [
      { id: 'route-a', sourceFieldId: 'kind', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'page-a' },
      { id: 'route-b', sourceFieldId: 'kind', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'page-b' },
      { id: 'web-email', sourceFieldId: '__channel__', operator: 'equals', value: 'web', action: 'show', targetFieldId: 'email-web' },
      {
        id: 'done-b', sourceFieldId: 'answer-b', operator: 'equals', value: '', action: 'submit',
        targetFieldId: 'done-b', terminalTrigger: 'on_answered',
      },
    ],
    formType: 'simple',
    successPages: [{ id: 'done-b', title: 'B専用完了', description: 'Bルートを受け付けました <b>完了</b>' }],
  };
}

describe('internal public form POST /f/:formId', () => {
  test('fans out the accepted form event and keeps HTTP 200 when staff notification rejects', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-staff', 'channel-staff', 'Staff', 'token', 'secret')`).run();
    seedForm('fa_staff_notify');
    raw.prepare(
      "UPDATE formaloo_forms SET line_account_id = 'acc-staff' WHERE id = 'fa_staff_notify'",
    ).run();
    staffNotificationMocks.dispatchStaffNotification.mockRejectedValueOnce(
      new Error('private provider response'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await postForm('fa_staff_notify', validBody());

      expect(response.status).toBe(200);
      const submission = raw.prepare(
        "SELECT id FROM internal_form_submissions WHERE form_id = 'fa_staff_notify'",
      ).get() as { id: string };
      expect(staffNotificationMocks.dispatchStaffNotification).toHaveBeenCalledWith(
        expect.objectContaining({ DB }),
        {
          eventType: 'form_submitted',
          lineAccountId: 'acc-staff',
          name: '佐藤',
          excerpt: 'よろしくお願いします',
          deepLink: `https://worker.example.test/forms-advanced/data?id=fa_staff_notify&rowId=${submission.id}`,
        },
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain('private provider response');
    } finally {
      error.mockRestore();
    }
  });

  test('skips email, phone, and address fields when choosing the notification excerpt', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-staff', 'channel-staff', 'Staff', 'token', 'secret')`).run();
    seedForm('fa_staff_privacy', {
      definition: {
        fields: [
          { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
          { id: 'email', type: 'email', label: 'メール', required: true, position: 1, config: {} },
          { id: 'phone', type: 'phone', label: '電話', required: true, position: 2, config: {} },
          { id: 'address', type: 'address', label: '住所', required: true, position: 3, config: {} },
          { id: 'message', type: 'textarea', label: 'ご相談内容', required: false, position: 4, config: {} },
        ],
        logic: [],
      },
    });
    raw.prepare(
      "UPDATE formaloo_forms SET line_account_id = 'acc-staff' WHERE id = 'fa_staff_privacy'",
    ).run();

    const response = await postForm('fa_staff_privacy', new URLSearchParams({
      a_0: '佐藤',
      a_1: 'private@example.com',
      a_2: '090-1111-2222',
      a_3: '東京都千代田区1-1',
      a_4: '予約について相談したいです',
    }));

    expect(response.status).toBe(200);
    expect(staffNotificationMocks.dispatchStaffNotification).toHaveBeenCalledWith(
      expect.objectContaining({ DB }),
      expect.objectContaining({
        name: '佐藤',
        excerpt: '予約について相談したいです',
      }),
    );
    const payload = JSON.stringify(
      staffNotificationMocks.dispatchStaffNotification.mock.calls[0]?.[1],
    );
    expect(payload).not.toContain('private@example.com');
    expect(payload).not.toContain('090-1111-2222');
    expect(payload).not.toContain('東京都千代田区1-1');
  });

  test('returns the accepted form response without waiting for a slow staff provider', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-staff', 'channel-staff', 'Staff', 'token', 'secret')`).run();
    seedForm('fa_staff_async');
    raw.prepare(
      "UPDATE formaloo_forms SET line_account_id = 'acc-staff' WHERE id = 'fa_staff_async'",
    ).run();
    let releaseDispatch!: () => void;
    staffNotificationMocks.dispatchStaffNotification.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => {
        releaseDispatch = () => resolve([]);
      }),
    );
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    } as unknown as ExecutionContext;

    const responsePromise = app().fetch(new Request(
      'https://worker.example.test/f/fa_staff_async',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: validBody().toString(),
      },
    ), env(), executionCtx);
    const observed = await Promise.race([
      responsePromise,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ]);
    releaseDispatch();

    expect(observed).not.toBe('blocked');
    expect((await responsePromise).status).toBe(200);
    await expect(Promise.all(pending)).resolves.toEqual(
      pending.map(() => undefined),
    );
  });

  test('queues an immediate Sheets sync in waitUntil after an accepted answer', async () => {
    seedForm('fa_internal');
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'fa_internal'").run();
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    await createSheetsConnection(DB, {
      lineAccountId: 'acc-1',
      formId: 'fa_internal',
      spreadsheetId: 'sheet-1',
      sheetName: 'unused-ledger',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: false,
      formResultsEnabled: true,
      formResultsSheetName: 'answers',
    });
    const actual = await vi.importActual<typeof import('../services/sheets-sync-jobs.js')>(
      '../services/sheets-sync-jobs.js',
    );
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockImplementation(
      actual.syncSheetsAfterFormMutation,
    );
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise); });
    const executionCtx = { waitUntil } as unknown as ExecutionContext;

    const response = await app().fetch(new Request('https://worker.example.test/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: validBody().toString(),
    }), env({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), executionCtx);

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await Promise.all(pending);
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).toHaveBeenCalledWith(expect.objectContaining({
      db: DB,
      lineAccountId: 'acc-1',
      formId: 'fa_internal',
      submissionId: expect.stringMatching(/^ifs_/),
      actor: 'system_internal_form_submission',
      credentialsJson: '{}',
    }));
    expect(raw.prepare('SELECT target FROM sheets_sync_jobs').get()).toEqual({ target: 'form_results' });
  });

  test('keeps an accepted answer successful without a Sheets connection and starts no job', async () => {
    seedForm('fa_internal');
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'fa_internal'").run();
    const actual = await vi.importActual<typeof import('../services/sheets-sync-jobs.js')>(
      '../services/sheets-sync-jobs.js',
    );
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockImplementation(
      actual.syncSheetsAfterFormMutation,
    );
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    } as unknown as ExecutionContext;

    const response = await app().fetch(new Request('https://worker.example.test/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: validBody().toString(),
    }), env({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), executionCtx);

    expect(response.status).toBe(200);
    await Promise.all(pending);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM internal_form_submissions').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_jobs').get()).toEqual({ count: 0 });
  });

  test('keeps an accepted answer successful when the background Sheets sync fails', async () => {
    seedForm('fa_internal');
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'fa_internal'").run();
    sheetsSyncMocks.syncSheetsAfterFormMutation.mockRejectedValueOnce(new Error('sync failed'));
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    } as unknown as ExecutionContext;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app().fetch(new Request('https://worker.example.test/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: validBody().toString(),
    }), env({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), executionCtx);

    expect(response.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM internal_form_submissions').get()).toEqual({ count: 1 });
    expect(error).toHaveBeenCalledWith('Immediate Google Sheets sync after form submission failed');
  });

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
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-1' WHERE id = 'fa_internal'").run();
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    const body = validBody();
    mutate(body);
    const waitUntil = vi.fn();

    const response = await app().fetch(new Request('https://worker.example.test/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }), env({ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }), { waitUntil } as unknown as ExecutionContext);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(expected);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sheetsSyncMocks.syncSheetsAfterFormMutation).not.toHaveBeenCalled();
  });

  test('400 再描画は入力値を escape して復元し、選択済み分岐の表示を保つ', async () => {
    seedForm('fa_restore', { definition: {
      fields: [
        { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: { maxLength: 4 } },
        { id: 'memo', type: 'textarea', label: '備考', required: false, position: 1, config: {} },
        { id: 'area', type: 'dropdown', label: '地域', required: true, position: 2, config: { choices: ['東', '西'] } },
        { id: 'route', type: 'choice', label: 'ルート', required: true, position: 3, config: { choices: ['A', 'B'] } },
        { id: 'interests', type: 'multiple_select', label: '興味', required: true, position: 4, config: { choices: ['X', 'Y'] } },
        { id: 'detail-b', type: 'text', label: 'B 詳細', required: true, position: 5, config: {} },
        { id: 'detail-a', type: 'text', label: 'A 詳細', required: false, position: 6, config: {} },
      ],
      logic: [
        { id: 'show-b', sourceFieldId: 'route', operator: 'equals', value: 'B', action: 'show', targetFieldId: 'detail-b' },
        { id: 'show-a', sourceFieldId: 'route', operator: 'equals', value: 'A', action: 'show', targetFieldId: 'detail-a' },
      ],
    } });
    const maliciousName = '"><script>alert(1)</script>';
    const maliciousMemo = '</textarea><script>alert(2)</script>';
    const body = new URLSearchParams({
      a_0: maliciousName,
      a_1: maliciousMemo,
      a_2: '西',
      a_3: 'B',
      a_5: 'B の入力',
    });
    body.append('a_4', 'X');
    body.append('a_4', 'Y');

    const response = await postForm('fa_restore', body);
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).not.toContain(maliciousName);
    expect(html).not.toContain(maliciousMemo);
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;alert(2)&lt;/script&gt;</textarea>');
    expect(html).toMatch(/<option value="西" selected>/);
    expect(html).toMatch(/<input type="radio" name="a_3" value="B"[^>]*\bchecked\b/);
    expect(html).toMatch(/<input type="checkbox" name="a_4" value="X"[^>]*\bchecked\b/);
    expect(html).toMatch(/<input type="checkbox" name="a_4" value="Y"[^>]*\bchecked\b/);
    expect(html).toMatch(/data-field-id="detail-b"(?! hidden)/);
    expect(html).toMatch(/data-field-id="detail-a" hidden/);
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
      'SELECT id, form_id, friend_id, origin_channel, answers_json FROM internal_form_submissions',
    ).get() as {
      id: string;
      form_id: string;
      friend_id: string;
      origin_channel: string;
      answers_json: string;
    };
    expect(submission.form_id).toBe('fa_internal');
    expect(submission.friend_id).toBe('friend-1');
    expect(submission.origin_channel).toBe('line');
    expect(JSON.parse(submission.answers_json)).toEqual({
      text: '佐藤', textarea: 'よろしくお願いします', number: 2,
      email: 'sato@example.com', phone: '090-1234-5678', date: '2026-08-01',
      choice: '個人', dropdown: '東', multiple: ['A', 'B'],
    });
    expect(raw.prepare('SELECT friend_id, tag_id FROM friend_tags').get())
      .toEqual({ friend_id: 'friend-1', tag_id: 'tag-1' });
    expect(raw.prepare('SELECT friend_id, scenario_id, status FROM friend_scenarios').get())
      .toEqual({ friend_id: 'friend-1', scenario_id: 'scenario-1', status: 'completed' });
    expect(notificationMocks.notifyInternalFormSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ DB }),
      { formId: 'fa_internal', submissionId: submission.id },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('deduplicates rapid identical friend submissions without collapsing intentional repeats', async () => {
    seedForm('fa_rapid_dedup');
    raw.prepare(
      "INSERT INTO friends (id, line_user_id, display_name) VALUES ('friend-2', 'U2', '田中')",
    ).run();
    const friendToken = await signFriendToken('friend-1', FRIEND_SECRET);
    const friendTwoToken = await signFriendToken('friend-2', FRIEND_SECRET);
    const signedBody = (signed: string, note = 'よろしくお願いします') => {
      const body = validBody();
      body.set('fr_id', signed);
      body.set('a_1', note);
      return body;
    };

    const [first, duplicate] = await Promise.all([
      postForm('fa_rapid_dedup', signedBody(friendToken!)),
      postForm('fa_rapid_dedup', signedBody(friendToken!)),
    ]);

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_rapid_dedup'",
    ).get()).toEqual({ n: 1 });
    expect(notificationMocks.notifyInternalFormSubmission).toHaveBeenCalledTimes(1);

    raw.prepare(
      "UPDATE internal_form_submissions SET submitted_at = ? WHERE form_id = 'fa_rapid_dedup'",
    ).run(new Date(Date.now() - 11_000).toISOString());
    expect((await postForm('fa_rapid_dedup', signedBody(friendToken!))).status).toBe(200);
    expect((await postForm(
      'fa_rapid_dedup',
      signedBody(friendToken!, '回答内容を変更しました'),
    )).status).toBe(200);
    expect((await postForm('fa_rapid_dedup', signedBody(friendTwoToken!))).status).toBe(200);
    expect((await postForm('fa_rapid_dedup', validBody())).status).toBe(200);
    expect((await postForm('fa_rapid_dedup', validBody())).status).toBe(200);

    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_rapid_dedup'",
    ).get()).toEqual({ n: 6 });
  });

  test('returns the existing success after an identical retry reaches the response limit', async () => {
    seedForm('fa_rapid_limit', {
      definition: {
        fields,
        logic: [],
        operationsSettings: { maxSubmitCount: 1 },
      },
    });
    const signed = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = () => {
      const value = validBody();
      value.set('fr_id', signed!);
      return value;
    };

    const first = await postForm('fa_rapid_limit', body());
    const duplicate = await postForm('fa_rapid_limit', body());

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.text()).toContain('受付完了');
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_rapid_limit'",
    ).get()).toEqual({ n: 1 });
    expect(notificationMocks.notifyInternalFormSubmission).toHaveBeenCalledTimes(1);
  });

  test('fails open to a normal insert when the rapid duplicate guard cannot run', async () => {
    seedForm('fa_rapid_fail_open');
    const base = DB;
    let guardAttempts = 0;
    DB = {
      prepare(sql: string) {
        if (sql.includes('rapid-submit-dedup')) {
          guardAttempts += 1;
          throw new Error('dedup lookup unavailable');
        }
        return base.prepare(sql);
      },
    } as unknown as D1Database;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signed = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = validBody();
    body.set('fr_id', signed!);

    const response = await postForm('fa_rapid_fail_open', body);

    expect(response.status).toBe(200);
    expect(guardAttempts).toBe(1);
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_rapid_fail_open'",
    ).get()).toEqual({ n: 1 });
    expect(error).toHaveBeenCalledWith(
      'internal form rapid duplicate guard failed; continuing without deduplication',
    );
  });

  test('does not retry an atomic insert after the write itself fails', async () => {
    seedForm('fa_rapid_write_failure');
    const base = DB;
    let insertAttempts = 0;
    DB = {
      prepare(sql: string) {
        if (!sql.includes('INSERT INTO internal_form_submissions')) return base.prepare(sql);
        const statement = {
          bind() { return statement; },
          async run() {
            insertAttempts += 1;
            throw new Error('ambiguous insert failure');
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signed = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = validBody();
    body.set('fr_id', signed!);

    const response = await postForm('fa_rapid_write_failure', body);

    expect(response.status).toBe(500);
    expect(insertAttempts).toBe(1);
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_rapid_write_failure'",
    ).get()).toEqual({ n: 0 });
  });

  test('runs ordered tag/field actions after save and continues after one action fails', async () => {
    seedForm('fa_actions');
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-2', '優先')").run();
    raw.prepare(
      `INSERT INTO friend_field_definitions (id, name, default_value)
       VALUES ('field-payment', '入金確認', '未')`,
    ).run();
    const actions = [
      { type: 'add_tag', tagId: 'missing-tag' },
      { type: 'add_tag', tagId: 'tag-1' },
      { type: 'remove_tag', tagId: 'tag-1' },
      { type: 'add_tag', tagId: 'tag-2' },
      { type: 'set_field', fieldId: 'field-payment', value: '済' },
      { type: 'clear_field', fieldId: 'field-payment' },
      { type: 'set_field', fieldId: 'field-payment', value: '後続成功' },
    ];
    raw.prepare(
      "UPDATE formaloo_forms SET on_submit_actions_json = ? WHERE id = 'fa_actions'",
    ).run(JSON.stringify(actions));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = validBody();
    body.set('fr_id', token!);

    const response = await postForm('fa_actions', body);

    expect(response.status).toBe(200);
    expect(raw.prepare(
      "SELECT tag_id FROM friend_tags WHERE friend_id = 'friend-1' ORDER BY tag_id",
    ).all()).toEqual([{ tag_id: 'tag-2' }]);
    expect(JSON.parse(raw.prepare(
      "SELECT metadata FROM friends WHERE id = 'friend-1'",
    ).pluck().get() as string)).toMatchObject({ 入金確認: '後続成功' });
    expect(logSpy.mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith('[form-submit-action] ')))
      .toEqual([expect.stringContaining('"status":"failed"')]);
  });

  test('keeps an invalid friend token anonymous and ignores unknown answer keys', async () => {
    seedForm('fa_internal');
    raw.prepare(
      `UPDATE formaloo_forms
       SET on_submit_actions_json = '[{"type":"add_tag","tagId":"tag-1"}]'
       WHERE id = 'fa_internal'`,
    ).run();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const body = validBody();
    body.set('fr_id', 'friend-1.tampered');
    body.set('admin', 'true');

    const response = await app().request('/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env());

    expect(response.status).toBe(200);
    const row = raw.prepare('SELECT id, friend_id, origin_channel, answers_json FROM internal_form_submissions').get() as {
      id: string;
      friend_id: string | null;
      origin_channel: string;
      answers_json: string;
    };
    expect(row.friend_id).toBeNull();
    expect(row.origin_channel).toBe('invalid');
    expect(JSON.parse(row.answers_json)).not.toHaveProperty('admin');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
    expect(logSpy.mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith('[form-submit-action] ')))
      .toEqual([expect.stringContaining('"reason":"friend_not_linked"')]);
    expect(notificationMocks.notifyInternalFormSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ DB }),
      { formId: 'fa_internal', submissionId: row.id },
    );
  });

  test('logs exactly one PII-free structured [form-autoreply] line per accepted submission', async () => {
    seedForm('fa_internal');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    notificationMocks.notifyInternalFormSubmission.mockResolvedValue({
      line: { status: 'sent' },
      email: { status: 'skipped', reason: 'no_email_field' },
    });

    try {
      expect((await postForm('fa_internal', validBody())).status).toBe(200);

      const entries = logSpy.mock.calls
        .map((call) => call[0])
        .filter((line): line is string => (
          typeof line === 'string' && line.startsWith('[form-autoreply] ')
        ));
      expect(entries).toHaveLength(1);
      const submission = raw.prepare('SELECT id FROM internal_form_submissions').get() as { id: string };
      expect(JSON.parse(entries[0]!.slice('[form-autoreply] '.length))).toEqual({
        formId: 'fa_internal',
        submissionId: submission.id,
        line: { status: 'sent' },
        email: { status: 'skipped', reason: 'no_email_field' },
      });
      for (const pii of ['佐藤', 'sato@example.com', '090-1234-5678', 'よろしくお願いします', 'U1', '/ife/']) {
        expect(entries[0]).not.toContain(pii);
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  test('logs one bounded PII-free result when the notifier throws', async () => {
    seedForm('fa_internal');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notificationMocks.notifyInternalFormSubmission.mockRejectedValue(
      new Error('佐藤 sato@example.com should never reach the log'),
    );

    try {
      expect((await postForm('fa_internal', validBody())).status).toBe(200);

      const entries = logSpy.mock.calls
        .map((call) => call[0])
        .filter((line): line is string => (
          typeof line === 'string' && line.startsWith('[form-autoreply] ')
        ));
      expect(entries).toHaveLength(1);
      const submission = raw.prepare('SELECT id FROM internal_form_submissions').get() as { id: string };
      expect(JSON.parse(entries[0]!.slice('[form-autoreply] '.length))).toEqual({
        formId: 'fa_internal',
        submissionId: submission.id,
        line: { status: 'failed', reason: 'unexpected_error' },
        email: { status: 'failed', reason: 'unexpected_error' },
      });
      expect(entries[0]).not.toContain('佐藤');
      expect(entries[0]).not.toContain('sato@example.com');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('佐藤');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sato@example.com');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('preserves an invalid GET token through validation so it cannot become an email origin', async () => {
    seedForm('fa_internal');

    const getResponse = await app().request('/f/fa_internal?fr_id=tampered', {}, env());
    const getHtml = await getResponse.text();
    expect(getHtml).not.toContain('name="fr_id"');
    expect(getHtml).toContain('name="_notification_origin" value="invalid"');

    const body = validBody();
    body.set('fr_id', 'tampered');
    body.delete('a_0');
    const postResponse = await app().request('/f/fa_internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, env());

    expect(postResponse.status).toBe(400);
    const invalidHtml = await postResponse.text();
    expect(invalidHtml).not.toContain('name="fr_id"');
    expect(invalidHtml).toContain('name="_notification_origin" value="invalid"');

    const corrected = validBody();
    corrected.set('_notification_origin', 'invalid');
    expect((await postForm('fa_internal', corrected)).status).toBe(200);
    expect(raw.prepare('SELECT origin_channel FROM internal_form_submissions').get())
      .toEqual({ origin_channel: 'invalid' });
  });

  test('別 LINE account の署名済み fr_id は送信にも紐付けない', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-A', 'ch-A', 'A', 'token-A', 'secret-A'), ('acc-B', 'ch-B', 'B', 'token-B', 'secret-B')`).run();
    seedForm('fa_scoped_post');
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-A' WHERE id = 'fa_scoped_post'").run();
    raw.prepare("UPDATE friends SET line_account_id = 'acc-B' WHERE id = 'friend-1'").run();
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = validBody();
    body.set('fr_id', token!);

    const response = await postForm('fa_scoped_post', body);

    expect(response.status).toBe(200);
    expect(raw.prepare('SELECT friend_id, origin_channel FROM internal_form_submissions').get())
      .toEqual({ friend_id: null, origin_channel: 'invalid' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM friend_tags').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM friend_scenarios').get()).toEqual({ n: 0 });
  });

  test('enforces the response limit atomically and never shows success for the rejected answer', async () => {
    seedForm('fa_limited', { definition: {
      fields: [fields[0]], logic: [], operationsSettings: { maxSubmitCount: 1 },
    } });

    const first = await postForm('fa_limited', new URLSearchParams({ a_0: '佐藤' }));
    const second = await postForm('fa_limited', new URLSearchParams({ a_0: '鈴木' }));

    expect(first.status).toBe(200);
    expect(await first.text()).toContain('受付完了');
    expect(second.status).toBe(200);
    const rejectedHtml = await second.text();
    expect(rejectedHtml).toContain('回答上限に達したため受付を終了しました');
    expect(rejectedHtml).not.toContain('受付完了 &lt;b&gt;');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 1 });
  });

  test('keeps the response-limit page for an invalid anonymous retry', async () => {
    seedForm('fa_limited_invalid', { definition: {
      fields: [fields[0]], logic: [], operationsSettings: { maxSubmitCount: 1 },
    } });
    expect((await postForm(
      'fa_limited_invalid',
      new URLSearchParams({ a_0: '佐藤' }),
    )).status).toBe(200);

    const response = await postForm('fa_limited_invalid', new URLSearchParams());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('回答上限に達したため受付を終了しました');
    expect(html).not.toContain('入力してください');
  });

  test.each([
    ['unpublished', "builder_status = 'draft'"],
    ['renderer changed', "render_backend = 'formaloo'"],
  ])('atomic insert 直前に %s になったら上限と誤表示しない', async (_name, update) => {
    seedForm('fa_state_race', { definition: { fields: [fields[0]], logic: [] } });
    beforeAtomicSubmission(() => {
      raw.prepare(`UPDATE formaloo_forms SET ${update} WHERE id = 'fa_state_race'`).run();
    });

    const response = await postForm('fa_state_race', new URLSearchParams({ a_0: '佐藤' }));
    const html = await response.text();

    expect(html).toContain('このフォームは現在ご利用いただけません');
    expect(html).not.toContain('回答上限に達したため');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('atomic insert 直前に definition が更新されたら再読込を案内する', async () => {
    seedForm('fa_definition_race', { definition: { fields: [fields[0]], logic: [] } });
    const updatedDefinition = JSON.stringify({
      fields: [fields[0], { id: 'new', type: 'text', label: '追加項目', required: true, position: 1, config: {} }],
      logic: [],
    });
    beforeAtomicSubmission(() => {
      raw.prepare("UPDATE formaloo_forms SET definition_json = ? WHERE id = 'fa_definition_race'")
        .run(updatedDefinition);
    });

    const response = await postForm('fa_definition_race', new URLSearchParams({ a_0: '佐藤' }));
    const html = await response.text();

    expect(html).toContain('フォームが更新されました');
    expect(html).toContain('ページを読み直し');
    expect(html).not.toContain('回答上限に達したため');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('does not turn a signed duplicate into success when the form is unpublished before insert', async () => {
    seedForm('fa_signed_state_race', { definition: { fields: [fields[0]], logic: [] } });
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = () => new URLSearchParams({ a_0: '佐藤', fr_id: token! });
    expect((await postForm('fa_signed_state_race', body())).status).toBe(200);
    beforeAtomicSubmission(() => {
      raw.prepare(
        "UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'fa_signed_state_race'",
      ).run();
    });

    const response = await postForm('fa_signed_state_race', body());
    const html = await response.text();

    expect(html).toContain('このフォームは現在ご利用いただけません');
    expect(html).not.toContain('受付完了');
    expect(raw.prepare(
      "SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = 'fa_signed_state_race'",
    ).get()).toEqual({ n: 1 });
  });

  test('uses verified LINE channel logic, drops hidden answers, and selects the server-side route completion', async () => {
    seedForm('fa_logic', { definition: logicDefinition() });
    const token = await signFriendToken('friend-1', FRIEND_SECRET);
    const body = new URLSearchParams({
      a_0: 'B', a_2: '改ざんされたA回答', a_4: 'Bの回答', fr_id: token!,
    });

    const response = await postForm('fa_logic', body);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('B専用完了');
    expect(html).toContain('Bルートを受け付けました 完了');
    expect(html).not.toContain('<b>完了</b>');
    const stored = raw.prepare('SELECT friend_id, answers_json FROM internal_form_submissions').get() as {
      friend_id: string; answers_json: string;
    };
    expect(stored.friend_id).toBe('friend-1');
    expect(JSON.parse(stored.answers_json)).toEqual({ kind: 'B', 'answer-b': 'Bの回答' });
  });

  test('terminal submit 後の required を検証対象から外し、改ざん値も保存しない', async () => {
    seedForm('fa_terminal', { definition: {
      fields: [
        { id: 'finish', type: 'text', label: '完了条件', required: true, position: 0, config: {} },
        { id: 'after-terminal', type: 'text', label: '後続必須', required: true, position: 1, config: {} },
      ],
      logic: [{
        id: 'finish-now', sourceFieldId: 'finish', operator: 'equals', value: '', action: 'submit',
        targetFieldId: 'terminal-done', terminalTrigger: 'on_answered',
      }],
      successPages: [{ id: 'terminal-done', title: 'ルート完了', description: '受け付けました' }],
    } });

    const response = await postForm('fa_terminal', new URLSearchParams({
      a_0: '完了',
      a_1: '改ざんされた後続値',
    }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('ルート完了');
    expect(html).not.toContain('後続必須 は必須項目です');
    const stored = raw.prepare('SELECT answers_json FROM internal_form_submissions').get() as { answers_json: string };
    expect(JSON.parse(stored.answers_json)).toEqual({ finish: '完了' });
  });

  test('treats a tampered token as web channel and requires the web-only field', async () => {
    seedForm('fa_logic', { definition: {
      fields: [
        { id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
        { id: 'email-web', type: 'email', label: 'メール', required: true, position: 1, config: {} },
      ],
      logic: [{
        id: 'web-email', sourceFieldId: '__channel__', operator: 'equals', value: 'web',
        action: 'show', targetFieldId: 'email-web',
      }],
    } });
    const response = await postForm('fa_logic', new URLSearchParams({
      a_0: '佐藤', fr_id: 'friend-1.tampered',
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('メール は必須項目です');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 0 });
  });

  test('redirects to the configured completion URL with external-browser intent after persistence', async () => {
    seedForm('fa_redirect', { definition: {
      fields: [fields[0]], logic: [],
      formRedirect: { url: 'https://example.test/thanks?from=form#done', openExternalBrowser: true },
    } });
    const response = await postForm('fa_redirect', new URLSearchParams({ a_0: '佐藤' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://example.test/thanks?from=form&openExternalBrowser=1#done',
    );
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 1 });
  });
});

describe('internal LINE distribution GET /fo/:formId', () => {
  test.each([
    ['f', 'friend-1'],
    ['lu', 'U1'],
  ])('resolves %s, records the open, and redirects with a signed internal fr_id', async (key, value) => {
    seedForm('fa_internal');
    const response = await app().request(`/fo/fa_internal?${key}=${value}`, {}, env());

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!, 'https://worker.example.test');
    expect(location.pathname).toBe('/f/fa_internal');
    const token = location.searchParams.get('fr_id');
    expect(await verifyFriendToken(token, FRIEND_SECRET)).toBe('friend-1');
    expect(raw.prepare('SELECT form_id, friend_id, friend_name FROM form_opens').get()).toEqual({
      form_id: 'fa_internal', friend_id: 'friend-1', friend_name: '佐藤',
    });
  });

  test.each([
    ['f', 'friend-1'],
    ['lu', 'U1'],
  ])('別 LINE account の friend を %s で指定しても匿名化する', async (key, value) => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-A', 'ch-A', 'A', 'token-A', 'secret-A'), ('acc-B', 'ch-B', 'B', 'token-B', 'secret-B')`).run();
    seedForm('fa_scoped');
    raw.prepare("UPDATE formaloo_forms SET line_account_id = 'acc-A' WHERE id = 'fa_scoped'").run();
    raw.prepare("UPDATE friends SET line_account_id = 'acc-B' WHERE id = 'friend-1'").run();

    const response = await app().request(`/fo/fa_scoped?${key}=${value}`, {}, env());
    const location = new URL(response.headers.get('location')!, 'https://worker.example.test');

    expect(response.status).toBe(302);
    expect(location.pathname).toBe('/f/fa_scoped');
    expect(location.searchParams.has('fr_id')).toBe(false);
    expect(raw.prepare('SELECT friend_id, friend_name FROM form_opens').get()).toEqual({
      friend_id: null,
      friend_name: null,
    });
  });

  test.each([
    ['scoped match', 'acc-A', 'acc-A'],
    ['global form', null, 'acc-B'],
  ])('%s は friend を識別したままにする', async (_name, formAccountId, friendAccountId) => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-A', 'ch-A', 'A', 'token-A', 'secret-A'), ('acc-B', 'ch-B', 'B', 'token-B', 'secret-B')`).run();
    seedForm('fa_account_ok');
    raw.prepare('UPDATE formaloo_forms SET line_account_id = ? WHERE id = ?').run(formAccountId, 'fa_account_ok');
    raw.prepare('UPDATE friends SET line_account_id = ? WHERE id = ?').run(friendAccountId, 'friend-1');

    const response = await app().request('/fo/fa_account_ok?f=friend-1', {}, env());
    const location = new URL(response.headers.get('location')!, 'https://worker.example.test');

    expect(await verifyFriendToken(location.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('friend-1');
    expect(raw.prepare('SELECT friend_id FROM form_opens').get()).toEqual({ friend_id: 'friend-1' });
  });

  test('uses a one-shot LIFF bounce and then degrades anonymously without a loop', async () => {
    seedForm('fa_internal');
    const lineResponse = await app().request('/fo/fa_internal', {
      headers: { 'User-Agent': 'Mozilla/5.0 Line/14.0' },
    }, env());
    expect(lineResponse.status).toBe(302);
    expect(decodeURIComponent(lineResponse.headers.get('location')!)).toContain(
      'https://worker.example.test/fo/fa_internal?_lfb=1',
    );
    expect(raw.prepare('SELECT COUNT(*) AS n FROM form_opens').get()).toEqual({ n: 0 });

    const bounced = await app().request('/fo/fa_internal?_lfb=1', {
      headers: { 'User-Agent': 'Mozilla/5.0 Line/14.0' },
    }, env());
    expect(bounced.status).toBe(302);
    expect(bounced.headers.get('location')).toBe('/f/fa_internal');
    expect(raw.prepare('SELECT friend_id FROM form_opens').get()).toEqual({ friend_id: null });
  });

  test('passes non-internal forms to the existing Formaloo route unchanged', async () => {
    seedForm('fa_formaloo', { backend: 'formaloo' });
    const stacked = new Hono<Env>();
    stacked.route('/', internalFormsPublic);
    stacked.get('/fo/:formId', (c) => c.body('formaloo-byte-body', 299));

    const response = await stacked.request('/fo/fa_formaloo', {}, env());
    expect(response.status).toBe(299);
    expect(await response.text()).toBe('formaloo-byte-body');
  });
});
