/**
 * A/B テストの決定論的 audience 分割 + 比較・勝ち選定ロジック (F2 batch4 G1)。
 *
 * 純関数 (DB 非依存・送信しない)。分割は friend id の安定ハッシュ (FNV-1a 32bit) で決定論・重複なし。
 * 比較は broadcast_insights の open_rate/click_rate を variant 別に読み metric で勝ちを判定する
 * (同点は明示的に tie=true・winner=null / insight 未取得は dataPending=true = crons=[] dark 説明)。
 * 実 A/B 分割送信・勝ち全配信の実発火は route/owner 立会 gated (本 module は数を出すだけ)。
 */

/** FNV-1a 32bit ハッシュ (決定論・入力同一なら常に同値)。 */
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface AbSplitResult {
  /** variant ラベル → friend id 配列 (重複なし・1 friend は 1 variant のみ)。 */
  variants: Record<string, string[]>;
  /** variant ラベル → 件数。 */
  counts: Record<string, number>;
}

/**
 * audience を variant に決定論・重複なしで分割する。
 *  - 入力を dedup (同一 friend が両案に入らない)。
 *  - 各 friend を stableHash(id) % variants.length で割り当て (同一入力で再現)。
 */
export function splitAudience(friendIds: string[], variants: string[] = ['A', 'B']): AbSplitResult {
  if (variants.length < 2) throw new Error('A/B split requires at least 2 variants');
  const unique = [...new Set(friendIds)];
  const result: Record<string, string[]> = {};
  for (const v of variants) result[v] = [];
  for (const id of unique) {
    const idx = stableHash(id) % variants.length;
    result[variants[idx]].push(id);
  }
  const counts: Record<string, number> = {};
  for (const v of variants) counts[v] = result[v].length;
  return { variants: result, counts };
}

export type AbMetric = 'open_rate' | 'click_rate';

export interface VariantInsight {
  variant: string;
  broadcastId: string;
  openRate: number | null;
  clickRate: number | null;
}

export interface AbComparison {
  metric: AbMetric;
  variants: VariantInsight[];
  /** 勝ち variant ラベル (決定できた時のみ)。tie / dataPending 時は null。 */
  winner: string | null;
  /** 引き分け (最大値が複数 variant で並ぶ)。 */
  tie: boolean;
  /** insight 未取得 (metric 値が null) = 本番 crons=[] dark で populate されず「データ取得待ち」。 */
  dataPending: boolean;
}

/**
 * variant 別 insight を metric で比較し勝ちを判定する。
 *  - いずれかの metric 値が null → dataPending=true・winner=null (crons=[] 未 populate)。
 *  - 最大値が複数 variant で並ぶ → tie=true・winner=null (引き分けを明示)。
 *  - それ以外 → winner = 最大値の variant。
 */
export function decideWinner(insights: VariantInsight[], metric: AbMetric): AbComparison {
  const pick = (v: VariantInsight) => (metric === 'open_rate' ? v.openRate : v.clickRate);
  const anyPending = insights.length === 0 || insights.some((v) => pick(v) === null || pick(v) === undefined);
  if (anyPending) {
    return { metric, variants: insights, winner: null, tie: false, dataPending: true };
  }
  let max = -Infinity;
  for (const v of insights) max = Math.max(max, pick(v) as number);
  const top = insights.filter((v) => (pick(v) as number) === max);
  if (top.length !== 1) {
    return { metric, variants: insights, winner: null, tie: true, dataPending: false };
  }
  return { metric, variants: insights, winner: top[0].variant, tie: false, dataPending: false };
}
