import { describe, expect, test } from 'vitest';
import {
  parseFriendMetadataMappingsJson,
  isInternalFormalooMetadataKey,
  isReservedFriendMetadataKey,
  validateFriendMetadataMappings,
} from './formaloo-friend-metadata.js';

describe('Formaloo → friend.metadata mapping validation', () => {
  test('slug/alias と個人情報キーを trim して保持する', () => {
    const result = validateFriendMetadataMappings([
      { formalooFieldKey: ' BjEp0J2J ', friendMetadataKey: ' 入金確認 ' },
    ]);
    expect(result).toEqual({
      ok: true,
      mappings: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' }],
    });
  });

  test('空値・重複 target・内部/プロトタイプ key は fail-closed で拒否する', () => {
    expect(validateFriendMetadataMappings([
      { formalooFieldKey: '', friendMetadataKey: '入金確認' },
    ]).ok).toBe(false);
    expect(validateFriendMetadataMappings([
      { formalooFieldKey: 'field_a', friendMetadataKey: '入金確認' },
      { formalooFieldKey: 'field_b', friendMetadataKey: '入金確認' },
    ]).ok).toBe(false);
    expect(validateFriendMetadataMappings([
      { formalooFieldKey: 'field_a', friendMetadataKey: '__formaloo_friend_metadata_sync' },
    ]).ok).toBe(false);
    for (const friendMetadataKey of ['__proto__', 'prototype', 'constructor']) {
      expect(validateFriendMetadataMappings([
        { formalooFieldKey: 'field_a', friendMetadataKey },
      ]).ok).toBe(false);
    }
  });

  test('DB の壊れた JSON / 非配列は [] に倒し、未設定は no-op にする', () => {
    expect(parseFriendMetadataMappingsJson('{broken')).toEqual([]);
    expect(parseFriendMetadataMappingsJson('{"formalooFieldKey":"x"}')).toEqual([]);
    expect(parseFriendMetadataMappingsJson('[]')).toEqual([]);
  });

  test('由来履歴の内部 namespace を UI 非表示対象として識別する', () => {
    expect(isInternalFormalooMetadataKey('__formaloo_friend_metadata_sync')).toBe(true);
    expect(isInternalFormalooMetadataKey('入金確認')).toBe(false);
    expect(isReservedFriendMetadataKey('__formaloo_friend_metadata_sync')).toBe(true);
    expect(isReservedFriendMetadataKey('__proto__')).toBe(true);
    expect(isReservedFriendMetadataKey('入金確認')).toBe(false);
  });
});
