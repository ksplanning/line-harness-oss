/**
 * validateFlex 純関数テスト (D-3 / 境界値必須)。
 * 保存前に LINE 制約違反をブロックし、日本語エラーを返すゲート。
 */
import { describe, test, expect } from 'vitest';
import { validateFlex } from './validate';
import { buildModelToFlex } from './to-flex';
import type { BuilderModel, FlexContents, FlexBubble } from './types';
import { MAX_CAROUSEL_BUBBLES, MAX_TEXT_LENGTH, MAX_ALT_TEXT_LENGTH } from './constants';

function bubbleWith(parts: BuilderModel['cards'][number]['parts']): FlexContents {
  return buildModelToFlex({ cards: [{ id: 'c', parts }] });
}

function makeCarousel(n: number): FlexContents {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] },
  };
  return { type: 'carousel', contents: Array.from({ length: n }, () => bubble) };
}

describe('validateFlex', () => {
  test('正常な bubble は ok:true', () => {
    const r = validateFlex(bubbleWith([{ kind: 'body', id: 'p', text: 'こんにちは' }]));
    expect(r.ok).toBe(true);
  });

  test('D-3: 空 contents (parts ゼロ) は ok:false + 日本語エラー', () => {
    const r = validateFlex(bubbleWith([]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].messageJa).toMatch(/中身|部品|足して/);
    expect(r.errors[0].messageJa).not.toMatch(/[a-zA-Z]{4,}/); // 英語専門語を出さない (おばあちゃん基準)
  });

  test('D-3: http:// 画像URL は ok:false', () => {
    const r = validateFlex(
      bubbleWith([{ kind: 'image', id: 'p', url: 'http://ex.com/a.jpg' }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'image_not_https')).toBe(true);
  });

  test('D-3: https:// 画像URL は許可', () => {
    const r = validateFlex(bubbleWith([{ kind: 'image', id: 'p', url: 'https://ex.com/a.jpg' }]));
    expect(r.ok).toBe(true);
  });

  test('D-3 境界値: carousel bubble 数 = 上限 (12) は ok', () => {
    const r = validateFlex(makeCarousel(MAX_CAROUSEL_BUBBLES));
    expect(r.ok).toBe(true);
  });

  test('D-3 境界値: carousel bubble 数 = 上限+1 (13) は ok:false', () => {
    const r = validateFlex(makeCarousel(MAX_CAROUSEL_BUBBLES + 1));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'carousel_too_many')).toBe(true);
  });

  test('D-3 境界値: text 文字数 = 上限 (2000) は ok', () => {
    const r = validateFlex(bubbleWith([{ kind: 'body', id: 'p', text: 'あ'.repeat(MAX_TEXT_LENGTH) }]));
    expect(r.ok).toBe(true);
  });

  test('D-3 境界値: text 文字数 = 上限+1 (2001) は ok:false', () => {
    const r = validateFlex(
      bubbleWith([{ kind: 'body', id: 'p', text: 'あ'.repeat(MAX_TEXT_LENGTH + 1) }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'text_too_long')).toBe(true);
  });

  test('D-3: 空文字の text は ok:false (空の見出し/本文)', () => {
    const r = validateFlex(bubbleWith([{ kind: 'heading', id: 'p', text: '' }]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'text_empty')).toBe(true);
  });

  test('D-3: altText 上限超過 (明示 altText を渡した場合) は ok:false', () => {
    const r = validateFlex(bubbleWith([{ kind: 'body', id: 'p', text: 'x' }]), {
      altText: 'あ'.repeat(MAX_ALT_TEXT_LENGTH + 1),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'alt_text_too_long')).toBe(true);
  });

  test('D-3 境界値: altText = 上限 (400) は ok', () => {
    const r = validateFlex(bubbleWith([{ kind: 'body', id: 'p', text: 'x' }]), {
      altText: 'あ'.repeat(MAX_ALT_TEXT_LENGTH),
    });
    expect(r.ok).toBe(true);
  });

  test('D-3: 0 カード (contents 空 carousel) は ok:false', () => {
    const r = validateFlex({ type: 'carousel', contents: [] });
    expect(r.ok).toBe(false);
  });

  test('エラー messageJa は必ず日本語の依頼形 (責めない)', () => {
    const r = validateFlex(bubbleWith([]));
    if (r.ok) throw new Error();
    expect(r.errors[0].messageJa).toMatch(/ください|しましょう|です/);
  });
});
