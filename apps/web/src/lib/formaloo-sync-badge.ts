// =============================================================================
// formaloo-auto-pull: sync/drift 単一 badge の決定 (純 UI ロジック / api.ts 非依存)。
// -----------------------------------------------------------------------------
// drift_status (pull 軸) と sync_status (push 軸) は直交する 2 軸だが、UI は矛盾表示を避け単一 badge を
// 優先順位で決める (plan §6b / self-check finding #4):
//   競合(conflict) > 更新あり(detected) > 未同期(out_of_sync) > 自動反映済(applied) > なし。
// page.tsx (一覧) / builder.tsx (エディタ) で同一関数を使い優先順位を固定する。
// ※ fetch client (api.ts) を import しない純関数モジュール = pure component (builder) から安全に使える。
// =============================================================================

/** 単一 sync/drift badge の種別と表示。 */
export interface FormSyncBadge {
  label: string
  kind: 'conflict' | 'update' | 'unsynced' | 'applied'
  /** 文字色 (tailwind)。競合=赤 / 更新あり=琥珀 / 未同期=琥珀 / 自動反映=緑。 */
  className: string
}

export function formSyncBadge(form: { driftStatus?: string | null; syncStatus: string }): FormSyncBadge | null {
  const drift = form.driftStatus ?? 'none'
  if (drift === 'conflict') return { label: '競合 (要確認)', kind: 'conflict', className: 'text-red-600' }
  if (drift === 'detected') return { label: '更新あり (要確認)', kind: 'update', className: 'text-amber-600' }
  if (form.syncStatus === 'out_of_sync') return { label: '未同期', kind: 'unsynced', className: 'text-amber-600' }
  if (drift === 'applied') return { label: '自動反映しました', kind: 'applied', className: 'text-emerald-600' }
  return null
}
