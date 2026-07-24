import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminAuth } from './admin-auth.js';

const lineState = vi.hoisted(() => ({
  calls: [] as Array<{ token: string; to: string; text: string }>,
  flexCalls: [] as Array<{
    token: string;
    to: string;
    altText: string;
    contents: unknown;
  }>,
  imageCalls: [] as Array<{
    token: string;
    to: string;
    originalContentUrl: string;
    previewImageUrl: string;
  }>,
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(private readonly token: string) {}

    async pushTextMessage(to: string, text: string) {
      lineState.calls.push({ token: this.token, to, text });
      return {};
    }

    async pushMessage(to: string, messages: Array<{ type: string; text?: string }>) {
      lineState.calls.push({
        token: this.token,
        to,
        text: messages[0]?.text ?? '',
      });
      return {};
    }

    async pushFlexMessage(to: string, altText: string, contents: unknown) {
      lineState.flexCalls.push({ token: this.token, to, altText, contents });
      return {};
    }

    async pushImageMessage(
      to: string,
      originalContentUrl: string,
      previewImageUrl: string,
    ) {
      lineState.imageCalls.push({
        token: this.token,
        to,
        originalContentUrl,
        previewImageUrl,
      });
      return {};
    }
  },
}));

const { chats } = await import('./chats.js');

type SyncStatement = D1PreparedStatement & {
  __runSync: () => { changes: number };
};

function asD1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          params = values;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
        __runSync() {
          const result = statement.run(...(params as never[]));
          return { changes: result.changes };
        },
      };
      return api as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const execute = raw.transaction(() => statements.map((statement) => (
        (statement as SyncStatement).__runSync()
      )));
      return execute().map((result) => ({
        success: true,
        meta: { changes: result.changes },
      })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
}

