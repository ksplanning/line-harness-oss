import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { StaffNotificationDestination } from '@line-crm/db';

const dbMocks = vi.hoisted(() => ({
  getLineAccountById: vi.fn(),
}));
vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return { ...actual, ...dbMocks };
});

const lineMocks = vi.hoisted(() => ({
  pushMessage: vi.fn(),
  constructor: vi.fn(),
}));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(token: string) {
      lineMocks.constructor(token);
    }

    pushMessage(lineUserId: string, messages: unknown[]) {
      return lineMocks.pushMessage(lineUserId, messages);
    }
  },
}));

import { lineStaffNotificationAdapter } from './line.js';

const DB = { prepare: vi.fn() } as unknown as D1Database;
const payload = {
  eventType: 'inquiry_received' as const,
  lineAccountId: 'account-1',
  name: '山田花子',
  excerpt: '予約について相談したいです',
  deepLink: 'https://admin.example.test/chats/friend-1',
};

function destination(lineUserId: string | null = 'U_STAFF'): StaffNotificationDestination {
  return {
    id: 'destination-line',
    lineAccountId: 'account-1',
    label: '店長LINE',
    channelType: 'line',
    config: {},
    notifyInquiry: true,
    notifyFormSubmission: true,
    enabled: true,
    lineUserId,
    lineLinkCodeDigest: null,
    lineLinkCodeExpiresAt: null,
    lineLinkedAt: '2026-07-23T00:00:00+09:00',
    createdAt: '2026-07-23T00:00:00+09:00',
    updatedAt: '2026-07-23T00:00:00+09:00',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccountById.mockResolvedValue({
    id: 'account-1',
    is_active: 1,
    channel_access_token: 'line-account-token',
  });
  lineMocks.pushMessage.mockResolvedValue(undefined);
});

describe('LINE staff notification adapter', () => {
  test('pushes directly to destination.lineUserId with the destination account token', async () => {
    await expect(lineStaffNotificationAdapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: 'スタッフ通知本文',
    })).resolves.toEqual({ ok: true });

    expect(dbMocks.getLineAccountById).toHaveBeenCalledWith(DB, 'account-1');
    expect(lineMocks.constructor).toHaveBeenCalledWith('line-account-token');
    expect(lineMocks.pushMessage).toHaveBeenCalledWith('U_STAFF', [
      { type: 'text', text: 'スタッフ通知本文' },
    ]);
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  test('does not look up an account or friend when the staff LINE link is absent', async () => {
    await expect(lineStaffNotificationAdapter.send({
      env: { DB },
      destination: destination(null),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode: 'line_not_linked' });

    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
    expect(DB.prepare).not.toHaveBeenCalled();
  });

  test.each([
    [null, 'line_account_unavailable'],
    [{ id: 'account-1', is_active: 0, channel_access_token: 'token' }, 'line_account_unavailable'],
  ])('fails safely when the LINE account cannot send', async (account, errorCode) => {
    dbMocks.getLineAccountById.mockResolvedValue(account);

    await expect(lineStaffNotificationAdapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode });
    expect(lineMocks.pushMessage).not.toHaveBeenCalled();
  });

  test('maps account lookup and push exceptions to fixed codes without logging exception text', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbMocks.getLineAccountById.mockRejectedValueOnce(new Error('line-account-token customer data'));

    await expect(lineStaffNotificationAdapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode: 'line_account_lookup_failed' });

    dbMocks.getLineAccountById.mockResolvedValueOnce({
      id: 'account-1',
      is_active: 1,
      channel_access_token: 'line-account-token',
    });
    lineMocks.pushMessage.mockRejectedValueOnce(new Error('U_STAFF 本文'));

    await expect(lineStaffNotificationAdapter.send({
      env: { DB },
      destination: destination(),
      payload,
      text: '本文',
    })).resolves.toEqual({ ok: false, errorCode: 'line_push_failed' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
