/**
 * batch E — video Flex (hero video)。
 * 動画カード = bubble.hero に video。bubble.size は kilo/mega/giga 必須 (公式要件)。altContent 必須。
 *
 *   - round-trip: 動画 hero + size が to-flex→from-flex で出力安定
 *   - GC-1 fail-closed: altContent 欠落 / 非 https / 不正 aspectRatio / size 未指定を validateFlex がブロック
 *   - GC-2 lossless-only: video の未知キー / altContent が image 以外は from-flex が null
 *   - carousel に video を入れない
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel, BuilderCard } from './types';
import { buildModelToFlex } from './to-flex';
import { flexToModel } from './from-flex';
import { validateFlex } from './validate';

function roundTripsCard(card: BuilderCard): void {
  const model: BuilderModel = { cards: [card] };
  const flex1 = JSON.stringify(buildModelToFlex(model));
  const back = flexToModel(flex1);
  expect(back, `flexToModel returned null for ${flex1}`).not.toBeNull();
  expect(JSON.stringify(buildModelToFlex(back!))).toBe(flex1);
}

const videoCard = (extra: Record<string, unknown> = {}): BuilderCard => ({
  id: 'c', size: 'mega',
  hero: { kind: 'video', id: 'v', url: 'https://x/v.mp4', previewUrl: 'https://x/p.png', altUrl: 'https://x/alt.png', aspectRatio: '20:13', ...extra } as never,
  parts: [{ kind: 'body', id: 'b', text: '本文' }],
});

describe('batch E — video Flex round-trip', () => {
  it('動画 hero + size mega が round-trip', () => {
    roundTripsCard(videoCard());
  });
  it('body 無しの動画のみ bubble も round-trip', () => {
    roundTripsCard({ id: 'c', size: 'kilo', hero: { kind: 'video', id: 'v', url: 'https://x/v.mp4', previewUrl: 'https://x/p.png', altUrl: 'https://x/alt.png' } as never, parts: [] });
  });
  it('to-flex は hero に video + altContent(image) を出す', () => {
    const flex = JSON.parse(JSON.stringify(buildModelToFlex({ cards: [videoCard()] })));
    expect(flex.type).toBe('bubble');
    expect(flex.size).toBe('mega');
    expect(flex.hero.type).toBe('video');
    expect(flex.hero.url).toBe('https://x/v.mp4');
    expect(flex.hero.altContent.type).toBe('image');
    expect(flex.hero.altContent.url).toBe('https://x/alt.png');
  });
});

describe('batch E — GC-1 fail-closed', () => {
  it('正常な動画カードは ok:true', () => {
    expect(validateFlex(buildModelToFlex({ cards: [videoCard()] })).ok).toBe(true);
  });
  it('altUrl が空 (altContent 欠落) はブロック', () => {
    expect(validateFlex(buildModelToFlex({ cards: [videoCard({ altUrl: '' })] })).ok).toBe(false);
  });
  it('動画 url が https でないとブロック', () => {
    expect(validateFlex(buildModelToFlex({ cards: [videoCard({ url: 'http://x/v.mp4' })] })).ok).toBe(false);
  });
  it('previewUrl が https でないとブロック', () => {
    expect(validateFlex(buildModelToFlex({ cards: [videoCard({ previewUrl: 'ftp://x/p.png' })] })).ok).toBe(false);
  });
  it('不正な aspectRatio はブロック', () => {
    expect(validateFlex(buildModelToFlex({ cards: [videoCard({ aspectRatio: '20x13' })] })).ok).toBe(false);
  });
  it('video hero に size 未指定はブロック (kilo/mega/giga 必須)', () => {
    expect(validateFlex(buildModelToFlex({ cards: [videoCard({})].map((c) => ({ ...c, size: undefined })) })).ok).toBe(false);
  });
  it('video hero の size が nano/micro はブロック', () => {
    expect(validateFlex(buildModelToFlex({ cards: [{ ...videoCard(), size: 'nano' }] })).ok).toBe(false);
  });
  it('carousel に video hero を入れるとブロック', () => {
    const m: BuilderModel = { cards: [videoCard(), { id: 'c2', parts: [{ kind: 'body', id: 'b2', text: 'x' }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
});

describe('batch E — GC-2 lossless-only', () => {
  it('video に未知キーがあれば null', () => {
    const json = JSON.stringify({ type: 'bubble', size: 'mega', hero: { type: 'video', url: 'https://x/v.mp4', previewUrl: 'https://x/p.png', altContent: { type: 'image', url: 'https://x/alt.png', size: 'full', aspectMode: 'cover' }, loop: true }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('altContent が image 以外なら null (上級者 JSON へ)', () => {
    const json = JSON.stringify({ type: 'bubble', size: 'mega', hero: { type: 'video', url: 'https://x/v.mp4', previewUrl: 'https://x/p.png', altContent: { type: 'box', layout: 'vertical', contents: [] } }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] } });
    expect(flexToModel(json)).toBeNull();
  });
});
