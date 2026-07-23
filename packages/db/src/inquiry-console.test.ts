import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import * as chatDb from './chats.js';
import * as staffDb from './staff.js';

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

type InquiryChat = {
  status: string;
  assigned_staff_id: string | null;
  read_at: string | null;
};

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      operator_id TEXT,
      status TEXT NOT NULL DEFAULT 'unread',
      notes TEXT,
      last_message_at TEXT,
      assigned_staff_id TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE staff_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      reply_signature_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO chats
      (id, friend_id, status, created_at, updated_at)
    VALUES
      ('chat-1', 'friend-1', 'unread', '2026-07-23T09:00:00.000+09:00',
       '2026-07-23T09:00:00.000+09:00');
    INSERT INTO staff_members
      (id, name, role, api_key, created_at, updated_at)
    VALUES
      ('staff-1', '佐藤', 'staff', 'key-1', '2026-07-23T09:00:00.000+09:00',
       '2026-07-23T09:00:00.000+09:00'),
      ('staff-2', '鈴木', 'staff', 'key-2', '2026-07-23T09:00:00.000+09:00',
       '2026-07-23T09:00:00.000+09:00');
  `);
  db = asD1(raw);
});

describe('inquiry console persistence', () => {
  test('first opener claims an unread chat and later openers cannot replace the assignee', async () => {
    expect(typeof (chatDb as Record<string, unknown>).claimChatForStaff).toBe('function');
    const claim = (chatDb as unknown as {
      claimChatForStaff: (
        db: D1Database,
        chatId: string,
        staffId: string,
        openedAt: string,
      ) => Promise<InquiryChat | null>;
    }).claimChatForStaff;
    if (!claim) return;

    const first = await claim(
      db,
      'chat-1',
      'staff-1',
      '2026-07-23T10:00:00.000+09:00',
    );
    expect(first).toMatchObject({
      status: 'in_progress',
      assigned_staff_id: 'staff-1',
      read_at: '2026-07-23T10:00:00.000+09:00',
    });

    const second = await claim(
      db,
      'chat-1',
      'staff-2',
      '2026-07-23T10:05:00.000+09:00',
    );
    expect(second).toMatchObject({
      status: 'in_progress',
      assigned_staff_id: 'staff-1',
      read_at: '2026-07-23T10:05:00.000+09:00',
    });
  });

  test('completion keeps the assignee for audit and records the final read boundary', async () => {
    expect(typeof (chatDb as Record<string, unknown>).claimChatForStaff).toBe('function');
    expect(typeof (chatDb as Record<string, unknown>).completeChat).toBe('function');
    const { claimChatForStaff, completeChat } = chatDb as unknown as {
      claimChatForStaff: (
        db: D1Database,
        chatId: string,
        staffId: string,
        openedAt: string,
      ) => Promise<InquiryChat | null>;
      completeChat: (
        db: D1Database,
        chatId: string,
        completedAt: string,
      ) => Promise<InquiryChat | null>;
    };
    if (!claimChatForStaff || !completeChat) return;

    await claimChatForStaff(
      db,
      'chat-1',
      'staff-1',
      '2026-07-23T10:00:00.000+09:00',
    );
    const completed = await completeChat(
      db,
      'chat-1',
      '2026-07-23T10:10:00.000+09:00',
    );
    expect(completed).toMatchObject({
      status: 'resolved',
      assigned_staff_id: 'staff-1',
      read_at: '2026-07-23T10:10:00.000+09:00',
    });
  });

  test('a new inquiry after completion returns to unread without the previous assignee', async () => {
    expect(typeof (chatDb as Record<string, unknown>).claimChatForStaff).toBe('function');
    expect(typeof (chatDb as Record<string, unknown>).completeChat).toBe('function');
    const { claimChatForStaff, completeChat, upsertChatOnMessage } = chatDb as unknown as {
      claimChatForStaff: (
        db: D1Database,
        chatId: string,
        staffId: string,
        openedAt: string,
      ) => Promise<InquiryChat | null>;
      completeChat: (
        db: D1Database,
        chatId: string,
        completedAt: string,
      ) => Promise<InquiryChat | null>;
      upsertChatOnMessage: (
        db: D1Database,
        friendId: string,
      ) => Promise<InquiryChat>;
    };
    if (!claimChatForStaff || !completeChat) return;

    await claimChatForStaff(db, 'chat-1', 'staff-1', '2026-07-23T10:00:00.000+09:00');
    await completeChat(db, 'chat-1', '2026-07-23T10:10:00.000+09:00');
    const reopened = await upsertChatOnMessage(db, 'friend-1');

    expect(reopened).toMatchObject({
      status: 'unread',
      assigned_staff_id: null,
      read_at: null,
    });
  });

  test('reply signature preference defaults on and can be turned off per staff member', async () => {
    expect(typeof (staffDb as Record<string, unknown>).setStaffReplySignatureEnabled)
      .toBe('function');
    const setEnabled = (staffDb as unknown as {
      setStaffReplySignatureEnabled: (
        db: D1Database,
        staffId: string,
        enabled: boolean,
      ) => Promise<{ reply_signature_enabled: number } | null>;
    }).setStaffReplySignatureEnabled;
    if (!setEnabled) return;

    expect(raw.prepare(
      `SELECT reply_signature_enabled FROM staff_members WHERE id = 'staff-1'`,
    ).get()).toEqual({ reply_signature_enabled: 1 });
    expect(await setEnabled(db, 'staff-1', false)).toMatchObject({
      reply_signature_enabled: 0,
    });
  });
});
