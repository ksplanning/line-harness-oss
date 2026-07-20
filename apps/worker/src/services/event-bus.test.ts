import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from './event-bus.js';

interface CapturedInsert {
  sql: string;
  binds: unknown[];
}

function fakeDb(opts: {
  friend?: { line_user_id: string; display_name?: string | null; user_id?: string | null; metadata?: string };
  capturedInserts: CapturedInsert[];
  capturedAssignmentDeletes?: unknown[][];
}): D1Database {
  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          boundArgs = args;
          if (sql.includes('INSERT INTO messages_log')) {
            opts.capturedInserts.push({ sql, binds: args });
          }
          return this;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM friends WHERE id')) {
            return (opts.friend ?? null) as T | null;
          }
          return null;
        },
        async run(): Promise<{ success: true }> {
          if (sql.includes('DELETE FROM rich_menu_friend_assignments')) {
            opts.capturedAssignmentDeletes?.push(boundArgs);
          }
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
}

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return {
    ...actual,
    getActiveOutgoingWebhooksByEvent: vi.fn().mockResolvedValue([]),
    applyScoring: vi.fn().mockResolvedValue(undefined),
    getActiveAutomationsByEvent: vi.fn(),
    createAutomationLog: vi.fn().mockResolvedValue(undefined),
    getActiveNotificationRulesByEvent: vi.fn().mockResolvedValue([]),
    createNotification: vi.fn().mockResolvedValue(undefined),
    addTagToFriend: vi.fn().mockResolvedValue(undefined),
    removeTagFromFriend: vi.fn().mockResolvedValue(undefined),
    enrollFriendInScenario: vi.fn().mockResolvedValue(undefined),
    jstNow: () => '2026-05-08T00:00:00.000+09:00',
    getFriendScore: vi.fn().mockResolvedValue(0),
    getTemplateById: vi.fn().mockResolvedValue(null),
  };
});

const linkRichMenuToUser = vi.fn().mockResolvedValue(undefined);
const unlinkRichMenuFromUser = vi.fn().mockResolvedValue(undefined);
const lineMessageMocks = vi.hoisted(() => ({
  replyMessage: vi.fn().mockResolvedValue(undefined),
  pushMessage: vi.fn().mockResolvedValue(undefined),
}));
const personalizationMocks = vi.hoisted(() => ({
  renderFriendMessageContent: vi.fn(async (content: string) => content),
}));

vi.mock('@line-crm/line-sdk', () => {
  return {
    LineClient: vi.fn().mockImplementation(() => ({
      replyMessage: lineMessageMocks.replyMessage,
      pushMessage: lineMessageMocks.pushMessage,
      linkRichMenuToUser,
      unlinkRichMenuFromUser,
    })),
  };
});

vi.mock('./render-message.js', () => personalizationMocks);

vi.mock('./ad-conversion.js', () => ({
  sendAdConversions: vi.fn().mockResolvedValue(undefined),
}));

describe('fireEvent — send_message action logging', () => {
  let captured: CapturedInsert[];

  beforeEach(async () => {
    captured = [];
    personalizationMocks.renderFriendMessageContent.mockImplementation(async (content: string) => content);
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-1',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({ keyword: 'コスト比較' }),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              messageType: 'flex',
              content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"hi"}]}}',
              altText: 'hi',
            },
          },
        ]),
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('logs flex outgoing message to messages_log when send_message fires via reply', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
        replyToken: 'reply-token-xyz',
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    const insert = captured[0];
    expect(insert.sql).toContain('INSERT INTO messages_log');
    // bind order: id, friendId, messageType, content, deliveryType, source, lineAccountId, createdAt
    expect(insert.binds[1]).toBe('friend-1');
    expect(insert.binds[2]).toBe('flex');
    expect(insert.binds[4]).toBe('reply');
    expect(insert.binds[5]).toBe('automation');
    expect(insert.binds[6]).toBe('acc-1');
  });

  it('logs delivery_type=push when no replyToken provided', async () => {
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'コスト比較', matched: true },
      },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[4]).toBe('push');
  });

  it('logs even when text message (not flex) is sent', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-2',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: { messageType: 'text', content: 'hello {{display_name}} 😊' },
          },
        ]),
      },
    ]);
    personalizationMocks.renderFriendMessageContent.mockResolvedValueOnce('hello 山田花子 😊');

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test', display_name: '山田花子', user_id: null, metadata: '{}' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'tag_added',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[2]).toBe('text');
    expect(captured[0].binds[3]).toBe('hello 山田花子 😊');
    expect(captured[0].binds[6]).toBe(null);
    expect(personalizationMocks.renderFriendMessageContent).toHaveBeenCalledWith(
      'hello {{display_name}} 😊',
      null,
      dbFake,
      expect.objectContaining({ line_user_id: 'U_test', display_name: '山田花子' }),
    );
    expect(lineMessageMocks.pushMessage).toHaveBeenCalledWith('U_test', [{
      type: 'text',
      text: 'hello 山田花子 😊',
    }]);
  });

  it('resolves params.template_id via templates table when set', async () => {
    const db = await import('@line-crm/db');
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-tpl',
        line_account_id: null,
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          {
            type: 'send_message',
            params: {
              template_id: 'tpl-1',
              // content / messageType を空にして template 経由 resolve を強制
            },
          },
        ]),
      },
    ]);
    (db.getTemplateById as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      id: 'tpl-1',
      name: 'test-tpl',
      category: 'general',
      message_type: 'flex',
      message_content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"from-template"}]}}',
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const dbFake = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: captured,
    });
    await fireEvent(
      dbFake,
      'manual_test',
      { friendId: 'friend-1', eventData: {} },
      'channel-token',
      null,
    );

    expect(captured).toHaveLength(1);
    // log には template から取得した messageType / content が記録される
    expect(captured[0].binds[2]).toBe('flex');
    expect(String(captured[0].binds[3])).toContain('from-template');
  });
});

