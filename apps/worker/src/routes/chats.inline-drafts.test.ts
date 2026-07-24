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
const { faqDraftReviews } = await import('./faq-draft-reviews.js');
const { faqs } = await import('./faqs.js');
const {
  approveAiFaqDraft,
  discardAiFaqDraft,
  editAiFaqDraft,
  resolveAiFaqDraftReviewFriend,
} = await import('../services/faq-draft-review.js');

type SyncStatement = D1PreparedStatement & { __runSync: () => { changes: number } };

function asD1(
  raw: Database.Database,
  options: {
    afterFirst?: (sql: string) => void;
    afterRun?: (sql: string) => void;
  } = {},
): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { params = values; return api; },
        async first<T>() {
          const result = (statement.get(...(params as never[])) as T) ?? null;
          options.afterFirst?.(sql);
          return result;
        },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const result = statement.run(...(params as never[]));
          options.afterRun?.(sql);
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

function createApp(raw: Database.Database, options: { withStaff?: boolean } = {}) {
  const app = new Hono<Env>();
  if (options.withStaff !== false) {
    app.use('*', async (c, next) => {
      c.set('staff', { id: 'staff-1', name: '担当者', role: 'staff' });
      await next();
    });
  }
  app.route('/', chats);
  app.route('/', faqDraftReviews);
  app.route('/', faqs);
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
      name TEXT NOT NULL DEFAULT '公式アカウント',
      channel_access_token TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
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
      status TEXT NOT NULL,
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
    CREATE TABLE staff_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
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
    CREATE TABLE auto_replies (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL,
      line_account_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE faqs (
      id TEXT PRIMARY KEY,
      line_account_id TEXT,
      question TEXT NOT NULL,
      variants TEXT NOT NULL DEFAULT '[]',
      answer TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT ''
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

  test('does not expose a corrupt cross-account draft in the pending timeline', async () => {
    seedMessage('question-1', 'friend-1', '営業時間は？', '2026-07-21T10:00:00+09:00');
    seedDraft({ accountId: 'acc-2' });

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

  test('accepts chats.id as well as friend.id for a chat mutation path', async () => {
    seedDraft({});
    const response = await mutate('/api/chats/chat-1/drafts/draft-1', 'PATCH', { draftAnswer: 'チャットID経由' });

    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT draft_answer FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ draft_answer: 'チャットID経由' });
  });

  test('rejects a missing staff actor instead of writing an unknown audit actor', async () => {
    seedDraft({});
    const withoutStaff = createApp(raw, { withStaff: false });
    const response = await withoutStaff.request('/api/chats/friend-1/drafts/draft-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftAnswer: '変更しない' }),
    });

    expect(response.status).toBe(401);
    expect(raw.prepare(`SELECT draft_answer, status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ draft_answer: '10時からです', status: 'pending' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM ai_faq_draft_audit_log`).get())
      .toEqual({ count: 0 });
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
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM faqs`).get()).toEqual({ count: 0 });
  });

  test('adds the sent answer to this account as an inactive editable FAQ and round-trips through the FAQ list', async () => {
    seedDraft({ question: '営業時間は？', answer: '編集後は11時からです' });

    const response = await mutate(
      '/api/chats/friend-1/drafts/draft-1/approve',
      'POST',
      { addToFaq: true },
    );

    expect(response.status).toBe(200);
    expect(raw.prepare(
      `SELECT line_account_id, question, variants, answer, is_active
         FROM faqs`,
    ).get()).toEqual({
      line_account_id: 'acc-1',
      question: '営業時間は？',
      variants: '[]',
      answer: '編集後は11時からです',
      is_active: 0,
    });

    const ownList = await app.request('/api/faqs?accountId=acc-1');
    const ownBody = await ownList.json() as {
      data: Array<{
        lineAccountId: string | null;
        question: string;
        answer: string;
        isActive: boolean;
      }>;
    };
    expect(ownBody.data).toEqual([expect.objectContaining({
      lineAccountId: 'acc-1',
      question: '営業時間は？',
      answer: '編集後は11時からです',
      isActive: false,
    })]);
    expect(JSON.stringify(ownBody.data)).not.toContain('あやこ');

    const otherList = await app.request('/api/faqs?accountId=acc-2');
    const otherBody = await otherList.json() as { data: unknown[] };
    expect(otherBody.data).toEqual([]);
  });

  test('keeps the approved send successful when selected FAQ registration fails', async () => {
    seedDraft({});
    raw.exec(`
      CREATE TRIGGER fail_faq_insert
      BEFORE INSERT ON faqs
      BEGIN SELECT RAISE(ABORT, 'forced FAQ failure'); END;
    `);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await mutate(
        '/api/chats/friend-1/drafts/draft-1/approve',
        'POST',
        { addToFaq: true },
      );

      expect(response.status).toBe(200);
      expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
        .toEqual({ status: 'approved' });
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 1 });
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM faqs`).get()).toEqual({ count: 0 });
      expect(errorSpy).toHaveBeenCalledWith(
        'FAQ registration after draft approval failed:',
        expect.any(String),
      );
    } finally {
      errorSpy.mockRestore();
    }
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

  test('releases the sending claim when the account becomes unavailable before LINE is called', async () => {
    seedDraft({});
    let deactivated = false;
    const db = asD1(raw, {
      afterRun(sql) {
        if (!deactivated && sql.includes(`SET status = ?, updated_at = ?`)) {
          deactivated = true;
          raw.prepare(`UPDATE line_accounts SET is_active=0 WHERE id='acc-1'`).run();
        }
      },
    });

    await expect(approveAiFaqDraft({
      db,
      draftId: 'draft-1',
      friendId: 'friend-1',
      actorStaffId: 'staff-1',
    })).rejects.toMatchObject({ status: 409 });
    expect(lineState.calls).toEqual([]);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'pending' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM ai_faq_draft_audit_log`).get())
      .toEqual({ count: 0 });
  });

  test('an ambiguous LINE failure cannot be retried into a duplicate send', async () => {
    seedDraft({});
    lineState.fail = true;
    const path = '/api/chats/friend-1/drafts/draft-1/approve';
    const first = await mutate(path, 'POST', { addToFaq: true });
    const retry = await mutate(path, 'POST');

    expect(first.status).toBe(502);
    expect(retry.status).toBe(409);
    expect(lineState.calls).toHaveLength(1);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'send_failed' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ action: 'send_failed' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM faqs`).get()).toEqual({ count: 0 });
  });
});

