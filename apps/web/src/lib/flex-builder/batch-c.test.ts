/**
 * batch C (structure / 部分: bubble.size) — カードの大きさ (nano..giga)。
 * (box 横並び/ネスト・hero/header/footer は次の増分。ここでは bubble-size を安全に追加する。)
 *
 *   - M-20 後方互換: size 未指定は旧出力バイト等価
 *   - round-trip: size つき bubble が to-flex→from-flex で安定
 *   - GC-1: 不正な size は validateFlex がブロック
 *   - GC-2 lossless: header/footer/未知キーを持つ bubble は from-flex が null
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel } from './types';
import { buildModelToFlex } from './to-flex';
import { flexToModel } from './from-flex';
import { validateFlex } from './validate';

describe('batch C — bubble.size', () => {
  it('M-20: size 未指定は旧 bubble 出力と等価 (size キーが増えない)', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'heading', id: 'h', text: 'x' }] }] };
    expect(JSON.stringify(buildModelToFlex(m))).toBe(JSON.stringify({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [{ type: 'text', text: 'x', wrap: true, weight: 'bold', size: 'lg' }] },
    }));
  });

  it('size つきは type 直後に size を出す + round-trip 安定', () => {
    const m: BuilderModel = { cards: [{ id: 'c', size: 'giga', parts: [{ kind: 'body', id: 'b', text: 'x' }] }] };
    const flex1 = JSON.stringify(buildModelToFlex(m));
    expect(flex1).toContain('"type":"bubble","size":"giga"');
    const back = flexToModel(flex1);
    expect(back).not.toBeNull();
    expect(back!.cards[0].size).toBe('giga');
    expect(JSON.stringify(buildModelToFlex(back!))).toBe(flex1);
  });

  it('GC-1: 不正な size はブロック / 正しい size は ok', () => {
    const mk = (size: string): BuilderModel => ({ cards: [{ id: 'c', size, parts: [{ kind: 'body', id: 'b', text: 'x' }] }] });
    expect(validateFlex(buildModelToFlex(mk('huge'))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(mk('mega'))).ok).toBe(true);
  });

  it('GC-2 lossless: header/footer/未知キー付き bubble は from-flex が null', () => {
    const withHeader = JSON.stringify({ type: 'bubble', header: { type: 'box', layout: 'vertical', contents: [] }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] } });
    expect(flexToModel(withHeader)).toBeNull();
    const withStyles = JSON.stringify({ type: 'bubble', styles: { body: { backgroundColor: '#fff' } }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] } });
    expect(flexToModel(withStyles)).toBeNull();
  });
});
