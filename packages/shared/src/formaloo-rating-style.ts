// =============================================================================
// b1-field-polish — 評価スター(rating 星)色の managed custom_css 生成 + 非破壊 merge。
// -----------------------------------------------------------------------------
// spike 確定 (evidence/spike-results.md): rating 星は field 色 prop を持たず、hosted は星を form text_color
//   (本文と coupling) で着色する。黄星=黄文字=白地不可読ゆえ text_color は使えない。**decouple 解 = form
//   `custom_css`** で星クラス (react-rater / nps-icon-star) のみを狙い撃つ (本文/入力欄は不変)。
// 生成物は必ず delimited managed block ゆえ、既存 (owner/他機能) custom_css を clobber せず非破壊 merge できる。
// CSS 注入防止: 埋め込む色は formalooColorToHex で正規化した #RRGGBB のみ (任意文字列を CSS へ通さない)。
// 🚩 fragility (受容リスク・spec §7): Formaloo hashed class の substring 狙いゆえ、Formaloo 再デプロイで class
//   改名時に星色が既定へ戻る (cosmetic 劣化・非破局)。最安定 substring を選択 + O-1 owner スモークで確認。
// =============================================================================

import { formalooColorToHex } from './form-design';

/** managed block の境界コメント (mergeManagedCss がこの範囲を検出して非破壊置換/除去する)。 */
export const RATING_STAR_CSS_START = '/* harness:rating-star:start */';
export const RATING_STAR_CSS_END = '/* harness:rating-star:end */';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// managed block + 隣接改行を 1 つ検出 (block を消しても foreign css の他行は無改変で残す)。
const MANAGED_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(RATING_STAR_CSS_START)}[\\s\\S]*?${escapeRegExp(RATING_STAR_CSS_END)}\\n*`,
  'g',
);

/**
 * 検証済 hex から星色 managed custom_css block を生成する (spike PASS の star クラス scope)。
 *  - `[class*="nps-icon-star"]` の stroke = 空星の outline を着色
 *  - `[class*="nps-notActive"]` の fill = transparent = 空星を hollow に
 *  - `[class*="nps-icon"][class*="--filled"]` の fill = 選択星を塗り着色
 *  - `.react-rater-star` の color = react-rater ウィジェットのフォールバック
 * **本文/入力欄/label には一切効かない** (decouple / R-4)。不正 hex は throw (CSS 注入防止)。
 */
export function ratingStarCss(hexColor: string): string {
  const hex = formalooColorToHex(hexColor);
  if (hex === null) throw new Error(`ratingStarCss: invalid hex color: ${String(hexColor)}`);
  return [
    RATING_STAR_CSS_START,
    `[class*="nps-icon-star"]{stroke:${hex} !important}`,
    `[class*="nps-notActive"]{fill:transparent !important}`,
    `[class*="nps-icon"][class*="--filled"]{fill:${hex} !important}`,
    `.react-rater-star{color:${hex} !important}`,
    RATING_STAR_CSS_END,
  ].join('\n');
}

/**
 * 既存 custom_css から旧 harness managed block を除去し、新 block を追記する非破壊 merge。
 *  - `block` = ratingStarCss(...) の生成物なら追記 (旧 block は置換されるので常に 1 つ)。
 *  - `block` = null なら managed block の除去のみ (foreign css は保持)。
 *  - foreign (owner/他機能) の custom_css は無改変で保持する (block の外は触らない)。
 */
export function mergeManagedCss(existingCss: string | null | undefined, block: string | null): string {
  const base = typeof existingCss === 'string' ? existingCss : '';
  const stripped = base.replace(MANAGED_BLOCK_RE, '\n').replace(/^\n+|\n+$/g, '');
  if (!block) return stripped;
  return stripped ? `${stripped}\n${block}` : block;
}