function createApp(raw: Database.Database) {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', adminAuth);
  app.route('/', chats);

  const bindings = {
    DB: asD1(raw),
    LINE_CHANNEL_ACCESS_TOKEN: 'unsafe-default-token',
    API_KEY: 'env-owner-key',
    WORKER_URL: 'http://localhost',
  } as Env['Bindings'];

  const request = (path: string, init?: RequestInit) =>
    app.request(path, init, bindings);

  const requestAs = (
    apiKey: 'staff-a-key' | 'staff-b-key',
    path: string,
    init: RequestInit = {},
  ) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${apiKey}`);
    return request(path, { ...init, headers });
  };

  const postAs = (
    apiKey: 'staff-a-key' | 'staff-b-key',
    path: string,
    body?: unknown,
  ) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('Authorization', `Bearer ${apiKey}`);
    return request(path, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  return { request, requestAs, postAs };
}

function setUpSchema(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE staff_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      role_id TEXT,
      reply_signature_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      channel_access_token TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE account_settings (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT 'now',
      updated_at TEXT NOT NULL DEFAULT 'now',
      UNIQUE(line_account_id, key)
    );

    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      display_name TEXT,
      picture_url TEXT,
      line_account_id TEXT,
      is_following INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      operator_id TEXT,
      assigned_staff_id TEXT,
      status TEXT NOT NULL DEFAULT 'unread',
      notes TEXT,
      read_at TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE messages_log (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      broadcast_id TEXT,
      scenario_step_id TEXT,
      delivery_type TEXT,
      source TEXT,
      line_account_id TEXT,
      staff_member_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE auto_replies (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL,
      line_account_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE ai_faq_drafts (
      id TEXT PRIMARY KEY,
      line_account_id TEXT,
      friend_id TEXT,
      question TEXT NOT NULL,
      draft_answer TEXT NOT NULL,
      evidence_faq_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function seedBaseRows(raw: Database.Database): void {
  raw.exec(`
    INSERT INTO staff_members
      (id, name, role, api_key, is_active, reply_signature_enabled, created_at, updated_at)
    VALUES
      ('staff-a', '担当A', 'staff', 'staff-a-key', 1, 1, '2026-07-23T09:00:00+09:00', '2026-07-23T09:00:00+09:00'),
      ('staff-b', '担当B', 'staff', 'staff-b-key', 1, 1, '2026-07-23T09:00:00+09:00', '2026-07-23T09:00:00+09:00');

    INSERT INTO line_accounts (id, name, channel_access_token, is_active)
    VALUES
      ('acc-1', '公式1', 'token-1', 1),
      ('acc-2', '公式2', 'token-2', 1),
      ('acc-off', '停止中', 'token-off', 0);

    INSERT INTO friends
      (id, line_user_id, display_name, picture_url, line_account_id, is_following)
    VALUES
      ('friend-1', 'U-one', '顧客1', NULL, 'acc-1', 1),
      ('friend-2', 'U-two', '顧客2', NULL, 'acc-2', 1),
      ('friend-off', 'U-off', '停止中の顧客', NULL, 'acc-off', 1),
      ('friend-missing', 'U-missing', '設定不明の顧客', NULL, 'acc-missing', 1);

    INSERT INTO chats
      (id, friend_id, status, last_message_at, created_at, updated_at)
    VALUES
      ('chat-1', 'friend-1', 'unread', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00'),
      ('chat-2', 'friend-2', 'unread', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00'),
      ('chat-off', 'friend-off', 'unread', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00'),
      ('chat-missing', 'friend-missing', 'unread', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00', '2026-07-23T10:00:00+09:00');

    INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, source, line_account_id, created_at)
    VALUES
      ('incoming-1', 'friend-1', 'incoming', 'text', '相談があります', 'user_unmatched', 'acc-1', '2026-07-23T10:00:00+09:00');
  `);
}

type InquiryResponse = {
  success: boolean;
  data: {
    friendId: string;
    status: string;
    assignedStaffId: string | null;
    assignedStaffName: string | null;
    messages: Array<{
      id: string;
      direction: string;
      content: string;
      staffMemberId: string | null;
      staffMemberName: string | null;
    }>;
  };
};

let raw: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  lineState.calls.length = 0;
  lineState.flexCalls.length = 0;
  lineState.imageCalls.length = 0;
  raw = new Database(':memory:');
  setUpSchema(raw);
  seedBaseRows(raw);
  app = createApp(raw);
});

describe('inquiry console authentication and claim', () => {
  test('the detail GET is read-only and the login cookie can claim only with its matching CSRF token', async () => {
    const anonymous = await app.request('/api/chats/friend-1/inquiry/open', {
      method: 'POST',
    });
    expect(anonymous.status).toBe(401);

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'staff-a-key' }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('Set-Cookie')).toContain('lh_admin_session=staff-a-key');
    const loginBody = await login.json() as { csrfToken: string };

    const detail = await app.request('/api/chats/friend-1', {
      headers: { Cookie: 'lh_admin_session=staff-a-key' },
    });
    expect(detail.status).toBe(200);
    expect(raw.prepare(
      `SELECT status, assigned_staff_id, read_at
         FROM chats WHERE id = 'chat-1'`,
    ).get()).toEqual({
      status: 'unread',
      assigned_staff_id: null,
      read_at: null,
    });

    const missingCsrf = await app.request('/api/chats/friend-1/inquiry/open', {
      method: 'POST',
      headers: {
        Cookie: `lh_admin_session=staff-a-key; lh_csrf=${loginBody.csrfToken}`,
      },
    });
    expect(missingCsrf.status).toBe(403);

    const opened = await app.request('/api/chats/friend-1/inquiry/open', {
      method: 'POST',
      headers: {
        Cookie: `lh_admin_session=staff-a-key; lh_csrf=${loginBody.csrfToken}`,
        'X-CSRF-Token': loginBody.csrfToken,
      },
    });
    expect(opened.status).toBe(200);
    expect((await opened.json() as InquiryResponse).data.assignedStaffId).toBe('staff-a');
  });

  test('the first opener claims an unread inquiry and a second staff member cannot replace the assignee', async () => {
    const first = await app.postAs('staff-a-key', '/api/chats/friend-1/inquiry/open');
    expect(first.status).toBe(200);
    expect((await first.json() as InquiryResponse).data).toMatchObject({
      friendId: 'friend-1',
      status: 'in_progress',
      assignedStaffId: 'staff-a',
      assignedStaffName: '担当A',
    });

    const second = await app.postAs('staff-b-key', '/api/chats/friend-1/inquiry/open');
    expect(second.status).toBe(200);
    expect((await second.json() as InquiryResponse).data).toMatchObject({
      status: 'in_progress',
      assignedStaffId: 'staff-a',
      assignedStaffName: '担当A',
    });

    expect(raw.prepare(
      `SELECT status, assigned_staff_id, read_at IS NOT NULL AS was_read
         FROM chats WHERE id = 'chat-1'`,
    ).get()).toEqual({
      status: 'in_progress',
      assigned_staff_id: 'staff-a',
      was_read: 1,
    });
  });

  test('the explicit complete action resolves the claimed inquiry without dropping its assignee', async () => {
    raw.prepare(
      `UPDATE chats
          SET status = 'in_progress',
              assigned_staff_id = 'staff-a',
              read_at = '2026-07-23T10:01:00+09:00'
        WHERE id = 'chat-1'`,
    ).run();

    const response = await app.postAs(
      'staff-a-key',
      '/api/chats/friend-1/complete',
    );
    expect(response.status).toBe(200);
    expect((await response.json() as InquiryResponse).data).toMatchObject({
      friendId: 'friend-1',
      status: 'resolved',
      assignedStaffId: 'staff-a',
      assignedStaffName: '担当A',
    });
    expect(raw.prepare(
      `SELECT status, assigned_staff_id, read_at IS NOT NULL AS was_read
         FROM chats WHERE id = 'chat-1'`,
    ).get()).toEqual({
      status: 'resolved',
      assigned_staff_id: 'staff-a',
      was_read: 1,
    });
  });

  test('a different staff member cannot send or complete an inquiry already assigned to someone else', async () => {
    raw.prepare(
      `UPDATE chats
          SET status = 'in_progress',
              assigned_staff_id = 'staff-a',
              read_at = '2026-07-23T10:01:00+09:00'
        WHERE id = 'chat-1'`,
    ).run();

    const send = await app.postAs('staff-b-key', '/api/chats/friend-1/send', {
      messageType: 'text',
      content: '別スタッフから送ってはいけない',
    });
    const complete = await app.postAs(
      'staff-b-key',
      '/api/chats/friend-1/complete',
    );

    expect({
      send: send.status,
      complete: complete.status,
    }).toEqual({
      send: 409,
      complete: 409,
    });
    expect(lineState.calls).toEqual([]);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count
         FROM messages_log WHERE direction = 'outgoing'`,
    ).get()).toEqual({ count: 0 });
    expect(raw.prepare(
      `SELECT status, assigned_staff_id, read_at
         FROM chats WHERE id = 'chat-1'`,
    ).get()).toEqual({
      status: 'in_progress',
      assigned_staff_id: 'staff-a',
      read_at: '2026-07-23T10:01:00+09:00',
    });
  });
});

