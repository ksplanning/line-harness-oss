/**
 * ビルダーモーダルの純ロジック (UI から分離してテスト可能に)。
 *
 * WHY: このリポの vitest は node 環境 (jsdom なし)。DOM レンダーテストの前例もない。
 *   よってモーダルの意思決定 (isDirty / requestClose の confirm 要否 / 各操作後の
 *   プレビュー JSON 変化) を純関数として切り出し、node で単体テストする。
 *   aria/sticky/class などの静的 DOM 属性は C8 の browser-evaluator E2E で実機確認する
 *   (リポ既存の「純ロジック vitest + 実機 E2E」方針に一致)。
 */
import type { BuilderModel, BuilderCard, BuilderPart, PartKind } from './types';
import { buildModelToFlex } from './to-flex';
import { nextId } from './templates';

/** 起動時スナップショットと現在モデルが異なれば dirty (テンプレ選択後 1 手でも動かしたら true)。 */
export function isModelDirty(snapshot: BuilderModel, current: BuilderModel): boolean {
  return JSON.stringify(snapshot) !== JSON.stringify(current);
}

/**
 * 閉じ操作 (✕/Esc/キャンセル) 時に window.confirm を出すべきか。
 * saving 中は閉じない (false)。dirty のときだけ confirm を要求する。
 */
export function shouldConfirmClose(opts: { isDirty: boolean; saving: boolean }): {
  canClose: boolean;
  needsConfirm: boolean;
} {
  if (opts.saving) return { canClose: false, needsConfirm: false };
  return { canClose: true, needsConfirm: opts.isDirty };
}

/** ビルダー内で表示するプレビュー用 JSON 文字列 (プレビュー=保存の単一経路)。 */
export function previewJson(model: BuilderModel): string {
  return JSON.stringify(buildModelToFlex(model));
}

/** 空部品を kind から生成 (追加時)。 */
export function makePart(kind: PartKind): BuilderPart {
  const id = nextId('part');
  switch (kind) {
    case 'heading':
      return { kind: 'heading', id, text: '見出しを入力' };
    case 'body':
      return { kind: 'body', id, text: '本文を入力' };
    case 'image':
      return { kind: 'image', id, url: '', aspect: 'original', rounded: false };
    case 'button':
      return { kind: 'button', id, label: 'ボタン', style: 'primary', link: { type: 'url', uri: '' } };
    case 'separator':
      return { kind: 'separator', id };
    case 'spacer':
      return { kind: 'spacer', id, size: 'md' };
    case 'box':
      // 既定は「よこに並べる箱」= 空の横並び。子部品は後から足す (batch C-core)。
      return { kind: 'box', id, layout: 'horizontal', contents: [] };
    case 'icon':
      // baseline box 用の小さな装飾画像 (batch D)。
      return { kind: 'icon', id, url: '', size: 'md' };
  }
}

// ---- ブロック region (batch C-core: body / header / footer) ----

/** 部品列ブロック。body=本体 / header=上の帯 / footer=下のボタン帯 (hero は単一のため別扱い)。 */
export type Region = 'body' | 'header' | 'footer';

/** card の指定 region の部品列を取り出す (未設定は空配列)。 */
function cardRegion(card: BuilderCard, region: Region): BuilderPart[] {
  if (region === 'header') return card.header ?? [];
  if (region === 'footer') return card.footer ?? [];
  return card.parts;
}

/** card の指定 region に部品列を書き戻す (header/footer は空なら undefined = 空配列を残さない)。 */
function withRegion(card: BuilderCard, region: Region, parts: BuilderPart[]): BuilderCard {
  if (region === 'header') return { ...card, header: parts.length ? parts : undefined };
  if (region === 'footer') return { ...card, footer: parts.length ? parts : undefined };
  return { ...card, parts };
}

// ---- ネスト対応のツリー走査 (batch C-core: box の子も辿る純関数群) ----

