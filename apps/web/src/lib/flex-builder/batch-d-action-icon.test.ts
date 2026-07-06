/**
 * batch D (高度表現 part 1) — postback アクション + icon (baseline 装飾)。
 *
 *   - postback: ボタン/画像タップで data を送る (受信側は scope 外・payload 作成のみ)
 *   - icon: baseline box 用の小さな装飾画像
 *   - M-20 / round-trip / GC-1 fail-closed / GC-2 lossless を踏襲
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

describe('batch D — postback action', () => {
  it('postback つきボタンが round-trip (data / displayText)', () => {
    roundTrips([
      { kind: 'button', id: 'b1', label: '参加', style: 'primary', link: { type: 'postback', data: 'action=join&id=1', displayText: '参加します' } },
      { kind: 'button', id: 'b2', label: 'キャンセル', style: 'secondary', link: { type: 'postback', data: 'action=cancel' } },
    ]);
  });
  it('画像タップの postback も round-trip', () => {
    roundTrips([{ kind: 'image', id: 'i', url: 'https://x/a.png', aspect: 'square', rounded: false, tapLink: { type: 'postback', data: 'a=1' } }]);
  });
  it('GC-1: postback data が空はブロック / 正常は ok', () => {
    const mk = (data: string): BuilderModel => ({ cards: [{ id: 'c', parts: [{ kind: 'button', id: 'b', label: 'x', style: 'primary', link: { type: 'postback', data } }] }] });
    expect(validateFlex(buildModelToFlex(mk('   '))).ok).toBe(false);
    expect(validateFlex(buildModelToFlex(mk('action=ok'))).ok).toBe(true);
  });
  it('GC-1: postback data が長すぎ (>300) はブロック', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'button', id: 'b', label: 'x', style: 'primary', link: { type: 'postback', data: 'x'.repeat(301) } }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
  it('GC-2: postback に未知キー付き action → null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'postback', data: 'a=1', foo: 'x' } }] } });
    expect(flexToModel(json)).toBeNull();
  });
});

describe('batch D — icon (baseline 装飾)', () => {
  it('icon 部品が round-trip', () => {
    roundTrips([
      {
        kind: 'box', id: 'row', layout: 'baseline', contents: [
          { kind: 'icon', id: 'ic', url: 'https://x/star.png', size: 'sm' },
          { kind: 'body', id: 'b', text: '4.5' },
        ],
      },
    ]);
  });
  it('GC-1: icon の url が https でないとブロック / size 不正もブロック', () => {
    const bad1: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'icon', id: 'ic', url: 'http://x/s.png' }] }] };
    expect(validateFlex(buildModelToFlex(bad1)).ok).toBe(false);
    const bad2: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'icon', id: 'ic', url: 'https://x/s.png', size: 'huge' }] }] };
    expect(validateFlex(buildModelToFlex(bad2)).ok).toBe(false);
    const ok: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'icon', id: 'ic', url: 'https://x/s.png', size: 'md' }] }] };
    expect(validateFlex(buildModelToFlex(ok)).ok).toBe(true);
  });
  it('GC-2: icon に未知 prop → null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'baseline', contents: [{ type: 'icon', url: 'https://x/s.png', scaling: true }] } });
    expect(flexToModel(json)).toBeNull();
  });
});
