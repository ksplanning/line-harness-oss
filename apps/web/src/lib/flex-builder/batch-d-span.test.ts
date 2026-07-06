/**
 * batch D (高度表現 part 3) — span (リッチ文中装飾)。
 * 1 つの text の中で語ごとに色/大きさ/太さ/装飾を変える (richtext 部品 = text + contents[span])。
 *
 *   - round-trip: 複数 span の text が to-flex→from-flex で出力安定
 *   - M-20: 通常の heading/body (contents 無し) は不変
 *   - GC-1 fail-closed: span の不正な色/サイズ/装飾をブロック
 *   - GC-2 lossless-only: span に未知キー・text レベルに未対応キーがあれば null
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel, BuilderPart } from './types';
import { buildModelToFlex } from './to-flex';
import { flexToModel } from './from-flex';
import { validateFlex } from './validate';

function roundTrips(parts: BuilderPart[]): void {
  const model: BuilderModel = { cards: [{ id: 'c', parts }] };
  const flex1 = JSON.stringify(buildModelToFlex(model));
  const back = flexToModel(flex1);
  expect(back, `flexToModel returned null for ${flex1}`).not.toBeNull();
  expect(JSON.stringify(buildModelToFlex(back!))).toBe(flex1);
}

describe('batch D — richtext (span)', () => {
  it('複数 span (色/太さ/サイズ/装飾) の richtext が round-trip', () => {
    roundTrips([{
      kind: 'richtext', id: 'rt', align: 'center', size: 'lg', margin: 'md', runs: [
        { text: '通常 ' },
        { text: '強調', color: '#E53935', weight: 'bold' },
        { text: ' 大きい', size: 'xl' },
        { text: ' 下線', decoration: 'underline' },
      ],
    }]);
  });
  it('to-flex は text + contents[span] を出す (top-level text は出さない)', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'richtext', id: 'rt', runs: [{ text: 'A' }, { text: 'B', color: '#06C755' }] }] }] };
    const flex = JSON.parse(JSON.stringify(buildModelToFlex(m)));
    const textNode = flex.body.contents[0];
    expect(textNode.type).toBe('text');
    expect(textNode.text).toBeUndefined();
    expect(Array.isArray(textNode.contents)).toBe(true);
    expect(textNode.contents[0]).toEqual({ type: 'span', text: 'A' });
    expect(textNode.contents[1]).toEqual({ type: 'span', text: 'B', color: '#06C755' });
  });
  it('GC-1: span の不正な色/サイズ/装飾はブロック / 正常は ok', () => {
    const mk = (run: Record<string, unknown>): BuilderModel => ({ cards: [{ id: 'c', parts: [{ kind: 'richtext', id: 'rt', runs: [{ text: 'x', ...run }] } as BuilderPart] }] });
    expect(validateFlex(buildModelToFlex(mk({ color: 'red' }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(mk({ size: 'huge' }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(mk({ decoration: 'blink' }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(mk({ color: '#06C755', size: 'xl', weight: 'bold', decoration: 'underline' }))).ok).toBe(true);
  });
  it('GC-1: span の text が空はブロック', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'richtext', id: 'rt', runs: [{ text: '' }] }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
  it('GC-2: span に未知キーがあれば null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', wrap: true, contents: [{ type: 'span', text: 'x', foo: 1 }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('GC-2: text レベルに未対応キー (weight) + contents があれば null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', wrap: true, weight: 'bold', contents: [{ type: 'span', text: 'x' }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('M-20: 通常の heading/body (contents 無し) は不変', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'h', text: '見出し' }, { kind: 'body', id: 'b', text: '本文' }] }] };
    expect(JSON.stringify(buildModelToFlex(m))).toBe(JSON.stringify({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: '見出し', wrap: true, weight: 'bold', size: 'lg' },
        { type: 'text', text: '本文', wrap: true },
      ] },
    }));
  });
});
