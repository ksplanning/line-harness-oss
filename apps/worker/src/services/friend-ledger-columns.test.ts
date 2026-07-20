import { describe, expect, test } from 'vitest';
import {
  FRIEND_LEDGER_IDENTITY_HEADERS,
  buildFriendLedgerColumns,
  mergeFriendProjectionIntoRow,
  projectFriendLedgerRow,
  resolveFriendLedgerHeaders,
} from './friend-ledger-columns.js';

const mappings = [
  { fieldId: 'field_paid', header: '入金確認' },
  { fieldId: 'field_note', header: '担当メモ' },
];

describe('friend ledger column block', () => {
  test('builds the reusable friend block with immutable identity columns first', () => {
    expect(FRIEND_LEDGER_IDENTITY_HEADERS).toEqual(['表示名', 'userId', '登録日']);
    expect(buildFriendLedgerColumns(mappings)).toEqual([
      { key: 'identity:displayName', header: '表示名', kind: 'identity', readOnly: true },
      { key: 'identity:lineUserId', header: 'userId', kind: 'identity', readOnly: true },
      { key: 'identity:registeredAt', header: '登録日', kind: 'identity', readOnly: true },
      { key: 'field:field_paid', header: '入金確認', kind: 'custom', readOnly: false },
      { key: 'field:field_note', header: '担当メモ', kind: 'custom', readOnly: false },
    ]);
  });

  test('resolves by exact heading after company columns are inserted or reordered', () => {
    const columns = buildFriendLedgerColumns(mappings);
    const resolved = resolveFriendLedgerHeaders(
      ['自社担当', '担当メモ', 'userId', '表示名', '登録日', '入金確認'],
      columns,
    );

    expect(resolved.indexByKey).toEqual({
      'identity:displayName': 3,
      'identity:lineUserId': 2,
      'identity:registeredAt': 4,
      'field:field_paid': 5,
      'field:field_note': 1,
    });
    expect(resolved.warnings).toEqual([]);
  });

  test('warns and refuses ambiguous, renamed, or identity-colliding headings', () => {
    const columns = buildFriendLedgerColumns([
      { fieldId: 'bad', header: '表示名' },
      { fieldId: 'paid', header: '入金確認' },
    ]);
    const resolved = resolveFriendLedgerHeaders(
      ['表示名', 'userId', '登録日', '入金済み', '表示名'],
      columns,
    );

    expect(resolved.indexByKey['field:paid']).toBeUndefined();
    expect(resolved.indexByKey['identity:displayName']).toBeUndefined();
    expect(resolved.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_header', header: '表示名' }),
      expect.objectContaining({ code: 'missing_header', header: '入金確認' }),
      expect.objectContaining({ code: 'configured_header_collision', header: '表示名' }),
    ]));
  });

  test('projects selected metadata only and preserves every company-owned cell', () => {
    const columns = buildFriendLedgerColumns(mappings);
    const headers = ['自社担当', '担当メモ', 'userId', '表示名', '登録日', '入金確認'];
    const resolved = resolveFriendLedgerHeaders(headers, columns);
    const projection = projectFriendLedgerRow({
      id: 'friend-1',
      lineUserId: 'U123',
      displayName: 'あやこ',
      registeredAt: '2026-07-21T10:00:00+09:00',
      metadata: { 入金確認: '済', 担当メモ: '佐藤', 未選択: '漏らさない' },
    }, mappings);

    expect(mergeFriendProjectionIntoRow(
      ['営業部', '旧担当', 'U123', '旧名', '旧日付', '未'],
      projection,
      columns,
      resolved,
    )).toEqual(['営業部', '佐藤', 'U123', 'あやこ', '2026-07-21T10:00:00+09:00', '済']);
    expect(Object.keys(projection)).not.toContain('未選択');
  });
});
