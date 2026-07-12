import type { DeliveryMode, ScenarioStep } from '@line-crm/shared'

/**
 * ステップの待機時間を日本語ラベルに整形する共有ユーティリティ。
 *
 * これらは元々 `scenarios/detail/scenario-detail-client.tsx` に module-private で
 * 定義されていた。フロー図ビュー（scenario-flow-view）でも同じ待機ラベルが要るため、
 * 「再発明しない・単一正本」原則（tasks T-A2 / plan §6-1）で本ファイルへ切り出した。
 * 挙動は verbatim（detail-client の既存表示は不変）。
 */

/** relative mode の delayMinutes を「N分後 / N時間後 / N日後」等に整形 */
export function formatDelay(minutes: number): string {
  if (minutes === 0) return '即時'
  if (minutes < 60) return `${minutes}分後`
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m === 0 ? `${h}時間後` : `${h}時間${m}分後`
  }
  const d = Math.floor(minutes / 1440)
  const remaining = minutes % 1440
  if (remaining === 0) return `${d}日後`
  const h = Math.floor(remaining / 60)
  return h > 0 ? `${d}日${h}時間後` : `${d}日${remaining}分後`
}

/** delivery_mode（relative / elapsed / absolute_time）に応じてステップの配信タイミングを整形 */
export function formatScheduleLabel(mode: DeliveryMode | undefined, step: ScenarioStep): string {
  const m = mode ?? 'relative'
  if (m === 'relative') return formatDelay(step.delayMinutes)
  if (m === 'elapsed') {
    const days = step.offsetDays ?? 0
    const mins = step.offsetMinutes ?? 0
    const h = Math.floor(mins / 60)
    const r = mins % 60
    if (days === 0 && mins === 0) return '即時 (購読開始)'
    const parts: string[] = []
    if (days > 0) parts.push(`${days}日`)
    if (h > 0) parts.push(`${h}時間`)
    if (r > 0) parts.push(`${r}分`)
    return `購読開始から${parts.join('')}後`
  }
  // absolute_time
  return `購読開始から${step.offsetDays ?? 0}日後の ${step.deliveryTime ?? '00:00'}`
}
