/**
 * 画像リッチ化テスト (T-A7 の土台 / plan 判断A)。
 */
import { describe, test, expect } from 'vitest';
import { imageLinkToFlexJson, detectImageLinkFlex } from './image-link';
import { validateFlex } from './validate';
import { unwrapFlexMessageObject } from '@worker/message-build';
import type { LinkSpec } from './types';

describe('imageLinkToFlexJson', () => {
  test('画像 URL + リンクで hero image bubble を作り buildMessage を通る', () => {
    const link: LinkSpec = { type: 'url', uri: 'https://ex.com/lp' };
    const json = imageLinkToFlexJson('https://ex.com/hero.jpg', link);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('bubble');
    // 実物 worker unwrap を通る (contract)
    expect(() => unwrapFlexMessageObject(parsed)).not.toThrow();
    // https 画像なので validate.ok
    expect(validateFlex(parsed).ok).toBe(true);
  });

  test('リンク空でも画像だけの Flex を作れる (tapLink なし)', () => {
    const json = imageLinkToFlexJson('https://ex.com/a.jpg', { type: 'url', uri: '' });
    const parsed = JSON.parse(json);
    const img = parsed.body.contents[0];
    expect(img.type).toBe('image');
    expect(img.action).toBeUndefined();
  });

  test('http 画像は validate.fail (保存前ゲートで捕捉)', () => {
    const json = imageLinkToFlexJson('http://ex.com/a.jpg', { type: 'url', uri: 'https://ex.com/lp' });
    expect(validateFlex(JSON.parse(json)).ok).toBe(false);
  });
});

describe('detectImageLinkFlex (再編集の復元)', () => {
  test('画像リンク Flex から url と link を復元', () => {
    const link: LinkSpec = { type: 'url', uri: 'https://ex.com/lp' };
    const json = imageLinkToFlexJson('https://ex.com/hero.jpg', link);
    const detected = detectImageLinkFlex(json);
    expect(detected).not.toBeNull();
    expect(detected!.url).toBe('https://ex.com/hero.jpg');
    expect(detected!.link).toEqual(link);
  });

  test('複数部品の bubble は画像リンク Flex ではない → null', () => {
    const flex = {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'image', url: 'https://ex.com/a.jpg' },
          { type: 'text', text: '文章' },
        ],
      },
    };
    expect(detectImageLinkFlex(JSON.stringify(flex))).toBeNull();
  });

  test('carousel は画像リンク Flex ではない → null', () => {
    const flex = {
      type: 'carousel',
      contents: [{ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'image', url: 'https://ex.com/a.jpg' }] } }],
    };
    expect(detectImageLinkFlex(JSON.stringify(flex))).toBeNull();
  });
});
