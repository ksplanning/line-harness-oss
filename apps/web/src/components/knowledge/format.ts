/**
 * B-5 (T-E1/T-E4) — 資料管理 / AI ログ・コスト UI の**純関数**表示ロジック (component から分離して単体テスト可能に)。
 * chrome MCP wedge で visual-qa 封印のため、表示ロジックは純関数化して web vitest で担保する (§9-2)。
 */
import { KnowledgeExtractError } from '@/lib/knowledge-extract';

// 運用上限 (env AI_DAILY_NEURON_BUDGET_GLOBAL 既定 = runtime.ts:58 DEFAULT_DAILY_NEURON_BUDGET_GLOBAL)。
export const AI_OPERATIONAL_CAP = 9000;
// Cloudflare Workers AI の 1 日無料枠 (account 全体で共有)。
export const AI_FREE_TIER_CAP = 10000;

export type EmbedStatusKind = 'none' | 'unembedded' | 'partial' | 'done';
export interface EmbedStatus {
  kind: EmbedStatusKind;
  label: string;
}

/**
 * chunk 総数 / embed 済数から embed 状態ラベルを導出 (資料一覧の状態列 / §9-2)。
 *  - chunk 0        → 未取込
 *  - embed 済 0     → 未embed (意味検索は未設定 = Vectorize 未 provisioning or 予算 defer)
 *  - 一部 embed     → embed済 X/Y
 *  - 全 embed       → embed済 Y/Y
 */
export function deriveEmbedStatus(s: { chunkCount: number; embeddedCount: number }): EmbedStatus {
  const chunk = Math.max(0, s.chunkCount);
  const embedded = Math.max(0, Math.min(s.embeddedCount, chunk));
  if (chunk === 0) return { kind: 'none', label: '未取込' };
  if (embedded === 0) return { kind: 'unembedded', label: '未embed（意味検索は未設定）' };
  if (embedded >= chunk) return { kind: 'done', label: `embed済 ${embedded}/${chunk}` };
  return { kind: 'partial', label: `embed済 ${embedded}/${chunk}` };
}

/** 使用量 vs 上限の % (0..100・小数第1位)。上限 0 は 0% (0 除算回避)。 */
export function headroomPercent(used: number, cap: number): number {
  if (cap <= 0) return 0;
  const pct = (used / cap) * 100;
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
}

export interface UsageBar {
  name: string;
  used: number;
  cap: number;
  percent: number;
  label: string;
}

/** headroom バー 1 本の表示データ (運用上限 9,000 / 無料枠 10,000 を別々に出す / §4-2・H-2)。 */
export function formatUsageBar(used: number, cap: number, name: string): UsageBar {
  const percent = headroomPercent(used, cap);
  return {
    name,
    used,
    cap,
    percent,
    label: `${name}: ${used.toLocaleString('ja-JP')} / ${cap.toLocaleString('ja-JP')} neuron（${percent}%）`,
  };
}

/** 1 日行の合算 neuron (llm + embed + image)。 */
export function sumNeurons(row: { llmNeurons: number; embedNeurons: number; imageNeurons: number }): number {
  return (row.llmNeurons || 0) + (row.embedNeurons || 0) + (row.imageNeurons || 0);
}

/**
 * Vectorize stored dims の**下限推定** (embed 済 chunk 数 × 埋込次元)。次元は provisioning 後に確定するため、
 * 未設定 (0/undefined) のときは「未計測」を返す (実値 vs 推定を混同しない / §4-4・H-3)。
 */
export function formatStoredDimsEstimate(embeddedChunks: number, dimension: number | null | undefined): string {
  if (!dimension || dimension <= 0) return '未計測（Vectorize 未設定）';
  const estimate = embeddedChunks * dimension;
  return `推定 ${estimate.toLocaleString('ja-JP')} / 5,000,000`;
}

/** upload 抽出エラー → owner 向け日本語文言 (KnowledgeExtractError は理由別の message を持つ / §9-2)。 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof KnowledgeExtractError) return err.message;
  return 'ファイルの取り込みに失敗しました。もう一度お試しください。';
}
