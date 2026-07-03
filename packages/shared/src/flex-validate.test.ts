/**
 * validateFlex 純関数テスト (shared 側 / batch2 移設)。
 *
 * 保存前に LINE 制約違反をブロックし、日本語エラーを返すゲート。
 * shared は buildModelToFlex (web-UI 専用) に依存できないため、bare FlexContents を
 * 直接組み立てて検証する (web 側 validate.test.ts はビルダー経由で別途カバー継続)。
 */
import { describe, test, expect } from 'vitest';
import { validateFlex } from './flex-validate';
import type { FlexContents, FlexBubble, FlexNode } from './flex-types';
import { MAX_CAROUSEL_BUBBLES, MAX_TEXT_LENGTH, MAX_ALT_TEXT_LENGTH } from './flex-constants';

function bubbleWith(nodes: FlexNode[]): FlexContents {
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: nodes },
  };
}

function makeCarousel(n: number): FlexContents {
  const bubble: FlexBubble = {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] },
  };
  return { type: 'carousel', contents: Array.from({ length: n }, () => bubble) };
}

describe('validateFlex (shared)', () => {
  test('正常な bubble は ok:true', () => {
    const r = validateFlex(bubbleWith([{ type: 'text', text: 'こんにちは', wrap: true }]));
    expect(r.ok).toBe(true);
  });

  test('空 contents (body 空) は ok:false + 日本語エラー', () => {
    const r = validateFlex(bubbleWith([]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].messageJa).toMatch(/中身|部品|足して/);
    expect(r.errors[0].messageJa).not.toMatch(/[a-zA-Z]{4,}/); // 英語専門語を出さない
  });

  test('http:// 画像URL は ok:false', () => {
    const r = validateFlex(bubbleWith([{ type: 'image', url: 'http://ex.com/a.jpg' }]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'image_not_https')).toBe(true);
  });

  test('https:// 画像URL は許可', () => {
    const r = validateFlex(bubbleWith([{ type: 'image', url: 'https://ex.com/a.jpg' }]));
    expect(r.ok).toBe(true);
  });

  test('境界値: carousel bubble 数 = 上限 (12) は ok', () => {
    expect(validateFlex(makeCarousel(MAX_CAROUSEL_BUBBLES)).ok).toBe(true);
  });

  test('境界値: carousel bubble 数 = 上限+1 (13) は ok:false', () => {
    const r = validateFlex(makeCarousel(MAX_CAROUSEL_BUBBLES + 1));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'carousel_too_many')).toBe(true);
  });

  test('境界値: text 文字数 = 上限 (2000) は ok', () => {
    const r = validateFlex(bubbleWith([{ type: 'text', text: 'あ'.repeat(MAX_TEXT_LENGTH), wrap: true }]));
    expect(r.ok).toBe(true);
  });

  test('境界値: text 文字数 = 上限+1 (2001) は ok:false', () => {
    const r = validateFlex(bubbleWith([{ type: 'text', text: 'あ'.repeat(MAX_TEXT_LENGTH + 1), wrap: true }]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'text_too_long')).toBe(true);
  });

  test('空文字の text は ok:false', () => {
    const r = validateFlex(bubbleWith([{ type: 'text', text: '', wrap: true }]));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'text_empty')).toBe(true);
  });

  test('altText 上限超過 (明示 altText) は ok:false', () => {
    const r = validateFlex(bubbleWith([{ type: 'text', text: 'x', wrap: true }]), {
      altText: 'あ'.repeat(MAX_ALT_TEXT_LENGTH + 1),
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'alt_text_too_long')).toBe(true);
  });

  test('境界値: altText = 上限 (400) は ok', () => {
    const r = validateFlex(bubbleWith([{ type: 'text', text: 'x', wrap: true }]), {
      altText: 'あ'.repeat(MAX_ALT_TEXT_LENGTH),
    });
    expect(r.ok).toBe(true);
  });

  test('0 カード (空 carousel) は ok:false', () => {
    expect(validateFlex({ type: 'carousel', contents: [] }).ok).toBe(false);
  });

  test('エラー messageJa は日本語の依頼形 (責めない)', () => {
    const r = validateFlex(bubbleWith([]));
    if (r.ok) throw new Error();
    expect(r.errors[0].messageJa).toMatch(/ください|しましょう|です/);
  });
});

/**
 * H1: action.uri 検証。空/スキーム無し/javascript:/data:/http: は保存ブロック。https: と tel: のみ許可。
 */
describe('validateFlex action.uri (H1 / shared)', () => {
  function buttonWithUri(uri: string): FlexContents {
    return {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: '押す', uri } }],
      },
    };
  }
  function imageTapUri(uri: string): FlexContents {
    return {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'image', url: 'https://ex.com/a.jpg', action: { type: 'uri', uri } }],
      },
    };
  }

  test('https ボタンリンクは ok', () => {
    expect(validateFlex(buttonWithUri('https://ex.com/go')).ok).toBe(true);
  });

  test('tel ボタンリンクは ok (電話)', () => {
    expect(validateFlex(buttonWithUri('tel:09012345678')).ok).toBe(true);
  });

  test('空 uri は ok:false', () => {
    const r = validateFlex(buttonWithUri(''));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'link_empty')).toBe(true);
  });

  test('スキーム無し (相対/裸文字列) は ok:false', () => {
    expect(validateFlex(buttonWithUri('example.com/go')).ok).toBe(false);
    expect(validateFlex(buttonWithUri('/relative/path')).ok).toBe(false);
  });

  test('javascript: は ok:false (XSS 系スキーム拒否)', () => {
    const r = validateFlex(buttonWithUri('javascript:alert(1)'));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'link_bad_scheme')).toBe(true);
  });

  test('data: は ok:false', () => {
    expect(validateFlex(buttonWithUri('data:text/html,<h1>x</h1>')).ok).toBe(false);
  });

  test('http: は ok:false (https 必須)', () => {
    const r = validateFlex(buttonWithUri('http://ex.com/go'));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.errors.some((e) => e.code === 'link_bad_scheme')).toBe(true);
  });

  test('制御文字/改行を含む uri は ok:false', () => {
    expect(validateFlex(buttonWithUri('https://ex.com/\n go')).ok).toBe(false);
    expect(validateFlex(buttonWithUri('https://ex.com/ ')).ok).toBe(false);
  });

  test('画像タップリンクも同じ検証: https ok / javascript: fail', () => {
    expect(validateFlex(imageTapUri('https://ex.com/lp')).ok).toBe(true);
    expect(validateFlex(imageTapUri('javascript:alert(1)')).ok).toBe(false);
  });
});
