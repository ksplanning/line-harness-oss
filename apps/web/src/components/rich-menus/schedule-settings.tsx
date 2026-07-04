'use client'

/**
 * G17 期間限定リッチメニュー 設定 UI (F2 batch4 T-C11)。開始/終了日時を設定する。
 * **自動切替は dark-ship** (owner 立会後に有効化) — その旨を amber で明示し運用者に誤解させない。
 * 破壊操作 (期間削除) は行内確認 (native confirm 禁止・E2E 非互換)。
 */
import { useState } from 'react'
import { api } from '@/lib/api'

/** ISO8601(+09:00) ↔ datetime-local ('YYYY-MM-DDTHH:mm') 変換。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  return iso.slice(0, 16) // 'YYYY-MM-DDTHH:mm'
}
function toIso(local: string): string | null {
  if (!local) return null
  return `${local}:00+09:00`
}

export default function ScheduleSettings({
  groupId, accountId, scheduleStart, scheduleEnd, onSaved,
}: {
  groupId: string
  accountId: string
  scheduleStart: string | null
  scheduleEnd: string | null
  onSaved?: () => void
}) {
  const [enabled, setEnabled] = useState<boolean>(!!(scheduleStart || scheduleEnd))
  const [start, setStart] = useState<string>(toLocalInput(scheduleStart))
  const [end, setEnd] = useState<string>(toLocalInput(scheduleEnd))
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const res = await api.richMenuGroups.updateSchedule(groupId, accountId, {
        scheduleStart: enabled ? toIso(start) : null,
        scheduleEnd: enabled ? toIso(end) : null,
      })
      if (!res.success) { setError(res.error ?? '保存に失敗しました'); return }
      onSaved?.()
    } finally { setSaving(false) }
  }

  const clearSchedule = async () => {
    setConfirmingDelete(false); setEnabled(false); setStart(''); setEnd('')
    setSaving(true)
    try {
      await api.richMenuGroups.updateSchedule(groupId, accountId, { scheduleStart: null, scheduleEnd: null })
      onSaved?.()
    } finally { setSaving(false) }
  }

  return (
    <div className="rounded-lg border border-gray-200 p-3 bg-white space-y-2">
      <label className="flex items-center gap-1 text-sm text-gray-700">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="期間限定にする" />
        期間限定にする
      </label>

      {enabled && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
            <label className="flex items-center gap-1">開始
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="開始日時" className="border border-gray-300 rounded px-2 py-1" />
            </label>
            <label className="flex items-center gap-1">終了
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="終了日時" className="border border-gray-300 rounded px-2 py-1" />
            </label>
          </div>
          <p className="text-xs text-gray-500">期間外は既定メニューに戻ります。</p>
        </div>
      )}

      {/* dark-ship 注記 (grandma 配慮): 設定はできるが今はまだ自動で切替わらない */}
      <p className="text-xs rounded px-2 py-1.5" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
        ⚠️ 自動切替は準備中です。今は期間を設定できますが、自動での切替は運用開始（owner 立会）後に有効になります。
      </p>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving} className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
          {saving ? '保存中...' : '保存'}
        </button>
        {(scheduleStart || scheduleEnd) && (
          confirmingDelete ? (
            <span className="text-xs flex items-center gap-1">
              期間を削除しますか？
              <button onClick={clearSchedule} className="px-2 py-1 rounded text-white" style={{ backgroundColor: '#DC2626' }}>はい</button>
              <button onClick={() => setConfirmingDelete(false)} className="px-2 py-1 rounded bg-gray-200 text-gray-700">いいえ</button>
            </span>
          ) : (
            <button onClick={() => setConfirmingDelete(true)} className="text-xs text-red-500 hover:text-red-700">期間を削除</button>
          )
        )}
      </div>
    </div>
  )
}

/** 一覧の「期間限定」バッジ判定 (schedule_start/end のどちらかがあれば期間限定)。 */
export function isScheduled(scheduleStart: string | null, scheduleEnd: string | null): boolean {
  return !!(scheduleStart || scheduleEnd)
}
