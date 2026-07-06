/**
 * batch C-core (structure / box) — flat parts[] を「ネスト可能な box 部品」に拡張。
 * box(横並び horizontal / 縦 vertical / baseline / ネスト / 背景色 / 角丸 / padding / border /
 *   width・height / justifyContent・alignItems・gravity・spacing・flex) を安全に追加する。
 *
 *   - M-20 後方互換: box を使わない既存 flat model は旧出力バイト等価 (union 追加が出力を変えない)
 *   - M-18 round-trip: box(ネスト/横並び/装飾つき) が to-flex→from-flex で出力安定
 *   - GC-1 fail-closed: 不正な box プロパティは validateFlex がブロック
 *   - GC-2 lossless-only: box が表現できない prop(action/gradient 等)を持つ node は from-flex が null
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel, BuilderPart } from './types';
import { buildModelToFlex } from './to-flex';
import { flexToModel } from './from-flex';
import { validateFlex } from './validate';

/** round-trip 不変量 = 出力安定性 (model→flex1→model2→flex2 で flex1===flex2)。 */
function roundTrips(parts: BuilderPart[]): void {
  const model: BuilderModel = { cards: [{ id: 'c', parts }] };
  const flex1 = JSON.stringify(buildModelToFlex(model));
  const back = flexToModel(flex1);
  expect(back, `flexToModel returned null for ${flex1}`).not.toBeNull();
  const flex2 = JSON.stringify(buildModelToFlex(back!));
  expect(flex2).toBe(flex1);
}

describe('batch C-core box — M-20 後方互換 (box 未使用の flat model は旧出力バイト等価)', () => {
  it('box union を足しても既存6部品の既定出力は不変', () => {
    const model: BuilderModel = {
      cards: [{
        id: 'c', parts: [
          { kind: 'heading', id: 'h', text: '見出し' },
          { kind: 'body', id: 'b', text: '本文' },
          { kind: 'separator', id: 's' },
        ],
      }],
    };
    expect(JSON.stringify(buildModelToFlex(model))).toBe(JSON.stringify({
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '見出し', wrap: true, weight: 'bold', size: 'lg' },
          { type: 'text', text: '本文', wrap: true },
          { type: 'separator' },
        ],
      },
    }));
  });
});

describe('batch C-core box — round-trip (横並び / ネスト / 装飾)', () => {
  it('横並び box (2カラム) が round-trip', () => {
    roundTrips([
      {
        kind: 'box', id: 'row', layout: 'horizontal', contents: [
          { kind: 'body', id: 'l', text: '左' },
          { kind: 'body', id: 'r', text: '右' },
        ],
      },
    ]);
  });
  it('ネストした box (box in box) が round-trip', () => {
    roundTrips([
      {
        kind: 'box', id: 'outer', layout: 'vertical', contents: [
          { kind: 'heading', id: 'h', text: 'タイトル' },
          {
            kind: 'box', id: 'inner', layout: 'horizontal', spacing: 'md', contents: [
              { kind: 'image', id: 'i', url: 'https://x/a.png', aspect: 'square', rounded: true },
              { kind: 'body', id: 'b', text: '説明' },
            ],
          },
        ],
      },
    ]);
  });
  it('box の全装飾 (背景/角丸/枠/padding/幅高さ/そろえ/gravity/spacing/flex/margin) が round-trip', () => {
    roundTrips([
      {
        kind: 'box', id: 'deco', layout: 'horizontal',
        backgroundColor: '#F5F5F5', cornerRadius: 'md', borderWidth: 'normal', borderColor: '#E0E0E0',
        paddingAll: 'md', paddingTop: '8px', paddingBottom: 'sm', paddingStart: 'lg', paddingEnd: '10px',
        width: '100px', height: '60px', justifyContent: 'center', alignItems: 'center',
        gravity: 'center', spacing: 'sm', flex: 1, margin: 'md',
        contents: [{ kind: 'body', id: 'b', text: 'x' }],
      },
    ]);
  });
  it('空 box (contents 空) も round-trip', () => {
    roundTrips([{ kind: 'box', id: 'e', layout: 'vertical', contents: [] }]);
  });
});

describe('batch C-core box — GC-1 fail-closed (不正な box プロパティをブロック)', () => {
  const boxWith = (extra: Record<string, unknown>): BuilderModel => ({
    cards: [{ id: 'c', parts: [{ kind: 'box', id: 'x', layout: 'horizontal', contents: [{ kind: 'body', id: 'b', text: 'x' }], ...extra } as BuilderPart] }] },
  );
  it('不正な背景色/角丸/枠/padding/そろえ/gravity/幅/flex は ok:false', () => {
    for (const bad of [
      { backgroundColor: 'red' }, { backgroundColor: '#12' }, { cornerRadius: 'huge' },
      { borderWidth: 'thick' }, { borderColor: 'blue' }, { paddingAll: 'giant' },
      { justifyContent: 'middle' }, { alignItems: 'top' }, { gravity: 'left' },
      { width: 'wide' }, { height: 'tall' }, { flex: -1 }, { spacing: 'giant' },
    ]) {
      const r = validateFlex(buildModelToFlex(boxWith(bad)));
      expect(r.ok, `expected fail for ${JSON.stringify(bad)}`).toBe(false);
    }
  });
  it('正しい box プロパティは ok:true', () => {
    const r = validateFlex(buildModelToFlex(boxWith({
      backgroundColor: '#F5F5F5', cornerRadius: 'md', borderWidth: 'normal', borderColor: '#E0E0E0',
      paddingAll: 'md', width: '100px', height: '50%', justifyContent: 'space-between',
      alignItems: 'center', gravity: 'center', flex: 2, spacing: 'sm',
    })));
    expect(r.ok).toBe(true);
  });
  it('不正な layout の box はブロック (raw JSON)', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [{ type: 'box', layout: 'diagonal', contents: [{ type: 'text', text: 'x', wrap: true }] }] } });
    expect(validateFlex(JSON.parse(json)).ok).toBe(false);
  });
});

describe('batch C-core box — GC-2 lossless-only (表現不能な box は from-flex が null)', () => {
  it('box に未知 prop (action) → null (上級者 JSON へ)', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'box', layout: 'horizontal', action: { type: 'uri', uri: 'https://x' }, contents: [{ type: 'text', text: 'x', wrap: true }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('box の gradient 背景に未知キーがあれば null (batch D で gradient 自体は対応)', () => {
    // batch D で linearGradient は対応集合に入った。gradient object の未知キーは lossless 不可 → null。
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'box', layout: 'vertical', background: { type: 'linearGradient', angle: '90deg', startColor: '#fff', endColor: '#000', unknownKey: 1 }, contents: [{ type: 'text', text: 'x', wrap: true }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('正常な box を含む Flex は round-trip 可 (null にならない)', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [{ type: 'box', layout: 'horizontal', backgroundColor: '#F5F5F5', contents: [{ type: 'text', text: 'x', wrap: true }] }] } });
    expect(flexToModel(json)).not.toBeNull();
  });
  it('box の子に表現不能な node があれば box 全体が null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'x', wrap: true, gravity: 'center' }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
});
