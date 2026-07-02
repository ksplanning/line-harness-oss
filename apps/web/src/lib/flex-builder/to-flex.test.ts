/**
 * buildModelToFlex 純関数テスト (TDD の核 / D-1, D-2 + tapLink)。
 * プレビューと保存で同一出力を使うため、この変換規則が全ての土台。
 */
import { describe, test, expect } from 'vitest';
import { buildModelToFlex } from './to-flex';
import type { BuilderModel } from './types';

function card(parts: BuilderModel['cards'][number]['parts']) {
  return { id: 'c1', parts };
}

describe('buildModelToFlex', () => {
  test('D-1: 1 カードは bubble を返す (body は vertical box)', () => {
    const model: BuilderModel = {
      cards: [card([{ kind: 'heading', id: 'p1', text: '春の新色' }])],
    };
    const out = buildModelToFlex(model);
    expect(out.type).toBe('bubble');
    if (out.type !== 'bubble') throw new Error('expected bubble');
    expect(out.body?.type).toBe('box');
    expect(out.body?.layout).toBe('vertical');
    expect(out.body?.contents.length).toBe(1);
    expect(out.body?.contents[0]).toMatchObject({ type: 'text', text: '春の新色' });
  });

  test('D-2: 2 カード以上は carousel を返し contents.length が cards 数と一致', () => {
    const model: BuilderModel = {
      cards: [
        { id: 'a', parts: [{ kind: 'body', id: 'p1', text: 'カード1' }] },
        { id: 'b', parts: [{ kind: 'body', id: 'p2', text: 'カード2' }] },
        { id: 'c', parts: [{ kind: 'body', id: 'p3', text: 'カード3' }] },
      ],
    };
    const out = buildModelToFlex(model);
    expect(out.type).toBe('carousel');
    if (out.type !== 'carousel') throw new Error('expected carousel');
    expect(out.contents.length).toBe(3);
    expect(out.contents.every((b) => b.type === 'bubble')).toBe(true);
  });

  test('heading → text weight bold', () => {
    const out = buildModelToFlex({ cards: [card([{ kind: 'heading', id: 'p', text: 'H' }])] });
    if (out.type !== 'bubble') throw new Error();
    expect(out.body?.contents[0]).toMatchObject({ type: 'text', text: 'H', weight: 'bold' });
  });

  test('body → text wrap true (改行される本文)', () => {
    const out = buildModelToFlex({ cards: [card([{ kind: 'body', id: 'p', text: 'B' }])] });
    if (out.type !== 'bubble') throw new Error();
    expect(out.body?.contents[0]).toMatchObject({ type: 'text', text: 'B', wrap: true });
  });

  test('image (tapLink なし) → image node に action が付かない', () => {
    const out = buildModelToFlex({
      cards: [card([{ kind: 'image', id: 'p', url: 'https://ex.com/a.jpg' }])],
    });
    if (out.type !== 'bubble') throw new Error();
    const img = out.body?.contents[0];
    expect(img).toMatchObject({ type: 'image', url: 'https://ex.com/a.jpg', aspectMode: 'cover' });
    expect((img as { action?: unknown }).action).toBeUndefined();
  });

  test('image (tapLink あり) → image node に action:{type:uri,uri} が付く', () => {
    const out = buildModelToFlex({
      cards: [
        card([
          {
            kind: 'image',
            id: 'p',
            url: 'https://ex.com/a.jpg',
            tapLink: { type: 'url', uri: 'https://ex.com/go' },
          },
        ]),
      ],
    });
    if (out.type !== 'bubble') throw new Error();
    expect(out.body?.contents[0]).toMatchObject({
      type: 'image',
      action: { type: 'uri', uri: 'https://ex.com/go' },
    });
  });

  test('button → action.label にラベルが入る (FlexPreview は action.label を読む)', () => {
    const out = buildModelToFlex({
      cards: [
        card([
          {
            kind: 'button',
            id: 'p',
            label: '予約する',
            style: 'primary',
            link: { type: 'url', uri: 'https://ex.com/book' },
          },
        ]),
      ],
    });
    if (out.type !== 'bubble') throw new Error();
    expect(out.body?.contents[0]).toMatchObject({
      type: 'button',
      style: 'primary',
      action: { type: 'uri', label: '予約する', uri: 'https://ex.com/book' },
    });
  });

  test('button tel → action.uri は tel:...', () => {
    const out = buildModelToFlex({
      cards: [
        card([
          {
            kind: 'button',
            id: 'p',
            label: '電話',
            style: 'secondary',
            link: { type: 'tel', phone: '09012345678', uri: 'tel:09012345678' },
          },
        ]),
      ],
    });
    if (out.type !== 'bubble') throw new Error();
    expect((out.body?.contents[0] as { action: { uri: string } }).action.uri).toBe('tel:09012345678');
  });

  test('separator / spacer → 対応 node', () => {
    const out = buildModelToFlex({
      cards: [card([{ kind: 'separator', id: 's' }, { kind: 'spacer', id: 'sp', size: 'md' }])],
    });
    if (out.type !== 'bubble') throw new Error();
    expect(out.body?.contents[0]).toMatchObject({ type: 'separator' });
    expect(out.body?.contents[1]).toMatchObject({ type: 'spacer', size: 'md' });
  });

  test('絶対に message object でラップしない (top-level type は bubble/carousel のみ)', () => {
    const out = buildModelToFlex({ cards: [card([{ kind: 'body', id: 'p', text: 'x' }])] });
    expect((out as { altText?: string }).altText).toBeUndefined();
    expect(out.type === 'bubble' || out.type === 'carousel').toBe(true);
  });
});
