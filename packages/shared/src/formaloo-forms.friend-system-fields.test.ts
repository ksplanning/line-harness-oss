import { describe, expect, test } from 'vitest';
import {
  FRIEND_SYSTEM_FIELDS,
  FRIEND_SYSTEM_ALIASES,
  isFriendSystemAlias,
  toFormalooFieldPayload,
  type HarnessField,
} from './formaloo-forms';

// =============================================================================
// fr-id-capture-fix / T-C1: system hidden field の単一正本 (FRIEND_SYSTEM_FIELDS) の shape 契約。
//   - fr_id (identity 必須) と fr_name (PII owner-gate) の 2 予約 alias のみ・type=hidden・required=false。
//   - isFriendSystemAlias が予約 alias のみ true (push/pull/drift/admin 除外の共通判定の芯)。
//   - toFormalooFieldPayload (harness field 変換) は決して予約 alias を emit しない (user が予約 alias を
//     作れない構造保証 / T-C6 の一部)。
// =============================================================================
describe('FRIEND_SYSTEM_FIELDS (T-C1: system hidden field 単一正本)', () => {
  test('予約 field は fr_id / fr_name の 2 件のみ・全て type=hidden・required=false', () => {
    expect(FRIEND_SYSTEM_ALIASES).toEqual(['fr_id', 'fr_name']);
    expect(FRIEND_SYSTEM_FIELDS).toHaveLength(2);
    for (const f of FRIEND_SYSTEM_FIELDS) {
      expect(f.type).toBe('hidden');
      expect(f.required).toBe(false);
      expect(f.position).toBe(0);
      expect(typeof f.title).toBe('string');
      expect(f.title.length).toBeGreaterThan(0);
    }
  });

  test('fr_id は identity 用 (ownerGated=false) / fr_name は PII (ownerGated=true)', () => {
    const frId = FRIEND_SYSTEM_FIELDS.find((f) => f.alias === 'fr_id')!;
    const frName = FRIEND_SYSTEM_FIELDS.find((f) => f.alias === 'fr_name')!;
    expect(frId.ownerGated).toBe(false);
    expect(frName.ownerGated).toBe(true);
  });

  test('isFriendSystemAlias は予約 alias のみ true / それ以外・非文字列は false', () => {
    expect(isFriendSystemAlias('fr_id')).toBe(true);
    expect(isFriendSystemAlias('fr_name')).toBe(true);
    expect(isFriendSystemAlias('name')).toBe(false);
    expect(isFriendSystemAlias('fr_idx')).toBe(false);
    expect(isFriendSystemAlias('')).toBe(false);
    expect(isFriendSystemAlias(null)).toBe(false);
    expect(isFriendSystemAlias(undefined)).toBe(false);
    expect(isFriendSystemAlias(123)).toBe(false);
  });

  test('T-C6 構造保証: harness field 変換 (toFormalooFieldPayload) は予約 alias を一切 emit しない', () => {
    // harness field モデルには alias が存在しない = user が予約 alias を持つ field を builder から作れない。
    const samples: HarnessField[] = [
      { id: 'a', type: 'text', label: 'fr_id', required: true, position: 0, config: {} },
      { id: 'b', type: 'choice', label: '選択', required: false, position: 1, config: { choices: ['x', 'y'] } },
      { id: 'c', type: 'section', label: 'sec', required: false, position: 2, config: { text: 'fr_id fr_name' } },
    ];
    for (const f of samples) {
      const payload = toFormalooFieldPayload(f);
      expect('alias' in payload).toBe(false);
      expect(payload.alias).toBeUndefined();
    }
  });
});
