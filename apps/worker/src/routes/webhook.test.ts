import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

const staffNotificationMocks = vi.hoisted(() => ({
  dispatchStaffNotification: vi.fn(),
  tryLinkStaffLineFromWebhook: vi.fn(),
}));

const incomingImageMocks = vi.hoisted(() => ({
  fetchAndStoreIncomingImage: vi.fn(),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendById: vi.fn(),
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
  fireEvent: vi.fn().mockResolvedValue({
    automationMessageSent: true,
  }),
}));

vi.mock('../services/faq-reply.js', () => ({
  tryFaqReply: vi.fn(),
}));

vi.mock('../services/staff-notify/router.js', () => ({
  dispatchStaffNotification: staffNotificationMocks.dispatchStaffNotification,
}));

vi.mock('../services/staff-notify/line-link.js', () => ({
  tryLinkStaffLineFromWebhook: staffNotificationMocks.tryLinkStaffLineFromWebhook,
}));

vi.mock('../services/incoming-image.js', () => ({
  fetchAndStoreIncomingImage: incomingImageMocks.fetchAndStoreIncomingImage,
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
  resolveMetadata: vi.fn().mockResolvedValue({}),
  messageToLogPayload: vi.fn((message: { messageType: string; content: string }) => ({
    messageType: message.messageType,
    content: message.content,
  })),
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
  getFriendById,
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
import { buildMessage, expandVariables } from '../services/step-delivery.js';
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
  staffNotificationMocks.dispatchStaffNotification.mockResolvedValue([]);
  staffNotificationMocks.tryLinkStaffLineFromWebhook.mockResolvedValue({
    status: 'not_handled',
  });
  incomingImageMocks.fetchAndStoreIncomingImage.mockResolvedValue(null);
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

describe('POST /webhook — isolated staff LINE linkage and inquiry notifications', () => {
  function account() {
    vi.mocked(getLineAccounts).mockResolvedValue([{
      id: 'account-1',
      is_active: 1,
      channel_secret: 'env-default-secret',
      channel_access_token: 'account-token',
    }] as never);
  }

  function existingFriend() {
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-customer',
      display_name: '顧客兼スタッフ',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'account-1',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-23T10:00:00+09:00',
      updated_at: '2026-07-23T10:00:00+09:00',
    });
  }

  async function postEvent(
    event: Record<string, unknown>,
    options: {
      awaitProcessing?: boolean;
      env?: Record<string, unknown>;
    } = {},
  ) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    const statement = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    statement.bind.mockReturnValue(statement);
    const db = {
      prepare: vi.fn().mockReturnValue(statement),
    } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': 'A'.repeat(43) + '=',
      },
      body: JSON.stringify({
        destination: 'bot',
        events: [event],
      }),
    }, {
      ...baseEnv,
      DB: db,
      ADMIN_PUBLIC_URL: 'https://admin.example.test',
      ...options.env,
    }, executionCtx);
    expect(response.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    if (options.awaitProcessing !== false) await processing;
    return { db, processing };
  }

  test('valid linkage command is consumed before any friends or customer-message mutation', async () => {
    account();
    staffNotificationMocks.tryLinkStaffLineFromWebhook.mockResolvedValueOnce({
      status: 'linked',
    });

    const { db } = await postEvent({
      type: 'message',
      replyToken: 'reply-link',
      message: { type: 'text', id: 'message-link', text: '通知連携 ABCD2345' },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-customer' },
      webhookEventId: 'event-link',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    });

    expect(staffNotificationMocks.tryLinkStaffLineFromWebhook).toHaveBeenCalledWith(
      db,
      {
        lineAccountId: 'account-1',
        lineUserId: 'U-customer',
        text: '通知連携 ABCD2345',
      },
    );
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith(
      'reply-link',
      [{ type: 'text', text: expect.stringContaining('連携') }],
    );
    expect(getFriendByLineUserId).not.toHaveBeenCalled();
    expect(upsertFriend).not.toHaveBeenCalled();
    expect(db.prepare).not.toHaveBeenCalled();
    expect(fireEvent).not.toHaveBeenCalled();
    expect(staffNotificationMocks.dispatchStaffNotification).not.toHaveBeenCalled();
  });

  test('link lookup and notification failures fail open without losing the customer message', async () => {
    account();
    existingFriend();
    vi.mocked(upsertChatOnMessage).mockResolvedValue({ id: 'chat-1' } as never);
    staffNotificationMocks.tryLinkStaffLineFromWebhook.mockRejectedValueOnce(
      new Error('private lookup detail'),
    );
    staffNotificationMocks.dispatchStaffNotification.mockRejectedValueOnce(
      new Error('provider private detail'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { db } = await postEvent({
        type: 'message',
        replyToken: 'reply-customer',
        message: { type: 'text', id: 'message-customer', text: '問い合わせ本文' },
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U-customer' },
        webhookEventId: 'event-customer',
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      });

      expect(getFriendByLineUserId).toHaveBeenCalledWith(db, 'U-customer');
      expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
      expect(fireEvent).toHaveBeenCalledWith(
        db,
        'message_received',
        expect.objectContaining({ friendId: 'friend-1' }),
        'account-token',
        'account-1',
      );
      expect(staffNotificationMocks.dispatchStaffNotification).toHaveBeenCalledWith(
        expect.objectContaining({ DB: db }),
        {
          eventType: 'inquiry_received',
          lineAccountId: 'account-1',
          name: '顧客兼スタッフ',
          excerpt: '問い合わせ本文',
          deepLink: 'https://admin.example.test/chats?friend=friend-1',
        },
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain('private lookup detail');
      expect(JSON.stringify(error.mock.calls)).not.toContain('provider private detail');
    } finally {
      error.mockRestore();
    }
  });

  test('a slow staff provider does not delay the customer message event bus', async () => {
    account();
    existingFriend();
    vi.mocked(upsertChatOnMessage).mockResolvedValue({ id: 'chat-1' } as never);
    let releaseDispatch!: () => void;
    staffNotificationMocks.dispatchStaffNotification.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => {
        releaseDispatch = () => resolve([]);
      }),
    );

    const { db, processing } = await postEvent({
      type: 'message',
      replyToken: 'reply-customer',
      message: { type: 'text', id: 'message-customer', text: '問い合わせ本文' },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-customer' },
      webhookEventId: 'event-customer',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    }, { awaitProcessing: false });

    try {
      await vi.waitFor(() => {
        expect(fireEvent).toHaveBeenCalledWith(
          db,
          'message_received',
          expect.objectContaining({ friendId: 'friend-1' }),
          'account-token',
          'account-1',
        );
      }, { timeout: 100 });
    } finally {
      releaseDispatch();
      await processing;
    }
  });

  test('fans out a non-text inquiry with a bounded type label after storing it', async () => {
    account();
    existingFriend();

    const { db } = await postEvent({
      type: 'message',
      replyToken: 'reply-image',
      message: { type: 'image', id: 'message-image' },
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-customer' },
      webhookEventId: 'event-image',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    });

    expect(staffNotificationMocks.dispatchStaffNotification).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      {
        eventType: 'inquiry_received',
        lineAccountId: 'account-1',
        name: '顧客兼スタッフ',
        excerpt: '[画像]',
        deepLink: 'https://admin.example.test/chats?friend=friend-1',
      },
    );
  });

  test('falls back to the image label when image storage fails and still stores and notifies', async () => {
    account();
    existingFriend();
    incomingImageMocks.fetchAndStoreIncomingImage.mockRejectedValueOnce(
      new Error('private image storage failure'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { db } = await postEvent({
        type: 'message',
        replyToken: 'reply-image-fallback',
        message: { type: 'image', id: 'message-image-fallback' },
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U-customer' },
        webhookEventId: 'event-image-fallback',
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      }, {
        env: {
          IMAGES: {} as R2Bucket,
          WORKER_URL: 'https://worker.example.test',
        },
      });

      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO messages_log'),
      );
      expect(staffNotificationMocks.dispatchStaffNotification).toHaveBeenCalledWith(
        expect.objectContaining({ DB: db }),
        expect.objectContaining({
          eventType: 'inquiry_received',
          excerpt: '[画像]',
        }),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        '[staff-notify] incoming image storage failed; using type label',
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
        'private image storage failure',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('follow never depends on staff-link lookup and keeps the customer follow path', async () => {
    account();
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-customer',
      displayName: '顧客兼スタッフ',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-customer',
      display_name: '顧客兼スタッフ',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'account-1',
      metadata: '{}',
      first_tracked_link_id: null,
      ref_code: 'known-ref',
      created_at: '2026-07-23T10:00:00+09:00',
      updated_at: '2026-07-23T10:00:00+09:00',
    } as never);
    vi.mocked(getFriendById).mockResolvedValue({
      id: 'friend-1',
      ref_code: 'known-ref',
    } as never);
    vi.mocked(getEntryRouteByRefCode).mockResolvedValue(null);
    vi.mocked(getScenarios).mockResolvedValue([]);

    const { db } = await postEvent({
      type: 'follow',
      replyToken: 'reply-follow',
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U-customer' },
      webhookEventId: 'event-follow',
      deliveryContext: { isRedelivery: false },
      mode: 'active',
    });

    expect(staffNotificationMocks.tryLinkStaffLineFromWebhook).not.toHaveBeenCalled();
    expect(upsertFriend).toHaveBeenCalledWith(db, expect.objectContaining({
      lineUserId: 'U-customer',
    }));
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'friend_add',
      expect.objectContaining({ friendId: 'friend-1' }),
      'account-token',
      'account-1',
    );
  });
});

