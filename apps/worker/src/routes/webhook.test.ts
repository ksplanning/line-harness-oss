import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
  // G28 応答時間帯: 既定は null (schedule 無し) → ゲート no-op で既存パス byte-identical。
  getEffectiveResponseSchedule: vi.fn().mockResolvedValue(null),
}));

vi.mock('@line-crm/shared', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/shared')>('@line-crm/shared');
  return { ...actual, isWithinBusinessHours: vi.fn() };
});

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/faq-reply.js', () => ({
  tryFaqReply: vi.fn(),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
}));

import { verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserId,
  getLineAccounts,
  getMessageTemplateById,
  getScenarioSteps,
  getScenarios,
  jstNow,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
  getEffectiveResponseSchedule,
} from '@line-crm/db';
import { isWithinBusinessHours } from '@line-crm/shared';
import { fireEvent } from '../services/event-bus.js';
import { tryFaqReply } from '../services/faq-reply.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLineAccounts).mockResolvedValue([]);
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      null,
    );
    expect(getScenarios).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // Keep the unrelated DB stubs quiet but type-checked as mocked imports.
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — FAQ bot flag gate', () => {
  function existingFriend() {
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'acc-1',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-02T00:00:00+09:00',
      updated_at: '2026-07-02T00:00:00+09:00',
    });
  }

  function makeStmt(autoReplies: Array<{
    id: string;
    keyword: string;
    match_type: 'exact' | 'contains';
    response_type: string;
    response_content: string;
    template_id: string | null;
    is_active: number;
    created_at: string;
  }> = []) {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: autoReplies }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  async function postTextWebhook(envOverrides: Record<string, unknown>, incomingText = '営業時間は？', autoReplies = []) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    existingFriend();
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-07-02T00:00:00+09:00',
      created_at: '2026-07-02T00:00:00+09:00',
      updated_at: '2026-07-02T00:00:00+09:00',
    });

    const stmt = makeStmt(autoReplies);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: incomingText },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db, ...envOverrides },
      executionCtx,
    );
    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;
    return { db };
  }

  test('flag OFF keeps text webhook path untouched and does not import/call FAQ reply', async () => {
    const { db } = await postTextWebhook({});

    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '営業時間は？', matched: false },
        replyToken: 'reply-token',
      },
      'env-default-token',
      null,
    );
  });

  test('auto-reply match prevents FAQ evaluation', async () => {
    await postTextWebhook(
      { FAQ_BOT_ENABLED: 'true' },
      '営業時間',
      [{
        id: 'auto-1',
        keyword: '営業時間',
        match_type: 'exact',
        response_type: 'silent',
        response_content: '',
        template_id: null,
        is_active: 1,
        created_at: '2026-07-02T00:00:00+09:00',
      }],
    );

    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('FAQ hit consumes reply token and keeps the chat out of unread inbox', async () => {
    vi.mocked(tryFaqReply).mockResolvedValue({ replied: true, handoff: false });

    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' });

    expect(tryFaqReply).toHaveBeenCalledWith(db, lineClientMocks, {
      friend: expect.objectContaining({ id: 'friend-1' }),
      incomingText: '営業時間は？',
      lineAccountId: null,
      replyToken: 'reply-token',
    });
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '営業時間は？', matched: true },
        replyToken: undefined,
      },
      'env-default-token',
      null,
    );
  });

  test('FAQ handoff consumes reply token but leaves the chat unread', async () => {
    vi.mocked(tryFaqReply).mockResolvedValue({ replied: false, handoff: true });

    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' });

    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '営業時間は？', matched: false },
        replyToken: undefined,
      },
      'env-default-token',
      null,
    );
  });

  const SILENT_RULE = [{
    id: 'auto-1',
    keyword: '営業時間',
    match_type: 'exact' as const,
    response_type: 'silent',
    response_content: '',
    template_id: null,
    is_active: 1,
    created_at: '2026-07-02T00:00:00+09:00',
  }];

  function schedule(overrides: Record<string, unknown>) {
    return {
      id: 's1',
      lineAccountId: 'acc-1',
      isEnabled: true,
      timezone: 'Asia/Tokyo',
      outsideHoursMode: 'auto_reply',
      awayMessage: null,
      weeklyHours: [],
      ...overrides,
    };
  }

  test('gate ON + within business hours → auto-reply/FAQ suppressed, chat unread, businessHoursSuppressed flag set', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({}) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(true);

    // 営業時間内: たとえマッチする auto-reply があってもオペレーター対応に回す。
    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' }, '営業時間', SILENT_RULE as never);

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '営業時間', matched: false, businessHoursSuppressed: true },
        replyToken: 'reply-token',
      },
      'env-default-token',
      null,
    );
  });

  test('gate ON + outside hours + away_message → sends the away text once (replyMessage 1), FAQ not run', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(
      schedule({ outsideHoursMode: 'away_message', awayMessage: 'ただいま営業時間外です' }) as never,
    );
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' });

    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '営業時間は？', matched: true },
        replyToken: undefined,
      },
      'env-default-token',
      null,
    );
  });

  test('gate ON + outside hours + auto_reply → the legacy auto-reply loop still fires (matched)', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({ outsideHoursMode: 'auto_reply' }) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    await postTextWebhook({}, '営業時間', SILENT_RULE as never);

    // silent ルールが matched → matched=true → 未読化されない = 従来ループが回った証跡。
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('gate ON + outside hours + none → chat unread and nothing sent', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({ outsideHoursMode: 'none' }) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' }, '営業時間', SILENT_RULE as never);

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('gate is_enabled=0 → time-independent legacy behavior (non-regression); business-hours not consulted', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(
      schedule({ isEnabled: false, outsideHoursMode: 'none' }) as never,
    );

    await postTextWebhook({}, '営業時間', SILENT_RULE as never);

    // schedule 無効 → 従来ループが時刻に関係なく発火 (silent matched → 未読化なし)。
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(isWithinBusinessHours).not.toHaveBeenCalled();
  });
});
