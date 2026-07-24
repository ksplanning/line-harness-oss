import { describe, expect, test, vi } from 'vitest';
import type { StaffNotificationDestination } from '@line-crm/db';
import {
  AUTO_REPLY_HANDLED_SOURCE,
  AUTO_REPLY_KEEP_UNRESPONDED_SOURCE,
} from '../auto-reply-keyword-match.js';
import { createChatworkStaffNotificationAdapter } from './chatwork.js';
import type { StaffNotificationPayload } from './types.js';

const DB = {} as D1Database;
const payload = {
  eventType: 'inquiry_received' as const,
  lineAccountId: 'account-1',
  name: '山田花子',
  excerpt: '予約について相談したいです',
  deepLink: 'https://admin.example.test/chats/friend-1',
};

function destination(
  config: Record<string, unknown> = { roomId: '123456', apiToken: 'chatwork-token' },
): StaffNotificationDestination {
  return {
    id: 'destination-chatwork',
    lineAccountId: 'account-1',
    label: '店舗Chatwork',
    channelType: 'chatwork',
    config,
    notifyInquiry: true,
    notifyFormSubmission: true,
    enabled: true,
    lineUserId: null,
    lineLinkCodeDigest: null,
    lineLinkCodeExpiresAt: null,
    lineLinkedAt: null,
    createdAt: '2026-07-23T00:00:00+09:00',
    updatedAt: '2026-07-23T00:00:00+09:00',
  };
}

describe('Chatwork staff notification adapter', () => {
  test('posts the rendered text using the room path, token header, and form body', async () => {
    const fetcher = vi.fn(async () => new Response('{"message_id":"1"}', { status: 200 }));
    const adapter = createChatworkStaffNotificationAdapter(fetcher);

    await expect(adapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: 'スタッフ通知本文',
    })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.chatwork.com/v2/rooms/123456/messages');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-ChatWorkToken')).toBe('chatwork-token');
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(init?.body)).get('body')).toBe('スタッフ通知本文');
  });

  test('API呼び出し部品は解決済みの共通roomIdだけを送信先に使う', async () => {
    const fetcher = vi.fn(async () => new Response('{"message_id":"1"}', { status: 200 }));
    const adapter = createChatworkStaffNotificationAdapter(fetcher);
    const config = {
      roomId: '999999',
      inquiryRoomId: '111111',
      formSubmissionRoomId: '222222',
      autoReplyRoomId: '333333',
      apiToken: 'chatwork-token',
    };

    await expect(adapter.send({
      env: { DB },
      destination: destination(config),
      payload: { ...payload, source: AUTO_REPLY_HANDLED_SOURCE },
      text: '本文',
    })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.chatwork.com/v2/rooms/999999/messages',
      expect.any(Object),
    );
  });

  test.each<[string, StaffNotificationPayload]>([
    ['問い合わせ', { ...payload, source: 'user' }],
    ['フォーム', { ...payload, eventType: 'form_submitted' }],
    ['自動応答', { ...payload, source: AUTO_REPLY_HANDLED_SOURCE }],
    ['テスト送信', { ...payload, eventType: 'test' }],
  ])('%s のカテゴリ別ルームが空なら共通ルームへ送る', async (_label, notification) => {
    const fetcher = vi.fn(async () => new Response('{"message_id":"1"}', { status: 200 }));
    const adapter = createChatworkStaffNotificationAdapter(fetcher);

    await expect(adapter.send({
      env: { DB },
      destination: destination({
        roomId: '999999',
        apiToken: 'chatwork-token',
      }),
      payload: notification,
      text: '本文',
    })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.chatwork.com/v2/rooms/999999/messages',
      expect.any(Object),
    );
  });

  test.each([
    [{ roomId: '../other', apiToken: 'token' }, 'chatwork_invalid_config'],
    [{ roomId: '123456', apiToken: '' }, 'chatwork_invalid_config'],
  ])('rejects invalid config without issuing a request', async (config, errorCode) => {
    const fetcher = vi.fn(async () => new Response('{"message_id":"1"}', { status: 200 }));
    const adapter = createChatworkStaffNotificationAdapter(fetcher);

    await expect(adapter.send({
      env: { DB },
      destination: destination(config),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('maps a non-2xx response to a fixed error code without reading the response body', async () => {
    const response = new Response('provider token and private body', { status: 403 });
    const textSpy = vi.spyOn(response, 'text');
    const fetcher = vi.fn(async () => response);
    const adapter = createChatworkStaffNotificationAdapter(fetcher);

    await expect(adapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode: 'chatwork_http_error' });
    expect(textSpy).not.toHaveBeenCalled();
  });

  test('maps a network exception to a fixed error code and never logs its message', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('chatwork-token 山田花子 本文');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = createChatworkStaffNotificationAdapter(fetcher);

    await expect(adapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode: 'chatwork_network_error' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
