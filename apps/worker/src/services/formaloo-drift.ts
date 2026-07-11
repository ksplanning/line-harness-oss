// =============================================================================
// Formaloo 定義 drift の定期検知サービス (formaloo-auto-pull / owner 必須発注)
// -----------------------------------------------------------------------------
// 6h cron tick 内で、Formaloo 連携済み全 form の定義 fingerprint を baseline と比較し drift を検知。
// 安全な変更 (弱化 warnings ゼロ ∧ ローカル編集なし) は flag ON 時のみ自動反映 (D1 のみ / push しない)、
// 危険な変更 / ローカル競合 (out_of_sync) は通知のみ。API 失敗 form は baseline 不変で skip (fail-safe)。
//
// 設計原則 (spec §2-§4):
//  - fingerprint は raw Formaloo body を射影して算出 = field_map 非依存 (auto-apply churn で false re-fire しない)。
//  - auto-apply は saveFormalooDefinition (D1 のみ) だけ。pushDefinitionToFormaloo は import すらしない
//    (逆方向 push は excluded_scope / push ループ防止 = 構造的に呼べない)。
//  - out_of_sync (ローカル未 push 編集待機) は絶対に auto-apply しない (conflict_held / failure_observable の芯)。
//  - fail-safe: GET 失敗 / client 無 / read-shape 不一致 / 例外 の form は state 無書込で skip (baseline 不変)。
//  - dedup: 通知系は pending_remote_hash が前回と変わった時だけ履歴記録 (6h 毎の重複を防ぐ)。
// =============================================================================

/** drift 判定の 5 分岐 (+ bootstrap)。副作用なしの純関数が返す action。 */
export type DriftAction = 'bootstrapped' | 'none' | 'auto_applied' | 'notified' | 'conflict_held';

export interface DriftDecisionInput {
  /** formaloo_sync_state.remote_definition_hash (最後に合意した Formaloo 側 fingerprint / NULL=未 bootstrap)。 */
  baseline: string | null;
  /** 今回 GET した Formaloo 定義の fingerprint。 */
  fingerprint: string;
  /** 弱化 warnings (複合ロジック) を伴う定義か (countWeakenedFormalooRules>0)。 */
  weakened: boolean;
  /** 現在の sync_status (out_of_sync = ローカル未 push 編集待機 = 競合)。 */
  syncStatus: string;
  /** FORMALOO_DRIFT_AUTO_APPLY flag (案 A=ON / 案 B=OFF)。 */
  autoApplyEnabled: boolean;
}

/**
 * 純粋な drift 判定器 (副作用なし)。以下の優先順で action を決める:
 *   1. baseline 無 → bootstrapped (前状態を知らない → 現状を基準採用・発火しない fail-safe)。
 *   2. fingerprint == baseline → none (drift なし)。
 *   3. drift かつ out_of_sync → conflict_held (ローカル編集を黙って上書きしない = 最優先の安全ガード)。
 *   4. drift かつ weakened → notified (弱化は flag に依らず自動反映しない = 分岐ロジック欠落防止)。
 *   5. drift かつ clean かつ autoApply ON → auto_applied。
 *   6. drift かつ clean かつ autoApply OFF → notified (案 B 既定)。
 */
export function decideDriftAction(i: DriftDecisionInput): DriftAction {
  if (i.baseline == null) return 'bootstrapped';
  if (i.fingerprint === i.baseline) return 'none';
  if (i.syncStatus === 'out_of_sync') return 'conflict_held';
  if (i.weakened) return 'notified';
  return i.autoApplyEnabled ? 'auto_applied' : 'notified';
}
