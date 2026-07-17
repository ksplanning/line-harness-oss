import {
  DEFAULT_RATING_STAR_COLOR,
  isValidHexColor,
  ratingStarCss,
  mergeManagedCss,
  type FormDesign,
  type HarnessField,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// b1-field-polish — 星色 custom_css の push 合流 (meta PATCH body への rating-gated 注入)。
// -----------------------------------------------------------------------------
// spike 確定 (evidence/spike-results.md): rating 星は form custom_css で decouple 着色できる。
// formaloo-design.ts (本文 flat 7 色) は **一切不改変** (D-2)。星色は別キー disjoint の独立経路。
// 非破壊 merge のため push 前に現行 custom_css を GET し、foreign css を保持したまま managed block を合流する。
//   - rating field 無し → custom_css を触らない ({}を返す) = 既存フォーム byte 不変 / foreign 保持 (R-3)。
//   - ratingStarColor=null (明示クリア) → 注入しない ({})。
//   - GET 失敗 → 注入しない ({}) = foreign css の clobber を避ける honest fail-soft (次回保存で反映)。
// =============================================================================

function extractForm(data: unknown): Record<string, unknown> {
  const r = (data ?? {}) as Record<string, any>;
  return (r?.data?.form ?? r?.data ?? r?.form ?? {}) as Record<string, unknown>;
}

/**
 * rating field を含むフォームの meta PATCH body へ載せる `custom_css` を解決する (非破壊 merge)。
 * @returns `{ custom_css }` (注入時) or `{}` (rating 無 / 明示クリア / GET 失敗)。
 */
export async function resolveRatingStarCustomCss(
  client: FormalooClient,
  formalooSlug: string,
  fields: HarnessField[],
  design: FormDesign | undefined | null,
): Promise<{ custom_css?: string }> {
  const hasRating = fields.some((f) => f.type === 'rating');
  if (!hasRating) return {}; // 星無フォームは custom_css 不注入 = byte 不変・foreign 保持 (R-3)
  const raw = design?.ratingStarColor;
  if (raw === null) return {}; // 明示クリア = 注入なし (spec §3-1)
  // absent(undefined)/不正 → 既定黄 (OD-2・OD-4)。valid hex → その色。
  const color = isValidHexColor(raw) ? raw : DEFAULT_RATING_STAR_COLOR;
  const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
  if (!g.ok) return {}; // GET 失敗 = foreign clobber 回避で不注入 (honest fail-soft)
  const form = extractForm(g.data);
  const currentCss = typeof form.custom_css === 'string' ? form.custom_css : '';
  return { custom_css: mergeManagedCss(currentCss, ratingStarCss(color)) };
}