/** card の全ブロック (body/header/footer/hero) から partId を探す (box.contents も再帰)。 */
export function findPart(card: BuilderCard, partId: string): BuilderPart | null {
  const roots: BuilderPart[] = [...card.parts, ...(card.header ?? []), ...(card.footer ?? [])];
  if (card.hero) roots.push(card.hero);
  return findPartDeep(roots, partId);
}
function findPartDeep(parts: BuilderPart[], partId: string): BuilderPart | null {
  for (const p of parts) {
    if (p.id === partId) return p;
    if (p.kind === 'box') {
      const found = findPartDeep(p.contents, partId);
      if (found) return found;
    }
  }
  return null;
}

/** partId を patch で更新 (ツリー全体を再帰)。 */
function updatePartDeep(parts: BuilderPart[], partId: string, patch: Partial<BuilderPart>): BuilderPart[] {
  return parts.map((p) => {
    if (p.id === partId) return { ...p, ...patch } as BuilderPart;
    if (p.kind === 'box') return { ...p, contents: updatePartDeep(p.contents, partId, patch) };
    return p;
  });
}

/** partId を削除 (ツリー全体を再帰)。 */
function removePartDeep(parts: BuilderPart[], partId: string): BuilderPart[] {
  return parts
    .filter((p) => p.id !== partId)
    .map((p) => (p.kind === 'box' ? { ...p, contents: removePartDeep(p.contents, partId) } : p));
}

/**
 * partId を持つ兄弟配列内で up/down にずらす (ツリー全体を再帰)。
 * partId が見つかった階層だけで入れ替え、親の外へは飛び出さない。
 * @returns changed=partId を含む階層に到達したか (端で no-op でも true)。
 */
function movePartDeep(parts: BuilderPart[], partId: string, dir: 'up' | 'down'): { changed: boolean; parts: BuilderPart[] } {
  const idx = parts.findIndex((p) => p.id === partId);
  if (idx >= 0) {
    const target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= parts.length) return { changed: true, parts };
    const next = [...parts];
    [next[idx], next[target]] = [next[target], next[idx]];
    return { changed: true, parts: next };
  }
  let changed = false;
  const next = parts.map((p) => {
    if (changed || p.kind !== 'box') return p;
    const r = movePartDeep(p.contents, partId, dir);
    if (r.changed) {
      changed = true;
      return { ...p, contents: r.parts };
    }
    return p;
  });
  return { changed, parts: next };
}

/** box (id=boxId) の contents 末尾に part を足す (ツリー全体を再帰)。 */
function addToBoxDeep(parts: BuilderPart[], boxId: string, part: BuilderPart): { added: boolean; parts: BuilderPart[] } {
  let added = false;
  const next = parts.map((p) => {
    if (added || p.kind !== 'box') return p;
    if (p.id === boxId) {
      added = true;
      return { ...p, contents: [...p.contents, part] };
    }
    const r = addToBoxDeep(p.contents, boxId, part);
    if (r.added) {
      added = true;
      return { ...p, contents: r.parts };
    }
    return p;
  });
  return { added, parts: next };
}

function replaceCard(model: BuilderModel, cardIndex: number, card: BuilderCard): BuilderModel {
  return { cards: model.cards.map((c, i) => (i === cardIndex ? card : c)) };
}

/**
 * 部品を追加し、新モデルと追加した部品 id を返す。
 * parentBoxId を渡すとその box の子として末尾に足す (batch C-core / ネスト)。
 * region で body/header/footer を選ぶ (未指定は body)。
 */
export function addPart(
  model: BuilderModel,
  cardIndex: number,
  kind: PartKind,
  parentBoxId?: string,
  region: Region = 'body',
): { model: BuilderModel; partId: string } {
  const part = makePart(kind);
  const card = model.cards[cardIndex];
  const parts = cardRegion(card, region);
  if (parentBoxId) {
    const r = addToBoxDeep(parts, parentBoxId, part);
    // 目的の box が見つからなければ安全側で末尾に足す (UI 不整合でも部品が消えない)。
    const next = r.added ? r.parts : [...parts, part];
    return { model: replaceCard(model, cardIndex, withRegion(card, region, next)), partId: part.id };
  }
  const next = replaceCard(model, cardIndex, withRegion(card, region, [...parts, part]));
  return { model: next, partId: part.id };
}

