/**
 * batch C-core (box editor logic) — ネスト可能な box をビルダーで作る/並べ替える純ロジック。
 *
 * repo 方針: モーダルの意思決定は純関数 (modal-logic) として node で単体テストする
 *   (aria/DOM は browser-evaluator E2E)。ここでは「box の子として部品を足す・box の中で並べ替える・
 *   ネストした部品を消す/編集する」を固定 = D&D 相当の並べ替えがネスト内でも動くことの機械証明。
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel, BuilderPart } from './types';
import { addPart, movePart, removePart, updatePart, makePart, findPart } from './modal-logic';

/** box 1 個 (子2つ) を持つカードモデル。 */
function modelWithBox(): BuilderModel {
  return {
    cards: [{
      id: 'c', parts: [
        { kind: 'heading', id: 'h', text: 'タイトル' },
        {
          kind: 'box', id: 'row', layout: 'horizontal', contents: [
            { kind: 'body', id: 'l', text: '左' },
            { kind: 'body', id: 'r', text: '右' },
          ],
        },
      ],
    }],
  };
}

const boxOf = (m: BuilderModel): Extract<BuilderPart, { kind: 'box' }> =>
  m.cards[0].parts.find((p) => p.id === 'row') as Extract<BuilderPart, { kind: 'box' }>;

describe('batch C-core box editor — makePart', () => {
  it("makePart('box') は空の横並び box", () => {
    const p = makePart('box');
    expect(p.kind).toBe('box');
    if (p.kind !== 'box') throw new Error();
    expect(p.layout).toBe('horizontal');
    expect(p.contents).toEqual([]);
  });
});

describe('batch C-core box editor — addPart (box の子として足す)', () => {
  it('parentBoxId 指定で box.contents 末尾に追加される', () => {
    const { model, partId } = addPart(modelWithBox(), 0, 'body', 'row');
    const box = boxOf(model);
    expect(box.contents.length).toBe(3);
    expect(box.contents[2].id).toBe(partId);
    // 親の root parts は増えていない (heading + box のまま)。
    expect(model.cards[0].parts.length).toBe(2);
  });
  it('parentBoxId 無しは従来どおり root 末尾に追加 (flat 後方互換)', () => {
    const { model } = addPart(modelWithBox(), 0, 'separator');
    expect(model.cards[0].parts.length).toBe(3);
    expect(model.cards[0].parts[2].kind).toBe('separator');
  });
});

describe('batch C-core box editor — movePart (ネスト内で並べ替え = D&D 相当)', () => {
  it('box の中で子を入れ替えできる', () => {
    const moved = movePart(modelWithBox(), 0, 'r', 'up');
    const box = boxOf(moved);
    expect(box.contents.map((p) => p.id)).toEqual(['r', 'l']);
    // root は不変。
    expect(moved.cards[0].parts.map((p) => p.id)).toEqual(['h', 'row']);
  });
  it('box の先頭の子を up は no-op (親の外に飛び出さない)', () => {
    const moved = movePart(modelWithBox(), 0, 'l', 'up');
    expect(boxOf(moved).contents.map((p) => p.id)).toEqual(['l', 'r']);
  });
  it('root の部品移動は従来どおり (flat 後方互換)', () => {
    const moved = movePart(modelWithBox(), 0, 'row', 'up');
    expect(moved.cards[0].parts.map((p) => p.id)).toEqual(['row', 'h']);
  });
});

describe('batch C-core box editor — remove / update (ネスト対応)', () => {
  it('ネストした子を削除できる (親 box は残る)', () => {
    const next = removePart(modelWithBox(), 0, 'l');
    const box = boxOf(next);
    expect(box.contents.map((p) => p.id)).toEqual(['r']);
  });
  it('ネストした子を編集できる', () => {
    const next = updatePart(modelWithBox(), 0, 'r', { text: '右(編集)' } as Partial<BuilderPart>);
    const box = boxOf(next);
    const child = box.contents.find((p) => p.id === 'r');
    expect(child && child.kind === 'body' ? child.text : '').toBe('右(編集)');
  });
  it('findPart はネストした部品も見つける', () => {
    const found = findPart(modelWithBox().cards[0], 'r');
    expect(found?.id).toBe('r');
    expect(findPart(modelWithBox().cards[0], 'row')?.kind).toBe('box');
    expect(findPart(modelWithBox().cards[0], 'missing')).toBeNull();
  });
});