describe('operator replies from the inquiry console', () => {
  test('the signed-in staff member can read and change the reply signature preference', async () => {
    const initial = await app.requestAs(
      'staff-a-key',
      '/api/chats/inquiry/preferences',
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      success: true,
      data: {
        staffId: 'staff-a',
        staffName: '担当A',
        replySignatureEnabled: true,
      },
    });

    const updated = await app.requestAs(
      'staff-a-key',
      '/api/chats/inquiry/preferences',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replySignatureEnabled: false }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      success: true,
      data: {
        staffId: 'staff-a',
        staffName: '担当A',
        replySignatureEnabled: false,
      },
    });
    expect(raw.prepare(
      `SELECT reply_signature_enabled
         FROM staff_members WHERE id = 'staff-a'`,
    ).get()).toEqual({ reply_signature_enabled: 0 });
  });

  test.each([
    ['missing', null],
    ['empty', ''],
  ])('a %s account reply name sends the original text even when the personal flag is ON', async (_case, value) => {
    if (value !== null) {
      raw.prepare(
        `INSERT INTO account_settings (id, line_account_id, key, value)
         VALUES ('reply-name-1', 'acc-1', 'chat_reply_sender_name', ?)`,
      ).run(value);
    }

    const response = await app.postAs('staff-a-key', '/api/chats/friend-1/send', {
      messageType: 'text',
      content: '設定が空の返信です',
    });

    expect(response.status).toBe(200);
    expect(lineState.calls).toEqual([{
      token: 'token-1',
      to: 'U-one',
      text: '設定が空の返信です',
    }]);
    expect(raw.prepare(
      `SELECT content, staff_member_id
         FROM messages_log WHERE direction = 'outgoing'`,
    ).get()).toEqual({
      content: '設定が空の返信です',
      staff_member_id: 'staff-a',
    });
  });

  test('the account reply name is prefixed independently of the actor name and personal flag', async () => {
    raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('reply-name-1', 'acc-1', 'chat_reply_sender_name', '共通窓口')`,
    ).run();
    raw.prepare(
      `UPDATE staff_members SET reply_signature_enabled = 0 WHERE id = 'staff-a'`,
    ).run();

    const response = await app.postAs('staff-a-key', '/api/chats/friend-1/send', {
      messageType: 'text',
      content: '確認して折り返します',
    });

    expect(response.status).toBe(200);
    expect(lineState.calls).toEqual([{
      token: 'token-1',
      to: 'U-one',
      text: '担当: 共通窓口\n確認して折り返します',
    }]);
    expect(lineState.calls[0]?.text).not.toContain('担当A');
    expect(raw.prepare(
      `SELECT friend_id, content, source, staff_member_id
         FROM messages_log WHERE direction = 'outgoing'`,
    ).get()).toEqual({
      friend_id: 'friend-1',
      content: '担当: 共通窓口\n確認して折り返します',
      source: 'manual',
      staff_member_id: 'staff-a',
    });
  });

  test('an account A reply name does not affect replies from account B', async () => {
    raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('reply-name-1', 'acc-1', 'chat_reply_sender_name', 'A窓口')`,
    ).run();

    const response = await app.postAs('staff-a-key', '/api/chats/friend-2/send', {
      messageType: 'text',
      content: 'Bアカウントからの返信です',
    });

    expect(response.status).toBe(200);
    expect(lineState.calls).toEqual([{
      token: 'token-2',
      to: 'U-two',
      text: 'Bアカウントからの返信です',
    }]);
    expect(raw.prepare(
      `SELECT line_account_id, content
         FROM messages_log WHERE direction = 'outgoing'`,
    ).get()).toEqual({
      line_account_id: 'acc-2',
      content: 'Bアカウントからの返信です',
    });
  });

  test('a configured reply name leaves flex and image SDK arguments and log content unchanged', async () => {
    raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('reply-name-1', 'acc-1', 'chat_reply_sender_name', '共通窓口')`,
    ).run();
    const flexContents = {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: 'カード本文' }],
      },
    };
    const flexContent = JSON.stringify(flexContents);
    const imageContent = JSON.stringify({
      originalContentUrl: 'https://cdn.example.com/original.png',
      previewImageUrl: 'https://cdn.example.com/preview.png',
    });

    const flexResponse = await app.postAs('staff-a-key', '/api/chats/friend-1/send', {
      messageType: 'flex',
      content: flexContent,
    });
    const imageResponse = await app.postAs('staff-a-key', '/api/chats/friend-1/send', {
      messageType: 'image',
      content: imageContent,
    });

    expect([flexResponse.status, imageResponse.status]).toEqual([200, 200]);
    expect(lineState.calls).toEqual([]);
    expect(lineState.flexCalls).toEqual([{
      token: 'token-1',
      to: 'U-one',
      altText: 'カード本文',
      contents: flexContents,
    }]);
    expect(lineState.imageCalls).toEqual([{
      token: 'token-1',
      to: 'U-one',
      originalContentUrl: 'https://cdn.example.com/original.png',
      previewImageUrl: 'https://cdn.example.com/preview.png',
    }]);
    expect(raw.prepare(
      `SELECT message_type, content
         FROM messages_log
        WHERE direction = 'outgoing'
        ORDER BY rowid`,
    ).all()).toEqual([
      { message_type: 'flex', content: flexContent },
      { message_type: 'image', content: imageContent },
    ]);
  });

  test('recipient-like body fields cannot override the friend and official account fixed by the path', async () => {
    raw.prepare(
      `UPDATE staff_members SET reply_signature_enabled = 0 WHERE id = 'staff-a'`,
    ).run();

    const response = await app.postAs('staff-a-key', '/api/chats/friend-1/send', {
      messageType: 'text',
      content: 'パスで固定された宛先だけに送る',
      friendId: 'friend-2',
      to: 'U-two',
      lineAccountId: 'acc-2',
    });

    expect(response.status).toBe(200);
    expect(lineState.calls).toEqual([{
      token: 'token-1',
      to: 'U-one',
      text: 'パスで固定された宛先だけに送る',
    }]);
    expect(raw.prepare(
      `SELECT friend_id FROM messages_log WHERE direction = 'outgoing'`,
    ).all()).toEqual([{ friend_id: 'friend-1' }]);
  });

  test.each([
    ['inactive', 'friend-off'],
    ['missing', 'friend-missing'],
  ])('an explicit %s LINE account fails closed without sending or logging', async (_case, friendId) => {
    const response = await app.postAs('staff-a-key', `/api/chats/${friendId}/send`, {
      messageType: 'text',
      content: '送信してはいけない',
    });

    expect(response.status).toBe(409);
    expect(lineState.calls).toEqual([]);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM messages_log WHERE direction = 'outgoing'`,
    ).get()).toEqual({ count: 0 });
  });

  test('inquiry history exposes the recorded staff id and display name for each reply', async () => {
    raw.prepare(
      `INSERT INTO messages_log
        (id, friend_id, direction, message_type, content, source, line_account_id, staff_member_id, created_at)
       VALUES
        ('reply-1', 'friend-1', 'outgoing', 'text', ?, 'manual', 'acc-1', 'staff-a', '2026-07-23T10:02:00+09:00')`,
    ).run('担当: 担当A\n回答です');

    const response = await app.requestAs('staff-b-key', '/api/chats/friend-1');
    expect(response.status).toBe(200);
    const body = await response.json() as InquiryResponse;
    expect(body.data.messages).toContainEqual(expect.objectContaining({
      id: 'reply-1',
      direction: 'outgoing',
      content: '担当: 担当A\n回答です',
      staffMemberId: 'staff-a',
      staffMemberName: '担当A',
    }));
  });
});
