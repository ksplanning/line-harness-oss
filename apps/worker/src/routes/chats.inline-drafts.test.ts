import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const lineState = vi.hoisted(() => ({
  calls: [] as Array<{ token: string; to: string; text: string }>,
  fail: false,
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(private readonly token: string) {}
    async pushTextMessage(to: string, text: string) {
      lineState.calls.push({ token: this.token, to, text });
      if (lineState.fail) throw new Error('ambiguous LINE failure');
      return {};
    }
  },
}));

const { chats } = await import('./chats.js');

type SyncStatement = D1PreparedStatement & { __runSync: () => { changes: number } };

function asD1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { params = values; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
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
      return execute().map((result) => ({ success: true, meta: { changes: result.changes } })) as unknown as D1Result[];
    },
  } as unknown as D1Database;
}

function createApp(raw: Database.Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当者', role: 'staff' });
    await next();
  });
  app.route('/', chats);
  const bindings = {
    DB: asD1(raw),
    LINE_CHANNEL_ACCESS_TOKEN: 'unsafe-default-token',
  } as Env['Bindings'];
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, bindings),
  };
}

let raw: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  lineState.calls.length = 0;
  lineState.fail = false;
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_access_token TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      display_name TEXT,
      picture_url TEXT,
      line_account_id TEXT
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      operator_id TEXT,
      status TEXT NOT NULL,
      notes TEXT,
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
      created_at TEXT NOT NULL
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
    CREATE TABLE ai_faq_draft_audit_log (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      line_account_id TEXT,
      friend_id TEXT NOT NULL,
      actor_staff_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    INSERT INTO line_accounts (id, channel_access_token, is_active) VALUES
      ('acc-1', 'token-1', 1), ('acc-2', 'token-2', 1), ('acc-off', 'token-off', 0);
    INSERT INTO friends (id, line_user_id, display_name, picture_url, line_account_id) VALUES
      ('friend-1', 'U-one', 'あやこ', NULL, 'acc-1'),
      ('friend-2', 'U-two', '別の人', NULL, 'acc-2'),
      ('friend-off', 'U-off', '停止中', NULL, 'acc-off');
    INSERT INTO chats (id, friend_id, status, created_at, updated_at) VALUES
      ('chat-1', 'friend-1', 'in_progress', '2026-07-21T09:00:00+09:00', '2026-07-21T09:00:00+09:00'),
      ('chat-off', 'friend-off', 'in_progress', '2026-07-21T09:00:00+09:00', '2026-07-21T09:00:00+09:00');
  `);
  app = createApp(raw);
});

function seedMessage(id: string, friendId: string, content: string, createdAt: string, direction = 'incoming') {
  raw.prepare(`INSERT INTO messages_log
    (id, friend_id, direction, message_type, content, source, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?)`)
    .run(id, friendId, direction, content, direction === 'incoming' ? 'user' : 'manual', createdAt);
}

function seedDraft(options: {
  id?: string;
  friendId?: string;
  accountId?: string | null;
  question?: string;
  answer?: string;
  status?: string;
  createdAt?: string;
}) {
  const values = {
    id: 'draft-1',
    friendId: 'friend-1',
    accountId: 'acc-1' as string | null,
    question: '営業時間は？',
    answer: '10時からです',
    status: 'pending',
    createdAt: '2026-07-21T10:01:00.000',
    ...options,
  };
  raw.prepare(`INSERT INTO ai_faq_drafts
    (id, line_account_id, friend_id, question, draft_answer, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(values.id, values.accountId, values.friendId, values.question, values.answer, values.status, values.createdAt, values.createdAt);
}

function mutate(path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('GET /api/chats/:id — pending AI drafts in timeline', () => {
  test('returns only this friend pending drafts and points each draft at the newest matching prior question', async () => {
    seedMessage('question-old', 'friend-1', '営業時間は？', '2026-07-21T09:00:00+09:00');
    seedMessage('question-new', 'friend-1', '営業時間は？', '2026-07-21T10:00:00+09:00');
    seedDraft({ id: 'draft-visible' });
    seedDraft({ id: 'draft-approved', status: 'approved' });
    seedDraft({ id: 'draft-other', friendId: 'friend-2', accountId: 'acc-2' });

    const response = await app.request('/api/chats/friend-1');
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { pendingDrafts: unknown[] } };
    expect(body.data.pendingDrafts).toEqual([{
      id: 'draft-visible',
      question: '営業時間は？',
      draftAnswer: '10時からです',
      createdAt: '2026-07-21T10:01:00.000',
      updatedAt: '2026-07-21T10:01:00.000',
      questionMessageId: 'question-new',
    }]);
  });

  test('returns an empty draft list when this chat has no pending draft', async () => {
    seedMessage('question-1', 'friend-1', '質問', '2026-07-21T10:00:00+09:00');
    seedDraft({ id: 'draft-other', friendId: 'friend-2', accountId: 'acc-2', question: '質問' });

    const response = await app.request('/api/chats/friend-1');
    const body = await response.json() as { data: { pendingDrafts: unknown[] } };
    expect(body.data.pendingDrafts).toEqual([]);
  });
});

describe('inline draft review mutations', () => {
  test('edits a pending answer and appends an immutable actor audit row', async () => {
    seedDraft({});
    const response = await mutate('/api/chats/friend-1/drafts/draft-1', 'PATCH', { draftAnswer: '11時からです' });

    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT draft_answer, status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ draft_answer: '11時からです', status: 'pending' });
    expect(raw.prepare(`SELECT draft_id, actor_staff_id, action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ draft_id: 'draft-1', actor_staff_id: 'staff-1', action: 'edited' });
  });

  test('discards by status instead of deleting and keeps an audit trail', async () => {
    seedDraft({});
    const response = await mutate('/api/chats/friend-1/drafts/draft-1', 'DELETE');

    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'discarded' });
    expect(raw.prepare(`SELECT action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ action: 'discarded' });
  });

  test('approves the edited text once, writes faq_bot push log, and finalizes audit/status', async () => {
    seedDraft({ answer: '編集後の回答' });
    const path = '/api/chats/friend-1/drafts/draft-1/approve';
    const [first, second] = await Promise.all([
      mutate(path, 'POST'),
      mutate(path, 'POST'),
    ]);

    expect([first.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    expect([first.status, second.status].every((status) => status === 200 || status === 409)).toBe(true);
    expect(lineState.calls).toEqual([{ token: 'token-1', to: 'U-one', text: '編集後の回答' }]);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'approved' });
    expect(raw.prepare(`SELECT friend_id, direction, message_type, content, delivery_type, source, line_account_id
      FROM messages_log`).get()).toEqual({
      friend_id: 'friend-1',
      direction: 'outgoing',
      message_type: 'text',
      content: '編集後の回答',
      delivery_type: 'push',
      source: 'faq_bot',
      line_account_id: 'acc-1',
    });
    expect(raw.prepare(`SELECT action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ action: 'approved' });
  });

  test('fails closed on account mismatch before LINE and keeps the draft pending', async () => {
    seedDraft({ accountId: 'acc-2' });
    const response = await mutate('/api/chats/friend-1/drafts/draft-1/approve', 'POST');

    expect(response.status).toBe(409);
    expect(lineState.calls).toEqual([]);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'pending' });
  });

  test('does not fall back to the default token when the friend account is inactive', async () => {
    seedDraft({ id: 'draft-off', friendId: 'friend-off', accountId: 'acc-off' });
    const response = await mutate('/api/chats/friend-off/drafts/draft-off/approve', 'POST');

    expect(response.status).toBe(409);
    expect(lineState.calls).toEqual([]);
  });

  test('an ambiguous LINE failure cannot be retried into a duplicate send', async () => {
    seedDraft({});
    lineState.fail = true;
    const path = '/api/chats/friend-1/drafts/draft-1/approve';
    const first = await mutate(path, 'POST');
    const retry = await mutate(path, 'POST');

    expect(first.status).toBe(502);
    expect(retry.status).toBe(409);
    expect(lineState.calls).toHaveLength(1);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'send_failed' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ action: 'send_failed' });
  });
});
