/**
 * batch C-core (hero/header/footer editor logic) — bubble ブロックをビルダーで編集する純ロジック。
 * header/footer は body と同じ部品列操作 (region 指定)、hero は単一画像の付け外し。
 */
import { describe, it, expect } from 'vitest';
import type { BuilderModel } from './types';
import { addPart, movePart, removePart, updatePart, setHero, findPart } from './modal-logic';

const base = (): BuilderModel => ({ cards: [{ id: 'c', parts: [{ kind: 'body', id: 'b', text: '本文' }] }] });

describe('batch C-core blocks editor — header/footer は region 指定で編集', () => {
  it('header に部品を足すと card.header に入る (body は不変)', () => {
    const { model } = addPart(base(), 0, 'heading', undefined, 'header');
    expect(model.cards[0].header?.length).toBe(1);
    expect(model.cards[0].header?.[0].kind).toBe('heading');
    expect(model.cards[0].parts.length).toBe(1);
  });
  it('footer に部品を足すと card.footer に入る', () => {
    const { model } = addPart(base(), 0, 'button', undefined, 'footer');
    expect(model.cards[0].footer?.length).toBe(1);
    expect(model.cards[0].footer?.[0].kind).toBe('button');
  });
  it('header 内で並べ替え・削除・編集ができる', () => {
    let m = addPart(base(), 0, 'heading', undefined, 'header').model;
    m = addPart(m, 0, 'body', undefined, 'header').model;
    const ids = m.cards[0].header!.map((p) => p.id);
    m = movePart(m, 0, ids[1], 'up', 'header');
    expect(m.cards[0].header!.map((p) => p.id)).toEqual([ids[1], ids[0]]);
    m = updatePart(m, 0, ids[0], { text: '編集後' } as never, 'header');
    const edited = m.cards[0].header!.find((p) => p.id === ids[0]);
    expect(edited && edited.kind === 'heading' ? edited.text : '').toBe('編集後');
    m = removePart(m, 0, ids[1], 'header');
    expect(m.cards[0].header!.length).toBe(1);
  });
  it('header の最後の部品を消すと header は undefined になる (空配列を残さない)', () => {
    let m = addPart(base(), 0, 'heading', undefined, 'header').model;
    const id = m.cards[0].header![0].id;
    m = removePart(m, 0, id, 'header');
    expect(m.cards[0].header).toBeUndefined();
  });
});

describe('batch C-core blocks editor — hero (単一画像) の付け外し', () => {
  it('setHero で画像 hero を付けられる', () => {
    const m = setHero(base(), 0, { kind: 'image', id: 'hero', url: 'https://x/h.jpg', aspect: 'landscape', rounded: false });
    expect(m.cards[0].hero?.kind).toBe('image');
  });
  it('setHero(undefined) で hero を外せる', () => {
    let m = setHero(base(), 0, { kind: 'image', id: 'hero', url: 'https://x/h.jpg' });
    m = setHero(m, 0, undefined);
    expect(m.cards[0].hero).toBeUndefined();
  });
});

describe('batch C-core blocks editor — findPart は全ブロックを探す', () => {
  it('header/footer/hero の部品も見つかる', () => {
    let m = addPart(base(), 0, 'heading', undefined, 'header').model;
    m = addPart(m, 0, 'button', undefined, 'footer').model;
    m = setHero(m, 0, { kind: 'image', id: 'hero1', url: 'https://x/h.jpg' });
    const hid = m.cards[0].header![0].id;
    const fid = m.cards[0].footer![0].id;
    expect(findPart(m.cards[0], hid)?.kind).toBe('heading');
    expect(findPart(m.cards[0], fid)?.kind).toBe('button');
    expect(findPart(m.cards[0], 'hero1')?.kind).toBe('image');
    expect(findPart(m.cards[0], 'b')?.kind).toBe('body');
  });
});