describe('fireEvent — G28 businessHoursSuppressed gate (HIGH-1)', () => {
  let captured: CapturedInsert[];

  beforeEach(async () => {
    captured = [];
    const db = await import('@line-crm/db');
    // add_tag (非送信) + send_message (送信) の混在 automation。
    (db.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: 'auto-mixed',
        line_account_id: 'acc-1',
        conditions: JSON.stringify({}),
        actions: JSON.stringify([
          { type: 'add_tag', params: { tagId: 'tag-x' } },
          { type: 'send_message', params: { messageType: 'text', content: 'auto reply body' } },
        ]),
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('suppresses send_message but still runs non-send actions when businessHoursSuppressed', async () => {
    const db = await import('@line-crm/db');
    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: captured });

    await fireEvent(
      dbFake,
      'message_received',
      { friendId: 'friend-1', eventData: { text: 'hi', matched: false, businessHoursSuppressed: true }, replyToken: 'reply-token' },
      'channel-token',
      'acc-1',
    );

    // 送信抑止 = messages_log への outgoing INSERT なし。
    expect(captured).toHaveLength(0);
    // 非送信 action (add_tag) は通す。
    expect(db.addTagToFriend).toHaveBeenCalledWith(dbFake, 'friend-1', 'tag-x');
  });

  it('runs send_message normally when businessHoursSuppressed is absent (non-regression)', async () => {
    const dbFake = fakeDb({ friend: { line_user_id: 'U_test' }, capturedInserts: captured });

    await fireEvent(
      dbFake,
      'message_received',
      { friendId: 'friend-1', eventData: { text: 'hi', matched: false }, replyToken: 'reply-token' },
      'channel-token',
      'acc-1',
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].binds[5]).toBe('automation');
  });
});

describe('fireEvent — rich menu assignment cache consistency', () => {
  beforeEach(() => {
    linkRichMenuToUser.mockClear();
    unlinkRichMenuFromUser.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['switch_rich_menu', { richMenuId: 'menu-auto' }, linkRichMenuToUser],
    ['remove_rich_menu', {}, unlinkRichMenuFromUser],
  ])('forgets the conditional cache after %s succeeds', async (type, params, lineCall) => {
    const dbModule = await import('@line-crm/db');
    (dbModule.getActiveAutomationsByEvent as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue([
      {
        id: `auto-${type}`,
        line_account_id: 'acc-1',
        conditions: JSON.stringify({}),
        actions: JSON.stringify([{ type, params }]),
      },
    ]);
    const deletes: unknown[][] = [];
    const db = fakeDb({
      friend: { line_user_id: 'U_test' },
      capturedInserts: [],
      capturedAssignmentDeletes: deletes,
    });

    await fireEvent(db, 'manual_test', { friendId: 'friend-1', eventData: {} }, 'channel-token', 'acc-1');

    expect(lineCall).toHaveBeenCalledTimes(1);
    expect(deletes).toEqual([['friend-1']]);
  });
});
