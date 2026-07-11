/**
 * T-D2 — formSyncBadge の優先順位 (drift_status × sync_status 2 軸を単一 badge に / plan §6b)。
 *   競合(conflict) > 更新あり(detected) > 未同期(out_of_sync) > 自動反映済(applied) > なし。
 */
import { describe, it, expect } from 'vitest'
import { formSyncBadge } from './formaloo-sync-badge'

describe('formSyncBadge — 優先順位', () => {
  it('drift なし + sync idle → badge なし', () => {
    expect(formSyncBadge({ driftStatus: 'none', syncStatus: 'idle' })).toBeNull()
    expect(formSyncBadge({ syncStatus: 'idle' })).toBeNull() // driftStatus 未露出は none 扱い
  })

  it("detected → 「更新あり (要確認)」", () => {
    expect(formSyncBadge({ driftStatus: 'detected', syncStatus: 'idle' })).toMatchObject({ label: '更新あり (要確認)', kind: 'update' })
  })

  it("conflict → 「競合 (要確認)」 (out_of_sync より優先)", () => {
    // conflict は sync_status=out_of_sync を伴うが conflict badge を優先 (両立時の矛盾回避)
    expect(formSyncBadge({ driftStatus: 'conflict', syncStatus: 'out_of_sync' })).toMatchObject({ label: '競合 (要確認)', kind: 'conflict' })
  })

  it("applied → 「自動反映しました」", () => {
    expect(formSyncBadge({ driftStatus: 'applied', syncStatus: 'idle' })).toMatchObject({ label: '自動反映しました', kind: 'applied' })
  })

  it('remote drift なし + local out_of_sync → 「未同期」', () => {
    expect(formSyncBadge({ driftStatus: 'none', syncStatus: 'out_of_sync' })).toMatchObject({ label: '未同期', kind: 'unsynced' })
  })

  it('優先順位: detected は out_of_sync より優先 (更新ありを表示)', () => {
    expect(formSyncBadge({ driftStatus: 'detected', syncStatus: 'out_of_sync' })).toMatchObject({ kind: 'update' })
  })
})