describe('central FAQ draft inbox review mutations', () => {
  const inboxPath = (draftId = 'draft-1', suffix = '') =>
    `/api/faq-draft-reviews/${draftId}${suffix}`;

  test('lists only pending drafts in account scope without exposing friend/account internal IDs', async () => {
    seedDraft({ id: 'draft-visible' });
    seedDraft({ id: 'draft-approved', status: 'approved' });
    seedDraft({ id: 'draft-other', friendId: 'friend-2', accountId: 'acc-2' });

    const response = await app.request('/api/faq-draft-reviews?accountId=acc-1');
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([expect.objectContaining({
      id: 'draft-visible',
      friendName: 'あやこ',
      draftAnswer: '10時からです',
      status: 'pending',
    })]);
    expect(JSON.stringify(body)).not.toMatch(/friendId|friend_id|lineAccountId|line_account_id|evidence/i);
  });

  test('bounds the pending response so a backlog cannot create an unbounded payload', async () => {
    for (let index = 0; index < 501; index += 1) {
      seedDraft({ id: `bulk-${index.toString().padStart(3, '0')}` });
    }

    const response = await app.request('/api/faq-draft-reviews?accountId=acc-1');
    const body = await response.json() as { data: unknown[] };
    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(500);
  });

  test('edits through the shared review service without exposing internal IDs', async () => {
    seedDraft({});
    const response = await mutate(inboxPath(), 'PATCH', {
      accountId: 'acc-1',
      draftAnswer: '中央で編集した回答',
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ id: 'draft-1', draftAnswer: '中央で編集した回答', status: 'pending' });
    expect(JSON.stringify(body)).not.toMatch(/friendId|friend_id|lineAccountId|line_account_id|evidence/i);
    expect(raw.prepare(`SELECT action, actor_staff_id FROM ai_faq_draft_audit_log`).get())
      .toEqual({ action: 'edited', actor_staff_id: 'staff-1' });
  });

  test('discards in account scope and keeps the row/audit instead of deleting it', async () => {
    seedDraft({});
    const response = await mutate(inboxPath(), 'DELETE', { accountId: 'acc-1' });

    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'discarded' });
    expect(raw.prepare(`SELECT action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ action: 'discarded' });
  });

  test('central and chat approval share one CAS so only one request can send', async () => {
    seedDraft({ answer: '中央とチャットで競合' });
    const [central, chat] = await Promise.all([
      mutate(inboxPath('draft-1', '/approve'), 'POST', { accountId: 'acc-1' }),
      mutate('/api/chats/friend-1/drafts/draft-1/approve', 'POST'),
    ]);

    expect([central.status, chat.status].filter((status) => status === 200)).toHaveLength(1);
    expect([central.status, chat.status].every((status) => status === 200 || status === 409)).toBe(true);
    expect(lineState.calls).toEqual([{ token: 'token-1', to: 'U-one', text: '中央とチャットで競合' }]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 1 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM ai_faq_draft_audit_log WHERE action='approved'`).get())
      .toEqual({ count: 1 });
  });

  test('central approval forwards the FAQ choice through the same account-scoped hook', async () => {
    seedDraft({ question: '中央の質問', answer: '中央の回答' });

    const response = await mutate(
      inboxPath('draft-1', '/approve'),
      'POST',
      { accountId: 'acc-1', addToFaq: true },
    );

    expect(response.status).toBe(200);
    expect(raw.prepare(
      `SELECT line_account_id, question, answer, is_active FROM faqs`,
    ).get()).toEqual({
      line_account_id: 'acc-1',
      question: '中央の質問',
      answer: '中央の回答',
      is_active: 0,
    });
  });

  test('records the actual friend account in audit for a legacy null-account draft', async () => {
    seedDraft({ accountId: null });

    const response = await mutate(inboxPath('draft-1', '/approve'), 'POST', { accountId: 'acc-1' });

    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT line_account_id, action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ line_account_id: 'acc-1', action: 'approved' });
  });

  test('rechecks selected account inside the shared service after central route resolution', async () => {
    seedDraft({ accountId: null });
    const db = asD1(raw);
    const friendId = await resolveAiFaqDraftReviewFriend(db, 'draft-1', 'acc-1');
    raw.prepare(`UPDATE friends SET line_account_id='acc-2' WHERE id='friend-1'`).run();

    await expect(approveAiFaqDraft({
      db,
      draftId: 'draft-1',
      friendId,
      actorStaffId: 'staff-1',
      expectedLineAccountId: 'acc-1',
    })).rejects.toMatchObject({ status: 403 });
    expect(lineState.calls).toEqual([]);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'pending' });
  });

  test.each([
    ['edit', async (db: D1Database) => editAiFaqDraft({
      db,
      draftId: 'draft-1',
      friendId: 'friend-1',
      actorStaffId: 'staff-1',
      draftAnswer: '越境させない編集',
      expectedLineAccountId: 'acc-1',
    })],
    ['discard', async (db: D1Database) => discardAiFaqDraft({
      db,
      draftId: 'draft-1',
      friendId: 'friend-1',
      actorStaffId: 'staff-1',
      expectedLineAccountId: 'acc-1',
    })],
  ])('guards central %s finalization when friend account changes after claim verification', async (_action, review) => {
    seedDraft({ accountId: null });
    let contextReads = 0;
    const db = asD1(raw, {
      afterFirst(sql) {
        if (!sql.includes('FROM ai_faq_drafts d')) return;
        contextReads += 1;
        if (contextReads === 2) {
          raw.prepare(`UPDATE friends SET line_account_id='acc-2' WHERE id='friend-1'`).run();
        }
      },
    });

    await expect(review(db)).rejects.toMatchObject({ status: 403 });
    expect(raw.prepare(`SELECT draft_answer, status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ draft_answer: '10時からです', status: 'pending' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM ai_faq_draft_audit_log`).get())
      .toEqual({ count: 0 });
  });

  test('finalizes an already-sent approval from the claimed account snapshot if friend ownership changes', async () => {
    seedDraft({ accountId: null });
    let contextReads = 0;
    const db = asD1(raw, {
      afterFirst(sql) {
        if (!sql.includes('FROM ai_faq_drafts d')) return;
        contextReads += 1;
        if (contextReads === 3) {
          raw.prepare(`UPDATE friends SET line_account_id='acc-2' WHERE id='friend-1'`).run();
        }
      },
    });

    await expect(approveAiFaqDraft({
      db,
      draftId: 'draft-1',
      friendId: 'friend-1',
      actorStaffId: 'staff-1',
      expectedLineAccountId: 'acc-1',
    })).resolves.toMatchObject({ draft: { status: 'approved' } });
    expect(lineState.calls).toEqual([{ token: 'token-1', to: 'U-one', text: '10時からです' }]);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'approved' });
    expect(raw.prepare(`SELECT line_account_id, action FROM ai_faq_draft_audit_log`).get())
      .toEqual({ line_account_id: 'acc-1', action: 'approved' });
  });

  test('rejects another account before claim, mutation, audit, or LINE send', async () => {
    seedDraft({});
    const response = await mutate(inboxPath('draft-1', '/approve'), 'POST', { accountId: 'acc-2' });

    expect(response.status).toBe(403);
    expect(lineState.calls).toEqual([]);
    expect(raw.prepare(`SELECT status FROM ai_faq_drafts WHERE id='draft-1'`).get())
      .toEqual({ status: 'pending' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM ai_faq_draft_audit_log`).get())
      .toEqual({ count: 0 });
  });
});
