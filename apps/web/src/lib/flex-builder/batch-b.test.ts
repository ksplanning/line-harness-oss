/**
 * batch B (Flex 装飾拡張) — text 色/整列/サイズ/装飾/lineSpacing/maxLines・image サイズ/整列・
 * button 高さ/message action・separator 色/margin の round-trip + fail-closed + 後方互換。
 *
 *   - M-20 後方互換: 装飾未指定の既存6部品は旧出力とバイト等価
 *   - M-18 round-trip: 装飾つき部品が to-flex→from-flex で同一 model に戻る
 *   - GC-1 fail-closed: 不正な装飾値は validateFlex がブロック
 *   - GC-2 lossless-only: model が表現できない prop を持つ node は from-flex が null (上級者 JSON へ)
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel, BuilderPart } from './types';
import { buildModelToFlex } from './to-flex';
import { flexToModel } from './from-flex';
import { validateFlex } from './validate';

/**
 * round-trip の正しい不変量 = **出力安定性**: model → flex1 → model2 → flex2 で flex1 === flex2。
 * (装飾が1つでも落ちれば flex2 が変わり検知できる。既定値の model 差 = heading size 'lg' 等には
 *  惑わされない = 実運用で重要な「保存→開く→保存で Flex が壊れない/変わらない」を直接固定する。)
 */
function roundTrips(parts: BuilderPart[]): void {
  const model: BuilderModel = { cards: [{ id: 'c', parts }] };
  const flex1 = JSON.stringify(buildModelToFlex(model));
  const back = flexToModel(flex1);
  expect(back, `flexToModel returned null for ${flex1}`).not.toBeNull();
  const flex2 = JSON.stringify(buildModelToFlex(back!));
  expect(flex2).toBe(flex1);
}

describe('batch B — M-20 後方互換 (装飾未指定 = 旧出力バイト等価)', () => {
  it('装飾なし heading/body/image/button/separator/spacer が旧 JSON と等価', () => {
    const model: BuilderModel = {
      cards: [{
        id: 'c', parts: [
          { kind: 'heading', id: 'h', text: '見出し' },
          { kind: 'body', id: 'b', text: '本文' },
          { kind: 'image', id: 'i', url: 'https://x/a.png', aspect: 'landscape', rounded: true },
          { kind: 'button', id: 'bt', label: '予約', style: 'primary', link: { type: 'url', uri: 'https://x/booking' } },
          { kind: 'separator', id: 's' },
          { kind: 'spacer', id: 'sp' },
        ],
      }],
    };
    const out = JSON.stringify(buildModelToFlex(model));
    // 旧 to-flex が出していた形と一致 (装飾キーが一切増えていない)。
    expect(out).toBe(JSON.stringify({
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '見出し', wrap: true, weight: 'bold', size: 'lg' },
          { type: 'text', text: '本文', wrap: true },
          { type: 'image', url: 'https://x/a.png', size: 'full', aspectMode: 'cover', aspectRatio: '20:13', cornerRadius: '8px' },
          { type: 'button', style: 'primary', action: { type: 'uri', label: '予約', uri: 'https://x/booking' } },
          { type: 'separator' },
          { type: 'spacer', size: 'md' },
        ],
      },
    }));
  });
});

describe('batch B — round-trip (装飾つき)', () => {
  it('text 装飾 (色/整列/装飾/サイズ/lineSpacing/maxLines/margin)', () => {
    roundTrips([
      { kind: 'heading', id: 'h', text: '見出し', color: '#06C755', align: 'center', size: 'xxl', margin: 'lg' },
      { kind: 'body', id: 'b', text: '本文', color: '#333333', align: 'end', decoration: 'underline', lineSpacing: '10px', maxLines: 3, margin: 'sm' },
    ]);
  });
  it('image サイズ/整列/margin', () => {
    roundTrips([{ kind: 'image', id: 'i', url: 'https://x/a.png', aspect: 'square', rounded: true, size: 'md', align: 'center', margin: 'md' }]);
  });
  it('button 高さ/整列/margin + message action', () => {
    roundTrips([
      { kind: 'button', id: 'b1', label: 'はい', style: 'primary', link: { type: 'message', text: '参加します' }, height: 'sm', align: 'center', margin: 'md' },
      { kind: 'button', id: 'b2', label: '電話', style: 'secondary', link: { type: 'tel', phone: '0312345678', uri: 'tel:0312345678' } },
    ]);
  });
  it('separator 色/margin', () => {
    roundTrips([
      { kind: 'heading', id: 'h', text: 'x' },
      { kind: 'separator', id: 's', color: '#E0E0E0', margin: 'xl' },
    ]);
  });
});

describe('batch B — GC-1 fail-closed (validateFlex が不正値をブロック)', () => {
  const oneText = (extra: Partial<BuilderPart>): BuilderModel => ({
    cards: [{ id: 'c', parts: [{ kind: 'body', id: 'b', text: 'x', ...extra } as BuilderPart] }],
  });
  it('不正な色/整列/装飾/サイズ/margin は ok:false', () => {
    for (const bad of [
      { color: 'red' }, { color: '#12' }, { align: 'middle' }, { decoration: 'blink' },
      { size: 'huge' }, { lineSpacing: '10' }, { maxLines: -1 }, { margin: 'huge' },
    ]) {
      const r = validateFlex(buildModelToFlex(oneText(bad)));
      expect(r.ok, `expected fail for ${JSON.stringify(bad)}`).toBe(false);
    }
  });
  it('正しい装飾値は ok:true', () => {
    const r = validateFlex(buildModelToFlex(oneText({ color: '#06C755', align: 'center', decoration: 'underline', size: 'xl', lineSpacing: '12px', maxLines: 2, margin: 'md' })));
    expect(r.ok).toBe(true);
  });
  it('message action の空文字はブロック', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'button', id: 'b', label: 'x', style: 'primary', link: { type: 'message', text: '  ' } }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
  it('button の不正 height はブロック', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'button', id: 'b', label: 'x', style: 'primary', link: { type: 'url', uri: 'https://x' }, height: 'tall' }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
});

describe('batch B — GC-2 lossless-only (未知 prop を持つ node は from-flex が null)', () => {
  it('text に未知 prop (gravity) → null (上級者 JSON へ)', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true, gravity: 'center' }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('image の aspectMode が cover 以外 → null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'image', url: 'https://x/a.png', aspectMode: 'fit' }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('span に未知キーを含む text (contents) → null (batch D で span 自体は対応)', () => {
    // batch D: 正常な span は richtext として復元 (別 test)。span の未知キーは lossless 不可 → null。
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', wrap: true, contents: [{ type: 'span', text: 'x', foo: 1 }] }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('action に未知 prop → null', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', action: { type: 'uri', uri: 'https://x', altUri: 'x' } }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('装飾つき正常 Flex は round-trip 可 (null にならない)', () => {
    const json = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [{ type: 'text', text: 'x', wrap: true, color: '#06C755', align: 'center' }] } });
    expect(flexToModel(json)).not.toBeNull();
  });
});