/** 部品を上/下に 1 つ移動 (ネスト内でも動く / 先頭で up・末尾で down は no-op)。 */
export function movePart(
  model: BuilderModel,
  cardIndex: number,
  partId: string,
  dir: 'up' | 'down',
  region: Region = 'body',
): BuilderModel {
  const card = model.cards[cardIndex];
  const r = movePartDeep(cardRegion(card, region), partId, dir);
  if (!r.changed) return model;
  return replaceCard(model, cardIndex, withRegion(card, region, r.parts));
}

/** 部品を削除 (ネスト対応)。 */
export function removePart(
  model: BuilderModel,
  cardIndex: number,
  partId: string,
  region: Region = 'body',
): BuilderModel {
  const card = model.cards[cardIndex];
  return replaceCard(model, cardIndex, withRegion(card, region, removePartDeep(cardRegion(card, region), partId)));
}

/** 部品を編集 (id 一致を patch で更新 / ネスト対応)。 */
export function updatePart(
  model: BuilderModel,
  cardIndex: number,
  partId: string,
  patch: Partial<BuilderPart>,
  region: Region = 'body',
): BuilderModel {
  const card = model.cards[cardIndex];
  return replaceCard(model, cardIndex, withRegion(card, region, updatePartDeep(cardRegion(card, region), partId, patch)));
}

/** hero (一番上の大きな画像/box) を設定/解除する (単一部品 / batch C-core)。 */
export function setHero(model: BuilderModel, cardIndex: number, hero: BuilderPart | undefined): BuilderModel {
  const card = model.cards[cardIndex];
  return replaceCard(model, cardIndex, { ...card, hero });
}

// ---- カード操作 (カルーセル / D-13) ----

/** parts を deep-clone し新 id を振る (カード複製で id 衝突を防ぐ / box 子も再帰的に再 id)。 */
function cloneParts(parts: BuilderPart[]): BuilderPart[] {
  return parts.map((p) =>
    p.kind === 'box'
      ? { ...p, id: nextId('part'), contents: cloneParts(p.contents) }
      : { ...p, id: nextId('part') },
  );
}

/**
 * 指定カードを複製して末尾に足す (bubble→carousel 化 = D-13)。
 * 複製元をコピーする (白紙より運用者に優しい / すぐ中身が見える)。
 * @returns 新モデルと、追加した新カードの index。
 */
export function duplicateCard(
  model: BuilderModel,
  cardIndex: number,
): { model: BuilderModel; newIndex: number } {
  const src = model.cards[cardIndex];
  const copy: BuilderCard = { id: nextId('card'), parts: cloneParts(src.parts) };
  return { model: { cards: [...model.cards, copy] }, newIndex: model.cards.length };
}

/** カードを左右に移動 (carousel 内の順序入替 / 先頭で left / 末尾で right は no-op)。 */
export function moveCard(model: BuilderModel, cardIndex: number, dir: 'left' | 'right'): BuilderModel {
  const target = dir === 'left' ? cardIndex - 1 : cardIndex + 1;
  if (target < 0 || target >= model.cards.length) return model;
  const cards = [...model.cards];
  [cards[cardIndex], cards[target]] = [cards[target], cards[cardIndex]];
  return { cards };
}

/** カードを削除 (最後の 1 枚は消せない = カード 0 枚を作らせない)。 */
export function removeCard(model: BuilderModel, cardIndex: number): BuilderModel {
  if (model.cards.length <= 1) return model;
  return { cards: model.cards.filter((_, i) => i !== cardIndex) };
}
