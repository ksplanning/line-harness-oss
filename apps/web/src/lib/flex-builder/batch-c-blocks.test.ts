/**
 * batch C-core (structure / hero・header・footer) — bubble のブロック拡張。
 * hero(一番上の大きな画像/box) / header(上の帯) / footer(下のボタン帯) を builder が生成・復元する。
 *
 *   - M-20 後方互換: hero/header/footer 未指定の既存 flat model は旧出力バイト等価
 *   - M-18 round-trip: hero/header/footer つき bubble が to-flex→from-flex で出力安定
 *   - GC-1 fail-closed: header/footer 内の不正な部品値は validateFlex がブロック
 *   - GC-2 lossless-only: styles/未知キー付き bubble・横並び header は from-flex が null
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
  const flex2 = JSON.stringify(buildModelToFlex(back!));
  expect(flex2).toBe(flex1);
}

describe('batch C-core blocks — M-20 後方互換 (hero/header/footer 未指定は旧出力バイト等価)', () => {
  it('body のみの card は不変', () => {
    const model: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'body', id: 'b', text: 'x' }] }] };
    expect(JSON.stringify(buildModelToFlex(model))).toBe(JSON.stringify({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [{ type: 'text', text: 'x', wrap: true }] },
    }));
  });
});

describe('batch C-core blocks — round-trip', () => {
  it('hero (画像) つき bubble が round-trip', () => {
    roundTripsCard({
      id: 'c',
      hero: { kind: 'image', id: 'hero', url: 'https://x/hero.jpg', aspect: 'landscape', rounded: false },
      parts: [{ kind: 'heading', id: 'h', text: 'タイトル' }],
    });
  });
  it('header (上の帯) つき bubble が round-trip', () => {
    roundTripsCard({
      id: 'c',
      header: [{ kind: 'heading', id: 'hh', text: 'お知らせ' }],
      parts: [{ kind: 'body', id: 'b', text: '本文' }],
    });
  });
  it('footer (下のボタン帯) つき bubble が round-trip', () => {
    roundTripsCard({
      id: 'c',
      parts: [{ kind: 'body', id: 'b', text: '本文' }],
      footer: [{ kind: 'button', id: 'ft', label: '予約', style: 'primary', link: { type: 'url', uri: 'https://x/b' } }],
    });
  });
  it('hero + header + footer + size 全部入り bubble が round-trip', () => {
    roundTripsCard({
      id: 'c', size: 'mega',
      hero: { kind: 'image', id: 'hero', url: 'https://x/hero.jpg', aspect: 'square', rounded: true },
      header: [{ kind: 'heading', id: 'hh', text: '見出し' }],
      parts: [
        { kind: 'body', id: 'b', text: '本文' },
        { kind: 'box', id: 'row', layout: 'horizontal', contents: [{ kind: 'body', id: 'l', text: '左' }, { kind: 'body', id: 'r', text: '右' }] },
      ],
      footer: [{ kind: 'button', id: 'ft', label: '予約', style: 'primary', link: { type: 'url', uri: 'https://x/b' } }],
    });
  });
  it('hero-only bubble (body 空) も round-trip (中身が hero だけ)', () => {
    roundTripsCard({
      id: 'c',
      hero: { kind: 'image', id: 'hero', url: 'https://x/hero.jpg', aspect: 'landscape', rounded: false },
      parts: [],
    });
  });
});

describe('batch C-core blocks — GC-1 fail-closed (header/footer 内の不正値をブロック)', () => {
  it('footer 内ボタンの不正リンクはブロック', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'body', id: 'b', text: 'x' }], footer: [{ kind: 'button', id: 'ft', label: 'x', style: 'primary', link: { type: 'url', uri: 'javascript:alert(1)' } }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
  it('header 内 text の不正装飾はブロック', () => {
    const m: BuilderModel = { cards: [{ id: 'c', parts: [{ kind: 'body', id: 'b', text: 'x' }], header: [{ kind: 'heading', id: 'hh', text: 'x', color: 'red' }] }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(false);
  });
  it('正常な hero/header/footer は ok:true', () => {
    const m: BuilderModel = { cards: [{
      id: 'c',
      hero: { kind: 'image', id: 'hero', url: 'https://x/hero.jpg' },
      header: [{ kind: 'heading', id: 'hh', text: 'お知らせ' }],
      parts: [{ kind: 'body', id: 'b', text: '本文' }],
      footer: [{ kind: 'button', id: 'ft', label: '予約', style: 'primary', link: { type: 'url', uri: 'https://x/b' } }],
    }] };
    expect(validateFlex(buildModelToFlex(m)).ok).toBe(true);
  });
});

describe('batch C-core blocks — GC-2 lossless-only', () => {
  it('styles 付き bubble は null (batch D 範囲 / 上級者 JSON へ)', () => {
    const json = JSON.stringify({ type: 'bubble', styles: { body: { backgroundColor: '#fff' } }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x', wrap: true }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('背景色つき header (簡易 header の範囲外) は null', () => {
    const json = JSON.stringify({ type: 'bubble', header: { type: 'box', layout: 'vertical', backgroundColor: '#fff', contents: [{ type: 'text', text: 'H', wrap: true }] }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'B', wrap: true }] } });
    expect(flexToModel(json)).toBeNull();
  });
  it('正常な hero/header/footer bubble は round-trip 可 (null にならない)', () => {
    const json = JSON.stringify({ type: 'bubble', header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'H', wrap: true }] }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'B', wrap: true }] } });
    expect(flexToModel(json)).not.toBeNull();
  });
});
