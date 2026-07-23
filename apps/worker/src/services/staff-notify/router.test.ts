import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { StaffNotificationDestination } from '@line-crm/db';
import type { StaffNotificationAdapterRegistry } from './types.js';

const dbMocks = vi.hoisted(() => ({
  getLineAccountById: vi.fn(),
  listSubscribedStaffNotificationDestinations: vi.fn(),
  recordStaffNotificationDelivery: vi.fn(),
}));
vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return { ...actual, ...dbMocks };
});

import {
  dispatchStaffNotifications,
  sendStaffNotificationTest,
} from './router.js';

const DB = {} as D1Database;
const env = { DB };
const payload = {
  eventType: 'inquiry_received' as const,
  lineAccountId: 'account-1',
  name: '山田花子',
  excerpt: '予約について相談したいです',
  deepLink: 'https://admin.example.test/chats/friend-1',
};

function destination(
  id: string,
  channelType: 'line' | 'chatwork',
  overrides: Partial<StaffNotificationDestination> = {},
): StaffNotificationDestination {
  return {
    id,
    lineAccountId: 'account-1',
    label: id,
    channelType,
    config: channelType === 'chatwork'
      ? { roomId: '123456', apiToken: 'token' }
      : {},
    notifyInquiry: true,
    notifyFormSubmission: true,
    enabled: true,
    lineUserId: channelType === 'line' ? 'U_STAFF' : null,
    lineLinkCodeDigest: null,
    lineLinkCodeExpiresAt: null,
    lineLinkedAt: channelType === 'line' ? '2026-07-23T00:00:00+09:00' : null,
    createdAt: '2026-07-23T00:00:00+09:00',
    updatedAt: '2026-07-23T00:00:00+09:00',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.recordStaffNotificationDelivery.mockResolvedValue(undefined);
});