describe('POST /webhook — multi-bubble postback auto-reply', () => {
  async function postPostback(
    postback: { data: string; displayText?: string },
    rules: Array<Record<string, unknown>>,
  ) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-21T00:00:00+09:00',
      updated_at: '2026-07-21T00:00:00+09:00',
    });
    vi.mocked(expandVariables).mockImplementation((content) => content);
    vi.mocked(buildMessage).mockImplementation((messageType, content) => ({ messageType, content }) as never);
    const statement = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: rules }),
    };
    statement.bind.mockReturnValue(statement);
    const prepare = vi.fn().mockReturnValue(statement);
    const db = { prepare } as unknown as D1Database;
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
      body: JSON.stringify({
        destination: 'bot',
        events: [{
          type: 'postback',
          replyToken: 'postback-token',
          postback,
          timestamp: Date.now(),
          source: { type: 'user', userId: 'U-existing' },
          webhookEventId: 'event-postback',
          deliveryContext: { isRedelivery: false },
          mode: 'active',
        }],
      }),
    }, { ...baseEnv, DB: db }, executionCtx);
    expect(response.status).toBe(200);
    await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);
    return { db, prepare };
  }

  test('[c matched] exact postback data fires the rule and remains out of unread', async () => {
    const { prepare } = await postPostback({ data: 'plan=gold' }, [{
      id: 'postback-multi',
      keyword: 'plan=gold',
      match_type: 'exact',
      response_type: 'text',
      response_content: '旧先頭',
      response_messages: JSON.stringify([
        { messageType: 'text', messageContent: '申込を受け付けました' },
        { messageType: 'flex', messageContent: '{"type":"bubble"}' },
      ]),
      template_id: null,
      line_account_id: null,
      is_active: 1,
    }]);

    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('postback-token', [
      { messageType: 'text', content: '申込を受け付けました' },
      { messageType: 'flex', content: '{"type":"bubble"}' },
    ]);
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    const incomingSql = prepare.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) =>
        sql.includes('INSERT INTO messages_log')
        && sql.includes("'incoming', 'text'")
        && sql.includes("'postback'"),
      );
    expect(incomingSql).toContain("'postback'");
  });

  test('[c unmatched] displayText is not webhook match data and postback still never creates unread', async () => {
    await postPostback({ data: 'menu=pricing', displayText: '#料金' }, [{
      id: 'postback-display-only',
      keyword: '#料金',
      match_type: 'exact',
      response_type: 'text',
      response_content: '料金表です',
      response_messages: null,
      template_id: null,
      line_account_id: null,
      is_active: 1,
    }]);

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
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
    response_messages: string | null;
    template_id: string | null;
    keep_in_unresponded?: number;
    is_active: number;
    created_at: string;
  }> = [], autoReplyLoadError = false) {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: autoReplyLoadError
        ? vi.fn().mockRejectedValue(new Error('auto-reply query failed'))
        : vi.fn().mockResolvedValue({ results: autoReplies }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    return stmt;
  }

  async function postTextWebhook(
    envOverrides: Record<string, unknown>,
    incomingText = '営業時間は？',
    autoReplies: Parameters<typeof makeStmt>[0] = [],
    autoReplyLoadError = false,
    sourceUpdateError = false,
  ) {
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

    const stmt = makeStmt(autoReplies, autoReplyLoadError);
    const preparedStatements: Array<{ sql: string; statement: ReturnType<typeof makeStmt> }> = [];
    const prepare = vi.fn((sql: string) => {
      const statement = sql.includes('FROM auto_replies') ? stmt : makeStmt();
      if (sourceUpdateError && sql.includes('UPDATE messages_log SET source = ? WHERE id = ?')) {
        statement.run.mockRejectedValueOnce(new Error('source update failed'));
      }
      preparedStatements.push({ sql, statement });
      return statement;
    });
    const db = { prepare } as unknown as D1Database;
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
    const incomingStatement = preparedStatements.find(({ sql }) =>
      sql.includes('INSERT INTO messages_log') && sql.includes("'incoming', 'text'"),
    )?.statement;
    return { db, prepare, stmt, incomingStatement, preparedStatements };
  }

  test('[a] full-width hash and edge whitespace/newlines still classify an exact registered keyword', async () => {
    const { incomingStatement, prepare, preparedStatements } = await postTextWebhook({}, ' \n#予約\r\n', [{
      id: 'auto-normalized',
      keyword: '＃予約',
      match_type: 'exact',
      response_type: 'silent',
      response_content: '',
      response_messages: null,
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }]);

    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      ' \n#予約\r\n',
      'user_unmatched',
      expect.any(String),
    );
    expect(incomingStatement?.run).toHaveBeenCalledTimes(1);
    const handledUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(handledUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keyword',
      expect.any(String),
    );
    const preparedSql = prepare.mock.calls.map(([sql]) => String(sql));
    const ruleLookupIndex = preparedSql.findIndex((sql) => sql.includes('FROM auto_replies'));
    const incomingInsertIndex = preparedSql.findIndex((sql) =>
      sql.includes('INSERT INTO messages_log') && sql.includes("'incoming', 'text'"),
    );
    expect(ruleLookupIndex).toBeGreaterThanOrEqual(0);
    expect(incomingInsertIndex).toBeGreaterThan(ruleLookupIndex);
    expect(preparedSql[incomingInsertIndex]).toMatch(/NULL, NULL, \?, \?\)/);
  });

  test('[a negative] normalization never drops a meaningful hash from a different phrase', async () => {
    const { db, incomingStatement } = await postTextWebhook({}, '予約', [{
      id: 'auto-near-miss',
      keyword: '＃予約',
      match_type: 'exact',
      response_type: 'silent',
      response_content: '',
      response_messages: null,
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }]);

    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '予約',
      'user_unmatched',
      expect.any(String),
    );
  });

  test('[fail-closed] an auto-reply lookup error logs the future message and leaves it unread', async () => {
    const { db, incomingStatement } = await postTextWebhook({}, '#予約', [], true);

    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '#予約',
      'user_unmatched',
      expect.any(String),
    );
    expect(incomingStatement?.run).toHaveBeenCalledTimes(1);
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('[fail-closed] a response-schedule lookup error logs the message and leaves it unread', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockRejectedValueOnce(new Error('schedule query failed'));

    const { db, incomingStatement } = await postTextWebhook({}, '営業時間', [{
      id: 'auto-schedule-error',
      keyword: '営業時間',
      match_type: 'exact',
      response_type: 'text',
      response_content: '10時からです',
      response_messages: null,
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }]);

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '営業時間',
      'user_unmatched',
      expect.any(String),
    );
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('[b] an account-mismatched rule stays outside the candidate query and the message stays unread', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([{
      id: 'acc-1',
      is_active: 1,
      channel_secret: 'env-default-secret',
      channel_access_token: 'acc-1-token',
    }] as never);

    // Empty results model a rule scoped to another account after SQL filtering.
    const { db, prepare, stmt } = await postTextWebhook({}, '#予約', []);
    const autoReplySql = prepare.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM auto_replies'));

    expect(autoReplySql).toMatch(/WHERE is_active = 1/);
    expect(autoReplySql).toMatch(/line_account_id IS NULL OR line_account_id = \?/);
    expect(stmt.bind).toHaveBeenCalledWith('acc-1');
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('[account scope] an env-signed webhook without a registered main account stays global and fail-closed', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([]);

    const { db, prepare, stmt, incomingStatement, preparedStatements } = await postTextWebhook(
      {},
      '#scoped-only',
      [],
    );
    const autoReplySql = prepare.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM auto_replies'));

    expect(autoReplySql).toMatch(/line_account_id IS NULL ORDER BY/);
    expect(autoReplySql).not.toMatch(/line_account_id = \?/);
    expect(stmt.bind).not.toHaveBeenCalled();
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '#scoped-only',
      'user_unmatched',
      expect.any(String),
    );
    expect(preparedStatements.some(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    )).toBe(false);
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '#scoped-only', matched: false },
        replyToken: 'reply-token',
      },
      'env-default-token',
      null,
    );
  });

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
        response_messages: null,
        template_id: null,
        is_active: 1,
        created_at: '2026-07-02T00:00:00+09:00',
      }],
    );

    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('a matched rule sends its ordered response_messages in one LINE reply call', async () => {
    vi.mocked(expandVariables).mockImplementation((content) => `展開:${content}`);
    vi.mocked(buildMessage).mockImplementation((messageType, content) => ({ messageType, content }) as never);

    const { incomingStatement, preparedStatements } = await postTextWebhook({}, '資料', [{
      id: 'auto-multi',
      keyword: '資料',
      match_type: 'exact',
      response_type: 'text',
      response_content: '旧先頭',
      response_messages: JSON.stringify([
        { messageType: 'text', messageContent: 'A' },
        { messageType: 'flex', messageContent: '{"type":"bubble"}' },
        { messageType: 'text', messageContent: 'B' },
      ]),
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }]);

    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-token', [
      { messageType: 'text', content: '展開:A' },
      { messageType: 'flex', content: '展開:{"type":"bubble"}' },
      { messageType: 'text', content: '展開:B' },
    ]);
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '資料',
      'user_unmatched',
      expect.any(String),
    );
    const sourceUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(sourceUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keyword',
      expect.any(String),
    );
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('keepInUnresponded rule still suppresses unread but persists a dedicated unanswered marker after send success', async () => {
    vi.mocked(expandVariables).mockImplementation((content) => content);
    vi.mocked(buildMessage).mockImplementation((messageType, content) => ({ messageType, content }) as never);

    const { preparedStatements } = await postTextWebhook({}, '#問い合わせ', [{
      id: 'auto-human-handoff',
      keyword: '#問い合わせ',
      match_type: 'exact',
      response_type: 'text',
      response_content: '担当者が確認します',
      response_messages: null,
      template_id: null,
      keep_in_unresponded: 1,
      is_active: 1,
      created_at: '2026-07-22T00:00:00+09:00',
    }]);

    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    const sourceUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(sourceUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keep_unresponded',
      expect.any(String),
    );
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('silent rule finalizes its handled marker only after a matching automation message is delivered', async () => {
    vi.mocked(fireEvent).mockResolvedValueOnce({
      automationMessageSent: true,
    });

    const { incomingStatement, preparedStatements } = await postTextWebhook({}, '#自動処理', [{
      id: 'auto-automation-success',
      keyword: '#自動処理',
      match_type: 'exact',
      response_type: 'silent',
      response_content: '',
      response_messages: null,
      template_id: null,
      keep_in_unresponded: 0,
      is_active: 1,
      created_at: '2026-07-22T00:00:00+09:00',
    }]);

    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '#自動処理',
      'user_unmatched',
      expect.any(String),
    );
    const sourceUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(sourceUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keyword',
      expect.any(String),
    );
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('silent rule without a sending automation still finalizes its handled marker and suppresses unread', async () => {
    vi.mocked(fireEvent).mockResolvedValueOnce({
      automationMessageSent: false,
    });

    const { incomingStatement, preparedStatements } = await postTextWebhook({}, '#案内のみ', [{
      id: 'auto-silent-only',
      keyword: '#案内のみ',
      match_type: 'exact',
      response_type: 'silent',
      response_content: '',
      response_messages: null,
      template_id: null,
      keep_in_unresponded: 0,
      is_active: 1,
      created_at: '2026-07-22T00:00:00+09:00',
    }]);

    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '#案内のみ',
      'user_unmatched',
      expect.any(String),
    );
    const sourceUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(sourceUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keyword',
      expect.any(String),
    );
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('silent rule automation dead-letter remains handled because no reply is the rule result', async () => {
    vi.mocked(fireEvent).mockResolvedValueOnce({
      automationMessageSent: false,
    });

    const { incomingStatement, preparedStatements } = await postTextWebhook({}, '#自動処理', [{
      id: 'auto-automation-dead-letter',
      keyword: '#自動処理',
      match_type: 'exact',
      response_type: 'silent',
      response_content: '',
      response_messages: null,
      template_id: null,
      keep_in_unresponded: 1,
      is_active: 1,
      created_at: '2026-07-22T00:00:00+09:00',
    }]);

    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '#自動処理',
      'user_unmatched',
      expect.any(String),
    );
    const sourceUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(sourceUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keep_unresponded',
      expect.any(String),
    );
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('[fail-closed] a sent reply with an unpersisted handled marker remains unread', async () => {
    vi.mocked(expandVariables).mockImplementation((content) => content);
    vi.mocked(buildMessage).mockImplementation((messageType, content) => ({ messageType, content }) as never);

    const { db, incomingStatement } = await postTextWebhook({}, '資料', [{
      id: 'auto-marker-error',
      keyword: '資料',
      match_type: 'exact',
      response_type: 'text',
      response_content: '資料を送ります',
      response_messages: null,
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }], false, true);

    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '資料',
      'user_unmatched',
      expect.any(String),
    );
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('a legacy matched rule still sends exactly its original single response', async () => {
    vi.mocked(expandVariables).mockImplementation((content) => content);
    vi.mocked(buildMessage).mockImplementation((messageType, content) => ({ messageType, content }) as never);

    await postTextWebhook({}, '営業時間', [{
      id: 'auto-legacy',
      keyword: '営業時間',
      match_type: 'exact',
      response_type: 'text',
      response_content: '10時からです',
      response_messages: null,
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }]);

    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-token', [
      { messageType: 'text', content: '10時からです' },
    ]);
  });

  test('malformed non-null response_messages never falls back and leaves the message unread', async () => {
    vi.mocked(expandVariables).mockImplementation((content) => content);
    vi.mocked(buildMessage).mockImplementation((messageType, content) => ({ messageType, content }) as never);

    const { db, incomingStatement } = await postTextWebhook({}, '壊れた設定', [{
      id: 'auto-broken',
      keyword: '壊れた設定',
      match_type: 'exact',
      response_type: 'text',
      response_content: 'この旧本文へ黙って戻してはいけない',
      response_messages: '{broken',
      template_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    }]);

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '壊れた設定',
      'user_unmatched',
      expect.any(String),
    );
  });

  test('FAQ hit consumes reply token and keeps the chat out of unread inbox', async () => {
    vi.mocked(tryFaqReply).mockResolvedValue({ replied: true, handoff: false });

    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' });

    // 第 4 引数 = faqAiRuntime。baseEnv に AI binding が無い → createFaqAiRuntime()=null
    // (dark-ship default)。Phase B B-1 で additive に渡す (gate 行 L722 は byte-identical)。
    expect(tryFaqReply).toHaveBeenCalledWith(db, lineClientMocks, {
      friend: expect.objectContaining({ id: 'friend-1' }),
      incomingText: '営業時間は？',
      lineAccountId: null,
      replyToken: 'reply-token',
    }, null);
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
    response_messages: null,
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

  test('[e] gate ON + within business hours leaves a suppressed registered-keyword reply unread', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({}) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(true);

    // 営業時間内: 固定キーワードでも返信が出ないため、オペレーター対応へ fail-closed する。
    const { db, incomingStatement } = await postTextWebhook(
      { FAQ_BOT_ENABLED: 'true' },
      '営業時間',
      [{
        ...SILENT_RULE[0],
        response_type: 'text',
        response_content: '10時からです',
      }] as never,
    );

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '営業時間',
      'user_unmatched',
      expect.any(String),
    );
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

    const { db, preparedStatements } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' });

    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    const handledUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(handledUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_handled',
      expect.any(String),
    );
    expect(handledUpdate?.statement.run).toHaveBeenCalledTimes(1);
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

  test('away_message success preserves a matching rule opt-in while suppressing unread', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(
      schedule({ outsideHoursMode: 'away_message', awayMessage: 'ただいま営業時間外です' }) as never,
    );
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    const { preparedStatements } = await postTextWebhook({}, '営業時間', [{
      ...SILENT_RULE[0],
      response_type: 'text',
      response_content: '10時からです',
      keep_in_unresponded: 1,
    }] as never);

    const handledUpdate = preparedStatements.find(({ sql }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?'),
    );
    expect(handledUpdate?.statement.bind).toHaveBeenCalledWith(
      'auto_reply_keep_unresponded',
      expect.any(String),
    );
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('gate ON + outside hours + auto_reply → the legacy auto-reply loop still fires (matched)', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({ outsideHoursMode: 'auto_reply' }) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    await postTextWebhook({}, '営業時間', SILENT_RULE as never);

    // silent ルールが matched → matched=true → 未読化されない = 従来ループが回った証跡。
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('[e] gate ON + outside hours + none sends nothing and leaves a registered keyword unread', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({ outsideHoursMode: 'none' }) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    const { db, incomingStatement } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' }, '営業時間', SILENT_RULE as never);

    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(tryFaqReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(incomingStatement?.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      '営業時間',
      'user_unmatched',
      expect.any(String),
    );
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      {
        friendId: 'friend-1',
        eventData: { text: '営業時間', matched: false },
        replyToken: 'reply-token',
      },
      'env-default-token',
      null,
    );
  });

  test('[e negative] gate ON + outside hours + none keeps an unrelated message unread', async () => {
    vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(schedule({ outsideHoursMode: 'none' }) as never);
    vi.mocked(isWithinBusinessHours).mockReturnValue(false);

    const { db } = await postTextWebhook({ FAQ_BOT_ENABLED: 'true' }, '通常の相談です', SILENT_RULE as never);

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

describe('POST /webhook — G28 gate on the cross-account 体験 trigger (reviewer R1)', () => {
  // user_id + otherFriends を返す db (cross-account トリガーが実際に送信できる状態)。
  function crossAccountDb(
    executed: Array<{ sql: string; binds: unknown[] }>,
    autoReplies: Array<Record<string, unknown>>,
    failHandledUpdate: boolean,
  ): D1Database {
    return {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const api = {
          bind(...values: unknown[]) {
            binds = values;
            return api;
          },
          async first() {
            if (/SELECT user_id FROM friends WHERE id/.test(sql)) return { user_id: 'U1' };
            return null;
          },
          async all() {
            if (/FROM auto_replies/.test(sql)) return { results: autoReplies };
            if (/la\.channel_access_token/.test(sql)) {
              return { results: [{ line_user_id: 'U2', channel_access_token: 'tok2' }] };
            }
            return { results: [] };
          },
          async run() {
            executed.push({ sql, binds });
            if (failHandledUpdate && /UPDATE messages_log SET source/.test(sql)) {
              throw new Error('marker update failed');
            }
            return {};
          },
        };
        return api;
      },
    } as unknown as D1Database;
  }

  async function postExperience(
    scheduleOverride: unknown,
    within: boolean,
    options: { autoReplies?: Array<Record<string, unknown>>; failHandledUpdate?: boolean } = {},
  ) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    // fast path で matchedAccountId='acc-1' を bind させ lineAccountId を truthy にする
    // (baseEnv.LINE_CHANNEL_SECRET='env-default-secret' と channel_secret を一致させる)。
    vi.mocked(getLineAccounts).mockResolvedValue([
      {
        id: 'acc-1',
        is_active: 1,
        channel_secret: 'env-default-secret',
        channel_access_token: 'tok-main',
      },
    ] as never);
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: 'U1',
      line_account_id: 'acc-1',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-02T00:00:00+09:00',
      updated_at: '2026-07-02T00:00:00+09:00',
    });
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
    if (scheduleOverride instanceof Error) {
      vi.mocked(getEffectiveResponseSchedule).mockRejectedValueOnce(scheduleOverride);
    } else {
      vi.mocked(getEffectiveResponseSchedule).mockResolvedValue(scheduleOverride as never);
    }
    vi.mocked(isWithinBusinessHours).mockReturnValue(within);

    const executed: Array<{ sql: string; binds: unknown[] }> = [];
    const db = crossAccountDb(
      executed,
      options.autoReplies ?? [],
      options.failHandledUpdate ?? false,
    );
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const res = await setupApp().request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: '体験を完了する' },
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
    return { db, executed };
  }

  const enabled = {
    id: 's1',
    lineAccountId: 'acc-1',
    isEnabled: true,
    timezone: 'Asia/Tokyo',
    outsideHoursMode: 'auto_reply',
    awayMessage: null,
    weeklyHours: [],
  };

  test('within business hours → cross-account trigger is suppressed and chat goes to unread', async () => {
    const { db } = await postExperience(enabled, true);
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled(); // 別アカウントへ送らない
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled(); // 確認返信もしない
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1'); // オペレーター対応 (未読)
  });

  test('a response-schedule lookup error suppresses cross-account delivery and leaves the chat unread', async () => {
    const { db } = await postExperience(new Error('schedule query failed'), false);
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).not.toHaveBeenCalled();
  });

  test.each(['none', 'away_message'] as const)(
    'outside hours + %s → cross-account trigger keeps its pre-change delivery behavior',
    async (outsideHoursMode) => {
      const { executed } = await postExperience({ ...enabled, outsideHoursMode }, false);
      expect(lineClientMocks.pushMessage).toHaveBeenCalledTimes(1);
      expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
      expect(upsertChatOnMessage).not.toHaveBeenCalled();
      expect(executed.some(({ sql, binds }) =>
        sql.includes('UPDATE messages_log SET source = ? WHERE id = ?')
        && binds[0] === 'auto_reply_handled',
      )).toBe(true);
    },
  );

  test('gate disabled → cross-account trigger fires as before (non-regression)', async () => {
    const { executed } = await postExperience({ ...enabled, isEnabled: false }, false);
    expect(lineClientMocks.pushMessage).toHaveBeenCalledTimes(1); // 別アカウントへ push
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1); // 確認返信
    expect(upsertChatOnMessage).not.toHaveBeenCalled(); // trigger 内で return
    expect(executed.some(({ sql, binds }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?')
      && binds[0] === 'auto_reply_handled',
    )).toBe(true);
  });

  test('an unmatched built-in trigger stays unread if its handled marker cannot be persisted', async () => {
    const { db, executed } = await postExperience(
      { ...enabled, isEnabled: false },
      false,
      { failHandledUpdate: true },
    );

    expect(executed.some(({ sql }) => sql.includes('UPDATE messages_log SET source'))).toBe(true);
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('a matched registered keyword stays unread if the built-in success marker cannot be persisted', async () => {
    const { executed } = await postExperience(
      { ...enabled, isEnabled: false },
      false,
      {
        failHandledUpdate: true,
        autoReplies: [{
          id: 'trigger-rule',
          keyword: '体験を完了する',
          match_type: 'exact',
          response_type: 'silent',
          response_content: '',
          response_messages: null,
          template_id: null,
          line_account_id: 'acc-1',
          is_active: 1,
          created_at: '2026-07-21T00:00:00+09:00',
        }],
      },
    );

    expect(executed.some(({ sql }) => sql.includes('UPDATE messages_log SET source'))).toBe(true);
    expect(upsertChatOnMessage).toHaveBeenCalled();
  });

  test('a successful built-in keyword action preserves the matching rule opt-in', async () => {
    const { executed } = await postExperience(
      { ...enabled, isEnabled: false },
      false,
      {
        autoReplies: [{
          id: 'trigger-rule',
          keyword: '体験を完了する',
          match_type: 'exact',
          response_type: 'silent',
          response_content: '',
          response_messages: null,
          template_id: null,
          line_account_id: 'acc-1',
          keep_in_unresponded: 1,
          is_active: 1,
          created_at: '2026-07-21T00:00:00+09:00',
        }],
      },
    );

    expect(executed.some(({ sql, binds }) =>
      sql.includes('UPDATE messages_log SET source = ? WHERE id = ?')
      && binds[0] === 'auto_reply_keep_unresponded',
    )).toBe(true);
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });
});
