import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getMergedMetadataByUserId: vi.fn(),
  listFriendFieldDefinitions: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);

import { renderFriendMessageContent } from './render-message.js';

const db = {} as D1Database;
const friend = {
  display_name: '山田花子',
  user_id: 'user-1',
  metadata: '{}',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getMergedMetadataByUserId.mockResolvedValue({ 会員ランク: 'ゴールド' });
  dbMocks.listFriendFieldDefinitions.mockResolvedValue([{
    id: 'field-1',
    name: '会員ランク',
    defaultValue: '未登録',
    displayOrder: 0,
    isActive: true,
    createdAt: '2026-07-20T00:00:00+09:00',
    updatedAt: '2026-07-20T00:00:00+09:00',
  }]);
});

describe('renderFriendMessageContent query boundaries', () => {
  test('does not query recipient metadata or definitions when no recipient token exists', async () => {
    await expect(renderFriendMessageContent(
      '通常本文 😊 {{liff_id}}',
      'LIFF-1',
      db,
      friend,
    )).resolves.toBe('通常本文 😊 LIFF-1');

    expect(dbMocks.getMergedMetadataByUserId).not.toHaveBeenCalled();
    expect(dbMocks.listFriendFieldDefinitions).not.toHaveBeenCalled();
  });

  test('does not query custom fields for a display-name-only message', async () => {
    await expect(renderFriendMessageContent(
      'こんにちは {{display_name|お客様}}さん',
      null,
      db,
      friend,
    )).resolves.toBe('こんにちは 山田花子さん');

    expect(dbMocks.getMergedMetadataByUserId).not.toHaveBeenCalled();
    expect(dbMocks.listFriendFieldDefinitions).not.toHaveBeenCalled();
  });

  test('queries active definitions only when a custom-field token exists', async () => {
    await expect(renderFriendMessageContent(
      '{{display_name}} / {{field:会員ランク}}',
      null,
      db,
      friend,
    )).resolves.toBe('山田花子 / ゴールド');

    expect(dbMocks.getMergedMetadataByUserId).toHaveBeenCalledWith(db, 'user-1');
    expect(dbMocks.listFriendFieldDefinitions).toHaveBeenCalledWith(db, { activeOnly: true });
  });
});