describe('dispatchStaffNotifications', () => {
  test('fans out to every subscribed enabled destination and records fixed success/failure results', async () => {
    const line = destination('line-1', 'line');
    const chatwork = destination('chatwork-1', 'chatwork');
    const disabled = destination('disabled', 'line', { enabled: false });
    const unsubscribed = destination('unsubscribed', 'chatwork', { notifyInquiry: false });
    dbMocks.listSubscribedStaffNotificationDestinations.mockResolvedValue([
      line,
      chatwork,
      disabled,
      unsubscribed,
    ]);

    const lineSend = vi.fn(async () => ({ ok: false as const, errorCode: 'line_push_failed' as const }));
    const chatworkSend = vi.fn(async () => ({ ok: true as const }));
    const adapters: StaffNotificationAdapterRegistry = {
      line: {
        channelType: 'line',
        failureCodes: ['line_push_failed'],
        send: lineSend,
      },
      chatwork: { channelType: 'chatwork', failureCodes: [], send: chatworkSend },
    };

    await expect(dispatchStaffNotifications(env, payload, adapters)).resolves.toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { destinationId: 'line-1', status: 'failed', errorCode: 'line_push_failed' },
        { destinationId: 'chatwork-1', status: 'success', errorCode: null },
      ],
    });

    expect(dbMocks.listSubscribedStaffNotificationDestinations)
      .toHaveBeenCalledWith(DB, 'account-1', 'inquiry_received');
    expect(lineSend).toHaveBeenCalledTimes(1);
    expect(chatworkSend).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordStaffNotificationDelivery).toHaveBeenCalledTimes(2);
    expect(dbMocks.recordStaffNotificationDelivery).toHaveBeenCalledWith(DB, {
      id: expect.any(String),
      destinationId: 'line-1',
      eventType: 'inquiry_received',
      status: 'failed',
      errorCode: 'line_push_failed',
    });
    expect(dbMocks.recordStaffNotificationDelivery).toHaveBeenCalledWith(DB, {
      id: expect.any(String),
      destinationId: 'chatwork-1',
      eventType: 'inquiry_received',
      status: 'success',
      errorCode: null,
    });
  });

  test('continues fan-out when an adapter throws and never logs the thrown text or notification PII', async () => {
    dbMocks.listSubscribedStaffNotificationDestinations.mockResolvedValue([
      destination('line-1', 'line'),
      destination('chatwork-1', 'chatwork'),
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const chatworkSend = vi.fn(async () => ({ ok: true as const }));
    const adapters: StaffNotificationAdapterRegistry = {
      line: {
        channelType: 'line',
        failureCodes: [],
        send: vi.fn(async () => {
          throw new Error('line-token 山田花子 予約について相談したいです');
        }),
      },
      chatwork: { channelType: 'chatwork', failureCodes: [], send: chatworkSend },
    };

    const result = await dispatchStaffNotifications(env, payload, adapters);

    expect(result).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
    expect(result.results[0]).toEqual({
      destinationId: 'line-1',
      status: 'failed',
      errorCode: 'adapter_unexpected_error',
    });
    expect(chatworkSend).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify(errorSpy.mock.calls);
    expect(logs).not.toContain('line-token');
    expect(logs).not.toContain('山田花子');
    expect(logs).not.toContain('予約について');
  });

  test('normalizes an unsafe adapter error code before returning or persisting it', async () => {
    dbMocks.listSubscribedStaffNotificationDestinations.mockResolvedValue([
      destination('chatwork-unsafe', 'chatwork'),
    ]);
    const adapters: StaffNotificationAdapterRegistry = {
      chatwork: {
        channelType: 'chatwork',
        failureCodes: [],
        send: vi.fn(async () => ({
          ok: false as const,
          errorCode: 'secrettokenvalue',
        })),
      },
    };

    await expect(dispatchStaffNotifications(env, payload, adapters)).resolves
      .toMatchObject({
        results: [{
          destinationId: 'chatwork-unsafe',
          status: 'failed',
          errorCode: 'adapter_unexpected_error',
        }],
      });
    expect(dbMocks.recordStaffNotificationDelivery).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ errorCode: 'adapter_unexpected_error' }),
    );
    expect(JSON.stringify(dbMocks.recordStaffNotificationDelivery.mock.calls))
      .not.toContain('secrettokenvalue');
  });

  test('starts every destination without waiting for a slow adapter to finish', async () => {
    dbMocks.listSubscribedStaffNotificationDestinations.mockResolvedValue([
      destination('line-1', 'line'),
      destination('chatwork-1', 'chatwork'),
    ]);
    let releaseLine!: () => void;
    const lineSend = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      releaseLine = () => resolve({ ok: true });
    }));
    const chatworkSend = vi.fn(async () => ({ ok: true as const }));
    const adapters: StaffNotificationAdapterRegistry = {
      line: { channelType: 'line', failureCodes: [], send: lineSend },
      chatwork: { channelType: 'chatwork', failureCodes: [], send: chatworkSend },
    };

    const dispatch = dispatchStaffNotifications(env, payload, adapters);
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(lineSend).toHaveBeenCalledTimes(1);
      expect(chatworkSend).toHaveBeenCalledTimes(1);
    } finally {
      releaseLine();
    }
    await expect(dispatch).resolves.toMatchObject({
      attempted: 2,
      succeeded: 2,
      failed: 0,
    });
  });

  test('bounds a provider that never settles and records a fixed timeout failure', async () => {
    vi.useFakeTimers();
    try {
      dbMocks.listSubscribedStaffNotificationDestinations.mockResolvedValue([
        destination('chatwork-timeout', 'chatwork'),
      ]);
      const send = vi.fn(() => new Promise<never>(() => undefined));
      const adapters: StaffNotificationAdapterRegistry = {
        chatwork: {
          channelType: 'chatwork',
          failureCodes: [],
          send,
        },
      };

      const dispatch = dispatchStaffNotifications(env, payload, adapters);
      await Promise.resolve();
      await Promise.resolve();
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(dispatch).resolves.toEqual({
        attempted: 1,
        succeeded: 0,
        failed: 1,
        results: [{
          destinationId: 'chatwork-timeout',
          status: 'failed',
          errorCode: 'adapter_timeout',
        }],
      });
      expect(dbMocks.recordStaffNotificationDelivery).toHaveBeenCalledWith(
        DB,
        expect.objectContaining({ errorCode: 'adapter_timeout' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('swallows destination-list and delivery-log failures with fixed console messages', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbMocks.listSubscribedStaffNotificationDestinations
      .mockRejectedValueOnce(new Error('DB token 山田花子'))
      .mockResolvedValueOnce([destination('line-1', 'line')]);
    const adapters: StaffNotificationAdapterRegistry = {
      line: {
        channelType: 'line',
        failureCodes: [],
        send: vi.fn(async () => ({ ok: true as const })),
      },
    };

    await expect(dispatchStaffNotifications(env, payload, adapters)).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });

    dbMocks.recordStaffNotificationDelivery.mockRejectedValueOnce(
      new Error('log DB contains notification body'),
    );
    await expect(dispatchStaffNotifications(env, payload, adapters)).resolves.toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });

    const logs = JSON.stringify(errorSpy.mock.calls);
    expect(logs).toContain('[staff-notify] destination list failed');
    expect(logs).toContain('[staff-notify] delivery log failed');
    for (const secret of ['DB token', '山田花子', 'notification body']) {
      expect(logs).not.toContain(secret);
    }
  });

  test('returns a fixed unsupported-channel failure instead of throwing', async () => {
    dbMocks.listSubscribedStaffNotificationDestinations.mockResolvedValue([
      destination('chatwork-1', 'chatwork'),
    ]);

    await expect(dispatchStaffNotifications(env, payload, {})).resolves.toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      results: [{
        destinationId: 'chatwork-1',
        status: 'failed',
        errorCode: 'unsupported_channel',
      }],
    });
  });
});

describe('sendStaffNotificationTest', () => {
  test('sends one destination even when disabled and records the event as test', async () => {
    const target = destination('chatwork-test', 'chatwork', {
      enabled: false,
      notifyInquiry: false,
      notifyFormSubmission: false,
    });
    const send = vi.fn(async () => ({ ok: true as const }));
    const testPayload = { ...payload, eventType: 'test' as const };

    await expect(sendStaffNotificationTest(
      env,
      target,
      testPayload,
      { chatwork: { channelType: 'chatwork', failureCodes: [], send } },
    )).resolves.toEqual({
      destinationId: 'chatwork-test',
      status: 'success',
      errorCode: null,
    });

    expect(dbMocks.listSubscribedStaffNotificationDestinations).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      destination: target,
      payload: testPayload,
    }));
    expect(dbMocks.recordStaffNotificationDelivery).toHaveBeenCalledWith(DB, {
      id: expect.any(String),
      destinationId: 'chatwork-test',
      eventType: 'test',
      status: 'success',
      errorCode: null,
    });
  });
});
