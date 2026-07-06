/**
 * from-flex 逆変換テスト (ui-design §11 / plan 判断A ②)。
 * 再編集で保存済み Flex を開き直せること + 範囲外は null (上級者経路フォールバック) を担保。
 */
import { describe, test, expect } from 'vitest';
import { flexToModel } from './from-flex';
import { buildModelToFlex } from './to-flex';
import { validateFlex } from './validate';
import { NAIL_TEMPLATES } from './templates';
import type { BuilderModel } from './types';

function roundTrip(model: BuilderModel): string {
  const json = JSON.stringify(buildModelToFlex(model));
  const back = flexToModel(json);
  if (!back) throw new Error('flexToModel returned null');
  return JSON.stringify(buildModelToFlex(back));
}

describe('flexToModel 逆変換 (再編集)', () => {
  test('bubble ラウンドトリップ: model→flex→model→flex が一致', () => {
    const model: BuilderModel = {
      cards: [
        {
          id: 'c',
          parts: [
            { kind: 'heading', id: 'h', text: '見出し' },
            { kind: 'body', id: 'b', text: '本文です' },
            { kind: 'separator', id: 's' },
            {
              kind: 'button',
              id: 'btn',
              label: '予約',
              style: 'primary',
              link: { type: 'url', uri: 'https://ex.com/go' },
            },
          ],
        },
      ],
    };
    const original = JSON.stringify(buildModelToFlex(model));
    expect(roundTrip(model)).toBe(original);
  });

  test('carousel ラウンドトリップ', () => {
    const model: BuilderModel = {
      cards: [
        { id: 'a', parts: [{ kind: 'body', id: 'p1', text: 'A' }] },
        { id: 'b', parts: [{ kind: 'body', id: 'p2', text: 'B' }] },
      ],
    };
    const original = JSON.stringify(buildModelToFlex(model));
    expect(roundTrip(model)).toBe(original);
  });

  test('plan 判断A ②: hero-only bubble (画像リンク付き) を image 部品 + tapLink に復元', () => {
    const model: BuilderModel = {
      cards: [
        {
          id: 'c',
          parts: [
            {
              kind: 'image',
              id: 'img',
              url: 'https://ex.com/hero.jpg',
              aspect: 'landscape',
              rounded: true,
              tapLink: { type: 'url', uri: 'https://ex.com/lp' },
            },
          ],
        },
      ],
    };
    // hero-only bubble を表す flex (画像 1 枚だけ) — buildModelToFlex は body に image を入れる
    const json = JSON.stringify(buildModelToFlex(model));
    const back = flexToModel(json);
    expect(back).not.toBeNull()
    const part = back!.cards[0].parts[0]
    expect(part.kind).toBe('image')
    if (part.kind !== 'image') throw new Error()
    expect(part.url).toBe('https://ex.com/hero.jpg')
    expect(part.tapLink).toEqual({ type: 'url', uri: 'https://ex.com/lp' })
  });

  test('真の hero フィールドを持つ bubble も復元できる (worker が hero を使う形)', () => {
    const flex = {
      type: 'bubble',
      hero: {
        type: 'image',
        url: 'https://ex.com/hero.jpg',
        size: 'full',
        aspectMode: 'cover',
        action: { type: 'uri', uri: 'https://ex.com/lp' },
      },
    };
    const back = flexToModel(JSON.stringify(flex));
    expect(back).not.toBeNull();
    expect(back!.cards[0].parts[0].kind).toBe('image');
  });

  test('tel action は tel 種別に復元', () => {
    const model: BuilderModel = {
      cards: [
        {
          id: 'c',
          parts: [
            { kind: 'button', id: 'b', label: '電話', style: 'secondary', link: { type: 'tel', phone: '0312345678', uri: 'tel:0312345678' } },
          ],
        },
      ],
    };
    const back = flexToModel(JSON.stringify(buildModelToFlex(model)));
    const part = back!.cards[0].parts[0];
    if (part.kind !== 'button') throw new Error();
    expect(part.link.type).toBe('tel');
  });

  test('範囲外 (header 使用) は null → 上級者経路フォールバック', () => {
    const flex = {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'H' }] },
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'B' }] },
    };
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  // batch C-core: ネストした box は対応集合に緩和 (T-C1)。子 box が復元でき round-trip する。
  test('ネストした box は復元でき、box 部品として round-trip する', () => {
    const flex = {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'x' }] }],
      },
    };
    const back = flexToModel(JSON.stringify(flex));
    expect(back).not.toBeNull();
    expect(back!.cards[0].parts[0].kind).toBe('box');
  });

  test('範囲外 (横並び body) は null', () => {
    const flex = {
      type: 'bubble',
      body: { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'x' }] },
    };
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('壊れた JSON は null', () => {
    expect(flexToModel('壊れた{')).toBeNull();
  });

  // H2: body.contents が配列でない (文字列/オブジェクト/数値) 場合に for-of で TypeError クラッシュしない。
  // 上級者が壊れた JSON を貼り「カードを編集」で開いても null 返し (上級者 JSON 誘導) で UI が落ちない。
  test('H2: body.contents が文字列の bubble は null (TypeError で落ちない)', () => {
    const flex = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: 'not-an-array' } };
    expect(() => flexToModel(JSON.stringify(flex))).not.toThrow();
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('H2: body.contents がオブジェクトの bubble は null', () => {
    const flex = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: { type: 'text', text: 'x' } } };
    expect(() => flexToModel(JSON.stringify(flex))).not.toThrow();
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('H2: body.contents が数値の bubble は null', () => {
    const flex = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: 5 } };
    expect(() => flexToModel(JSON.stringify(flex))).not.toThrow();
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('H2: body.contents 内の child が非オブジェクト (文字列) でも落ちず null', () => {
    const flex = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: ['just a string', { type: 'text', text: 'x' }] } };
    expect(() => flexToModel(JSON.stringify(flex))).not.toThrow();
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('H2: carousel の bubble contents が非配列でも落ちず null', () => {
    const flex = { type: 'carousel', contents: 'nope' };
    expect(() => flexToModel(JSON.stringify(flex))).not.toThrow();
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('H2: 上限超え carousel (13 bubbles) は null (cap)', () => {
    const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x' }] } };
    const flex = { type: 'carousel', contents: Array.from({ length: 13 }, () => bubble) };
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('H2: carousel の要素が非オブジェクトでも落ちず null', () => {
    const flex = { type: 'carousel', contents: ['x', { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'y' }] } }] };
    expect(() => flexToModel(JSON.stringify(flex))).not.toThrow();
    expect(flexToModel(JSON.stringify(flex))).toBeNull();
  });

  test('3 テンプレはすべて逆変換でき、再変換が validate.ok', () => {
    for (const tpl of NAIL_TEMPLATES) {
      const json = JSON.stringify(buildModelToFlex(tpl.model));
      const back = flexToModel(json);
      expect(back).not.toBeNull();
      expect(validateFlex(buildModelToFlex(back!)).ok).toBe(true);
    }
  });
});
