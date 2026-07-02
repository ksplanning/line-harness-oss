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
  duplicateCard,
  moveCard,
  removeCard,
} from './modal-logic';
import { buildModelToFlex } from './to-flex';
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

describe('カード操作 (カルーセル / D-13)', () => {
  test('D-13: 複製で cards が 1→2 になり、出力が carousel かつ contents.length===2', () => {
    const before = base();
    expect(buildModelToFlex(before).type).toBe('bubble');
    const { model: after, newIndex } = duplicateCard(before, 0);
    expect(after.cards.length).toBe(2);
    expect(newIndex).toBe(1);
    const out = buildModelToFlex(after);
    expect(out.type).toBe('carousel');
    if (out.type !== 'carousel') throw new Error();
    expect(out.contents.length).toBe(2);
  });

  test('複製カードは新 id を持ち中身は同じ (id 衝突なし)', () => {
    const { model: after } = duplicateCard(base(), 0);
    expect(after.cards[0].id).not.toBe(after.cards[1].id);
    expect(after.cards[0].parts[0].id).not.toBe(after.cards[1].parts[0].id);
    // 中身 (text) は複製されている
    const p0 = after.cards[0].parts[0];
    const p1 = after.cards[1].parts[0];
    if (p0.kind === 'heading' && p1.kind === 'heading') {
      expect(p1.text).toBe(p0.text);
    }
  });

  test('moveCard 左右で順序が入れ替わる', () => {
    const m: BuilderModel = {
      cards: [
        { id: 'a', parts: [{ kind: 'body', id: 'p1', text: 'A' }] },
        { id: 'b', parts: [{ kind: 'body', id: 'p2', text: 'B' }] },
      ],
    };
    const moved = moveCard(m, 1, 'left');
    expect(moved.cards[0].id).toBe('b');
    expect(moved.cards[1].id).toBe('a');
  });

  test('先頭で left / 末尾で right は no-op', () => {
    const m: BuilderModel = {
      cards: [{ id: 'a', parts: [] }, { id: 'b', parts: [] }],
    };
    expect(moveCard(m, 0, 'left').cards.map((c) => c.id)).toEqual(['a', 'b']);
    expect(moveCard(m, 1, 'right').cards.map((c) => c.id)).toEqual(['a', 'b']);
  });

  test('removeCard は 2 枚→1 枚にできるが、最後の 1 枚は消せない', () => {
    const m: BuilderModel = {
      cards: [{ id: 'a', parts: [] }, { id: 'b', parts: [] }],
    };
    const oneLeft = removeCard(m, 0);
    expect(oneLeft.cards.length).toBe(1);
    expect(oneLeft.cards[0].id).toBe('b');
    // 最後の 1 枚は消せない (no-op)
    expect(removeCard(oneLeft, 0).cards.length).toBe(1);
  });
});
