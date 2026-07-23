import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { chats } from './chats.js';
import { conversations } from './conversations.js';
import { inbox } from './inbox.js';

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
      };
      return api as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

type UnansweredListResponse = {
  success: true;
  data: { total: number; rows: Array<{ friendId: string }> };
};

type UnansweredCountResponse = {
  success: true;
  data: { total: number };
};

type ChatListResponse = {
  success: true;
  data: Array<{
    friendId: string;
    status: string;
    isUnanswered: boolean;
  }>;
};

type ChatDetailResponse = {
  success: true;
  data: {
    friendId: string;
    status: string;
    isUnanswered: boolean;
  };
};

type ConversationListResponse = {
  success: true;
  data: {
    total: number;
    items: Array<{ friendId: string }>;
  };
};

let raw: Database.Database;
let request: (path: string) => Promise<Response>;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
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
    CREATE TABLE auto_replies (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL,
      line_account_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE friend_tags (
      friend_id TEXT NOT NULL,
      tag_id TEXT NOT NULL
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
    INSERT INTO line_accounts (id, name, is_active)
    VALUES ('account-1', '公式アカウント', 1);
  `);

  const app = new Hono<Env>();
  app.route('/', inbox);
  app.route('/', chats);
  app.route('/', conversations);
  const bindings = { DB: asD1(raw) } as Env['Bindings'];
  request = (path) => app.request(path, undefined, bindings);
});

function insertFriend(
  id: string,
  status: 'unread' | 'in_progress' | 'resolved',
): void {
  raw.prepare(`
    INSERT INTO friends
      (id, line_user_id, display_name, picture_url, line_account_id, is_following)
    VALUES (?, ?, ?, NULL, 'account-1', 1)
  `).run(id, `U-${id}`, id);
  raw.prepare(`
    INSERT INTO chats
      (id, friend_id, status, last_message_at, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
  `).run(`chat-${id}`, id, status, '2026-07-23T09:00:00.000Z', '2026-07-23T09:00:00.000Z');
}

function insertMessage(options: {
  id: string;
  friendId: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  source: string;
  createdAt: string;
  deliveryType?: string | null;
}): void {
  raw.prepare(`
    INSERT INTO messages_log
      (id, friend_id, direction, message_type, content, delivery_type, source, line_account_id, created_at)
    VALUES (?, ?, ?, 'text', ?, ?, ?, 'account-1', ?)
  `).run(
    options.id,
    options.friendId,
    options.direction,
    options.content,
    options.deliveryType ?? null,
    options.source,
    options.createdAt,
  );
}

async function snapshot() {
  const [listResponse, countResponse, chatsResponse, unansweredChatsResponse, conversationsResponse] =
    await Promise.all([
      request('/api/inbox/unanswered?pageSize=2000'),
      request('/api/inbox/unanswered/count'),
      request('/api/chats'),
      request('/api/chats?unansweredOnly=1'),
      request('/api/conversations?minHoursSince=-1000'),
    ]);

  expect([
    listResponse.status,
    countResponse.status,
    chatsResponse.status,
    unansweredChatsResponse.status,
    conversationsResponse.status,
  ]).toEqual([200, 200, 200, 200, 200]);

  return {
    list: await listResponse.json() as UnansweredListResponse,
    count: await countResponse.json() as UnansweredCountResponse,
    chats: await chatsResponse.json() as ChatListResponse,
    unansweredChats: await unansweredChatsResponse.json() as ChatListResponse,
    conversations: await conversationsResponse.json() as ConversationListResponse,
  };
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

describe('unanswered-inbox is the single source for all unanswered indicators', () => {
  test('keyword auto reply, keep_unresponded, and human unanswered agree across every API', async () => {
    insertFriend('auto-replied', 'unread');
    insertFriend('keep-unresponded', 'resolved');
    insertFriend('human-unanswered', 'resolved');

    insertMessage({
      id: 'incoming-auto',
      friendId: 'auto-replied',
      direction: 'incoming',
      content: '#予約',
      source: 'auto_reply_keyword',
      createdAt: '2026-07-23T09:01:00.000Z',
    });
    insertMessage({
      id: 'outgoing-auto',
      friendId: 'auto-replied',
      direction: 'outgoing',
      content: '予約をご案内します',
      source: 'auto_reply',
      deliveryType: 'reply',
      createdAt: '2026-07-23T09:01:01.000Z',
    });
    insertMessage({
      id: 'incoming-keep',
      friendId: 'keep-unresponded',
      direction: 'incoming',
      content: '#相談',
      source: 'auto_reply_keep_unresponded',
      createdAt: '2026-07-23T09:02:00.000Z',
    });
    insertMessage({
      id: 'outgoing-keep',
      friendId: 'keep-unresponded',
      direction: 'outgoing',
      content: '担当者も確認します',
      source: 'auto_reply',
      deliveryType: 'reply',
      createdAt: '2026-07-23T09:02:01.000Z',
    });
    insertMessage({
      id: 'incoming-human',
      friendId: 'human-unanswered',
      direction: 'incoming',
      content: '人に相談したいです',
      source: 'user_unmatched',
      createdAt: '2026-07-23T09:03:00.000Z',
    });

    const result = await snapshot();
    const expectedIds = ['human-unanswered', 'keep-unresponded'];

    expect(sorted(result.list.data.rows.map((row) => row.friendId))).toEqual(expectedIds);
    expect(result.list.data.total).toBe(2);
    expect(result.count.data.total).toBe(2);
    expect(sorted(result.unansweredChats.data.map((row) => row.friendId))).toEqual(expectedIds);
    expect(sorted(result.conversations.data.items.map((row) => row.friendId))).toEqual(expectedIds);
    expect(result.conversations.data.total).toBe(2);
    expect(Object.fromEntries(result.chats.data.map((row) => [row.friendId, row.isUnanswered]))).toEqual({
      'auto-replied': false,
      'human-unanswered': true,
      'keep-unresponded': true,
    });
    expect(result.chats.data.find((row) => row.friendId === 'auto-replied')?.status).toBe('unread');

    const detailResponses = await Promise.all(
      ['auto-replied', 'keep-unresponded', 'human-unanswered']
        .map((friendId) => request(`/api/chats/${friendId}`)),
    );
    expect(detailResponses.map((response) => response.status)).toEqual([200, 200, 200]);
    const detailRows = await Promise.all(
      detailResponses.map((response) => response.json() as Promise<ChatDetailResponse>),
    );
    expect(Object.fromEntries(detailRows.map(({ data }) => [data.friendId, data.isUnanswered]))).toEqual({
      'auto-replied': false,
      'human-unanswered': true,
      'keep-unresponded': true,
    });
  });

  test('receive, auto reply, new human message, and manual reply stay aligned after each refetch', async () => {
    insertFriend('roundtrip', 'unread');
    insertMessage({
      id: 'incoming-1',
      friendId: 'roundtrip',
      direction: 'incoming',
      content: '#予約',
      source: 'user_unmatched',
      createdAt: '2026-07-23T10:00:00.000Z',
    });

    const expectState = async (isUnanswered: boolean) => {
      const result = await snapshot();
      expect(result.list.data.rows.some((row) => row.friendId === 'roundtrip')).toBe(isUnanswered);
      expect(result.count.data.total).toBe(isUnanswered ? 1 : 0);
      expect(result.chats.data.find((row) => row.friendId === 'roundtrip')?.isUnanswered)
        .toBe(isUnanswered);
      expect(result.unansweredChats.data.some((row) => row.friendId === 'roundtrip'))
        .toBe(isUnanswered);
      expect(result.conversations.data.items.some((row) => row.friendId === 'roundtrip'))
        .toBe(isUnanswered);
    };

    await expectState(true);

    raw.prepare(`UPDATE messages_log SET source = 'auto_reply_keyword' WHERE id = 'incoming-1'`).run();
    insertMessage({
      id: 'outgoing-auto',
      friendId: 'roundtrip',
      direction: 'outgoing',
      content: '予約をご案内します',
      source: 'auto_reply',
      deliveryType: 'reply',
      createdAt: '2026-07-23T10:00:01.000Z',
    });
    await expectState(false);

    insertMessage({
      id: 'incoming-2',
      friendId: 'roundtrip',
      direction: 'incoming',
      content: '担当者に相談です',
      source: 'user_unmatched',
      createdAt: '2026-07-23T10:01:00.000Z',
    });
    await expectState(true);

    insertMessage({
      id: 'outgoing-manual',
      friendId: 'roundtrip',
      direction: 'outgoing',
      content: '担当者が回答しました',
      source: 'manual',
      deliveryType: 'push',
      createdAt: '2026-07-23T10:02:00.000Z',
    });
    await expectState(false);
  });
});
