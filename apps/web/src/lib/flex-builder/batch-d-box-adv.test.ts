/**
 * batch D (高度表現 part 2) — box の gradient 背景 + position/offset (絶対配置)。
 *
 *   - gradient: box.background.linearGradient (角度 + 2〜3 色)
 *   - position=absolute + offsetTop/Bottom/Start/End で重ね配置
 *   - round-trip / GC-1 fail-closed / GC-2 lossless
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

const boxWith = (extra: Record<string, unknown>): BuilderModel => ({
  cards: [{ id: 'c', parts: [{ kind: 'box', id: 'x', layout: 'vertical', contents: [{ kind: 'body', id: 'b', text: 'x' }], ...extra } as BuilderPart] }] },
);

describe('batch D — box gradient 背景', () => {
  it('2 色 gradient が round-trip', () => {
    roundTrips([{
      kind: 'box', id: 'g', layout: 'vertical',
      background: { type: 'linearGradient', angle: '90deg', startColor: '#06C755', endColor: '#03793C' },
      contents: [{ kind: 'body', id: 'b', text: 'x' }],
    }]);
  });
  it('3 色 (center) gradient が round-trip', () => {
    roundTrips([{
      kind: 'box', id: 'g', layout: 'vertical',
      background: { type: 'linearGradient', angle: '0deg', startColor: '#FFFFFF', centerColor: '#EEEEEE', centerPosition: '50%', endColor: '#CCCCCC' },
      contents: [{ kind: 'body', id: 'b', text: 'x' }],
    }]);
  });
  it('GC-1: 不正な gradient (角度/色) はブロック / 正常は ok', () => {
    expect(validateFlex(buildModelToFlex(boxWith({ background: { type: 'linearGradient', angle: '90', startColor: '#06C755', endColor: '#03793C' } }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(boxWith({ background: { type: 'linearGradient', angle: '90deg', startColor: 'green', endColor: '#03793C' } }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(boxWith({ background: { type: 'radialGradient', angle: '90deg', startColor: '#fff', endColor: '#000' } }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(boxWith({ background: { type: 'linearGradient', angle: '45deg', startColor: '#06C755', endColor: '#03793C' } }))).ok).toBe(true);
  });
  it('GC-2: gradient に未知キーがあれば null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'box', layout: 'vertical', background: { type: 'linearGradient', angle: '90deg', startColor: '#fff', endColor: '#000', foo: 1 }, contents: [{ type: 'text', text: 'x', wrap: true }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
});

describe('batch D — box position / offset', () => {
  it('absolute + offset が round-trip', () => {
    roundTrips([{
      kind: 'box', id: 'p', layout: 'vertical', position: 'absolute',
      offsetTop: '10px', offsetStart: '5px', offsetBottom: 'sm', offsetEnd: '0px',
      contents: [{ kind: 'body', id: 'b', text: 'x' }],
    }]);
  });
  it('GC-1: 不正な position/offset はブロック / 正常は ok', () => {
    expect(validateFlex(buildModelToFlex(boxWith({ position: 'floating' }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(boxWith({ position: 'absolute', offsetTop: 'far' }))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(boxWith({ position: 'relative', offsetTop: '10px' }))).ok).toBe(true);
  });
});
