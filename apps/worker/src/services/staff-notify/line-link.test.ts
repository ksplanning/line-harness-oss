import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  linkStaffNotificationLineByCode: vi.fn(),
}));
vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@line-crm/db');
  return { ...actual, ...dbMocks };
});

import {
  digestStaffLineLinkCode,
  parseStaffLineLinkCommand,
  tryLinkStaffLineFromWebhook,
} from './line-link.js';

const directPrepare = vi.fn();
const DB = { prepare: directPrepare } as unknown as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('staff LINE link commands', () => {
  test.each([
    ['通知連携 AB12CD34', 'AB12CD34'],
    ['通知連携 ab12CD34', 'ab12CD34'],
  ])('parses the exact command %j', (text, code) => {
    expect(parseStaffLineLinkCommand(text)).toBe(code);
  });

  test.each([
    '通知連携 ABC1234',
    '通知連携 ABC123456',
    '通知連携　AB12CD34',
    ' 通知連携 AB12CD34',
    '通知連携  AB12CD34',
    '通知連携 AB12-CD3',
    '通知連携 ＡＢ１２ＣＤ３４',
    '通知連携 AB12CD34\n',
  ])('rejects non-exact command %j', (text) => {
    expect(parseStaffLineLinkCommand(text)).toBeNull();
  });

  test('digests a code with Web Crypto SHA-256 and returns lowercase hex', async () => {
    await expect(digestStaffLineLinkCode('AB12CD34')).resolves.toBe(
      '668c072603bbc3a89b6e2a67f878e29dbe33c020984d4928eda299e7cebe0adb',
    );
  });

  test('does not touch DB for a non-command', async () => {
    await expect(tryLinkStaffLineFromWebhook(DB, {
      lineAccountId: 'account-1',
      lineUserId: 'U_CUSTOMER',
      text: '通常の問い合わせです',
    })).resolves.toEqual({ status: 'not_handled' });

    expect(dbMocks.linkStaffNotificationLineByCode).not.toHaveBeenCalled();
    expect(directPrepare).not.toHaveBeenCalled();
  });

  test('links a valid one-time code using only the staff destination DAO', async () => {
    dbMocks.linkStaffNotificationLineByCode.mockResolvedValue({
      id: 'destination-line',
    });

    await expect(tryLinkStaffLineFromWebhook(DB, {
      lineAccountId: 'account-1',
      lineUserId: 'U_CUSTOMER_AND_STAFF',
      text: '通知連携 AB12CD34',
    })).resolves.toEqual({
      status: 'linked',
      destinationId: 'destination-line',
    });

    expect(dbMocks.linkStaffNotificationLineByCode).toHaveBeenCalledWith(DB, {
      lineAccountId: 'account-1',
      lineUserId: 'U_CUSTOMER_AND_STAFF',
      codeDigest: '668c072603bbc3a89b6e2a67f878e29dbe33c020984d4928eda299e7cebe0adb',
    });
    expect(directPrepare).not.toHaveBeenCalled();
  });

  test('returns invalid_code when no live one-time code matches', async () => {
    dbMocks.linkStaffNotificationLineByCode.mockResolvedValue(null);

    await expect(tryLinkStaffLineFromWebhook(DB, {
      lineAccountId: 'account-1',
      lineUserId: 'U_STAFF',
      text: '通知連携 AB12CD34',
    })).resolves.toEqual({ status: 'invalid_code' });
    expect(directPrepare).not.toHaveBeenCalled();
  });

  test('fails open on DAO exceptions and logs only a fixed message', async () => {
    dbMocks.linkStaffNotificationLineByCode.mockRejectedValue(
      new Error('AB12CD34 U_CUSTOMER secret DB failure'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(tryLinkStaffLineFromWebhook(DB, {
      lineAccountId: 'account-1',
      lineUserId: 'U_CUSTOMER',
      text: '通知連携 AB12CD34',
    })).resolves.toEqual({ status: 'not_handled' });

    expect(errorSpy).toHaveBeenCalledWith('[staff-notify] LINE link lookup failed');
    const logs = JSON.stringify(errorSpy.mock.calls);
    for (const secret of ['AB12CD34', 'U_CUSTOMER', 'secret DB failure']) {
      expect(logs).not.toContain(secret);
    }
    expect(directPrepare).not.toHaveBeenCalled();
  });
});
