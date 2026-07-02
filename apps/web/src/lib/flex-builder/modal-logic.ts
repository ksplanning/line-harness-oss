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
  }
}

function replaceCard(model: BuilderModel, cardIndex: number, card: BuilderCard): BuilderModel {
  return { cards: model.cards.map((c, i) => (i === cardIndex ? card : c)) };
}

/** 指定カードの末尾に部品を追加し、新モデルと追加した部品 id を返す。 */
export function addPart(
  model: BuilderModel,
  cardIndex: number,
  kind: PartKind,
): { model: BuilderModel; partId: string } {
  const part = makePart(kind);
  const card = model.cards[cardIndex];
  const next = replaceCard(model, cardIndex, { ...card, parts: [...card.parts, part] });
  return { model: next, partId: part.id };
}

/** 部品を上/下に 1 つ移動 (先頭で up / 末尾で down は no-op)。 */
export function movePart(
  model: BuilderModel,
  cardIndex: number,
  partId: string,
  dir: 'up' | 'down',
): BuilderModel {
  const card = model.cards[cardIndex];
  const idx = card.parts.findIndex((p) => p.id === partId);
  if (idx < 0) return model;
  const target = dir === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= card.parts.length) return model;
  const parts = [...card.parts];
  [parts[idx], parts[target]] = [parts[target], parts[idx]];
  return replaceCard(model, cardIndex, { ...card, parts });
}

/** 部品を削除。 */
export function removePart(model: BuilderModel, cardIndex: number, partId: string): BuilderModel {
  const card = model.cards[cardIndex];
  return replaceCard(model, cardIndex, { ...card, parts: card.parts.filter((p) => p.id !== partId) });
}

/** 部品を編集 (id 一致を patch で更新)。 */
export function updatePart(
  model: BuilderModel,
  cardIndex: number,
  partId: string,
  patch: Partial<BuilderPart>,
): BuilderModel {
  const card = model.cards[cardIndex];
  return replaceCard(model, cardIndex, {
    ...card,
    parts: card.parts.map((p) => (p.id === partId ? ({ ...p, ...patch } as BuilderPart) : p)),
  });
}
