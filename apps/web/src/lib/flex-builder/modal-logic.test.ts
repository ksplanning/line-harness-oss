/**
 * モーダル純ロジックテスト。
 * D-5/D-6 (閉じ操作の confirm 要否) と D-9/D-10 (各操作後にプレビュー JSON が変化) を
 * 純関数レベルで担保する。aria/sticky/DOM 静的属性は C8 E2E で実機確認。
 */
import { describe, test, expect } from 'vitest';
import {
  isModelDirty,
  shouldConfirmClose,
  previewJson,
  addPart,
  movePart,
  removePart,
  updatePart,
} from './modal-logic';
import type { BuilderModel } from './types';

function base(): BuilderModel {
  return { cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'h', text: '見出し' }] }] };
}

describe('isModelDirty (D-5/D-6 の土台)', () => {
  test('同一モデルは dirty でない', () => {
    const m = base();
    expect(isModelDirty(m, { cards: m.cards.map((c) => ({ ...c, parts: [...c.parts] })) })).toBe(false);
  });
  test('1 手でも変えたら dirty', () => {
    const snap = base();
    const changed = updatePart(snap, 0, 'h', { text: '変更後' } as never);
    expect(isModelDirty(snap, changed)).toBe(true);
  });
});

describe('shouldConfirmClose (D-5/D-6)', () => {
  test('D-6: dirty なら needsConfirm=true (window.confirm を要求)', () => {
    expect(shouldConfirmClose({ isDirty: true, saving: false })).toEqual({ canClose: true, needsConfirm: true });
  });
  test('D-5: 入力なし (not dirty) なら confirm なしで閉じる', () => {
    expect(shouldConfirmClose({ isDirty: false, saving: false })).toEqual({ canClose: true, needsConfirm: false });
  });
  test('saving 中は閉じない', () => {
    expect(shouldConfirmClose({ isDirty: true, saving: true })).toEqual({ canClose: false, needsConfirm: false });
  });
});

describe('操作の即時反映 (D-9/D-10): previewJson が操作前後で変化', () => {
  test('D-9: 部品追加でプレビュー JSON が変化する', () => {
    const before = base();
    const beforeJson = previewJson(before);
    const { model: after } = addPart(before, 0, 'body');
    expect(previewJson(after)).not.toBe(beforeJson);
  });

  test('D-10: 上へ移動でプレビュー JSON が変化する', () => {
    const m: BuilderModel = {
      cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'a', text: 'A' }, { kind: 'body', id: 'b', text: 'B' }] }],
    };
    const before = previewJson(m);
    const moved = movePart(m, 0, 'b', 'up');
    expect(previewJson(moved)).not.toBe(before);
    // 順序が実際に入れ替わったことも確認
    const out = JSON.parse(previewJson(moved));
    expect(out.body.contents[0].text).toBe('B');
  });

  test('D-10: 下へ移動でプレビュー JSON が変化する', () => {
    const m: BuilderModel = {
      cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'a', text: 'A' }, { kind: 'body', id: 'b', text: 'B' }] }],
    };
    const before = previewJson(m);
    const moved = movePart(m, 0, 'a', 'down');
    expect(previewJson(moved)).not.toBe(before);
  });

  test('D-10: 削除でプレビュー JSON が変化する', () => {
    const before = base();
    const beforeJson = previewJson(before);
    const after = removePart(before, 0, 'h');
    expect(previewJson(after)).not.toBe(beforeJson);
  });

  test('部品編集 (text 変更) でプレビュー JSON が変化する', () => {
    const before = base();
    const beforeJson = previewJson(before);
    const after = updatePart(before, 0, 'h', { text: '新しい見出し' } as never);
    expect(previewJson(after)).not.toBe(beforeJson);
  });

  test('先頭で上へ移動は no-op (JSON 不変)', () => {
    const m: BuilderModel = {
      cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'a', text: 'A' }, { kind: 'body', id: 'b', text: 'B' }] }],
    };
    const before = previewJson(m);
    expect(previewJson(movePart(m, 0, 'a', 'up'))).toBe(before);
  });

  test('追加した部品は選択できるよう id を返す', () => {
    const { partId } = addPart(base(), 0, 'image');
    expect(typeof partId).toBe('string');
    expect(partId.length).toBeGreaterThan(0);
  });
});
