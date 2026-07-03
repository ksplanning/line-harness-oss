'use client'

import { useEffect, useState } from 'react'
import { api, type DayHours, type OutsideHoursMode } from '@/lib/api'

interface Props {
  accountId: string
  onClose: () => void
}

// 表示は月〜日。内部 day index は getUTCDay 準拠 (0=日..6=土) で shared 判定と一致させる。
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DAY_LABEL: Record<number, string> = { 0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土' }

type Row = { day: number; closed: boolean; open: string; close: string }

function initialRows(saved: DayHours[]): Row[] {
  const byDay = new Map(saved.map((e) => [e.day, e]))
  return DAY_ORDER.map((day) => {
    const e = byDay.get(day)
    return {
      day,
      closed: e ? e.closed : false,
      open: e && e.open ? e.open : '09:00',
      close: e && e.close ? e.close : '18:00',
    }
  })
}

/** 深夜跨ぎ (終了 < 開始) 判定。'HH:MM' を分に。 */
function toMin(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):[0-5]\d$/.exec(hhmm)
  if (!m) return null
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
}
function isOvernight(row: Row): boolean {
  const o = toMin(row.open)
  const c = toMin(row.close)
  return o !== null && c !== null && o > c
}

/** 「いまの動き」自然文 (grandma が 1 行で挙動を理解できることがゴール)。 */
function buildSummary(rows: Row[], mode: OutsideHoursMode): string {
  const openRows = rows.filter((r) => !r.closed && toMin(r.open) !== null && toMin(r.close) !== null)
  let hoursPart: string
  if (openRows.length === 0) {
    hoursPart = '営業日が設定されていません'
  } else {
    // 同じ営業時間の曜日をまとめる。
    const groups = new Map<string, number[]>()
    for (const r of openRows) {
      const key = `${r.open}〜${r.close}`
      const arr = groups.get(key) ?? []
      arr.push(r.day)
      groups.set(key, arr)
    }
    hoursPart = Array.from(groups.entries())
      .map(([hours, days]) => `${days.map((d) => DAY_LABEL[d]).join('・')} ${hours}`)
      .join(' / ') + ' はスタッフが対応（自動応答はお休み）'
  }
  const outside =
    mode === 'away_message'
      ? 'それ以外の時間は『不在メッセージ』を返します。'
      : mode === 'none'
      ? 'それ以外の時間は自動では返信せず、スタッフが対応します。'
      : 'それ以外の時間は、いつもの自動応答を返します。'
  return `${hoursPart}。${outside}`
}

export default function ResponseScheduleModal({ accountId, onClose }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [isEnabled, setIsEnabled] = useState(false)
  const [mode, setMode] = useState<OutsideHoursMode>('auto_reply')
  const [awayMessage, setAwayMessage] = useState('')
  const [rows, setRows] = useState<Row[]>(initialRows([]))

  // 背景スクロールロック + Esc で閉じる (既存モーダル流儀 + grandma 向け)。
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  useEffect(() => {
    let alive = true
    api.responseSchedules
      .get(accountId)
      .then((res) => {
        if (!alive) return
        const d = res.data
        setIsEnabled(d.isEnabled)
        setMode(d.outsideHoursMode)
        setAwayMessage(d.awayMessage ?? '')
        setRows(initialRows(d.weeklyHours))
      })
      .catch(() => {
        if (alive) setError('読み込みに失敗しました')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [accountId])

  const updateRow = (day: number, partial: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.day === day ? { ...r, ...partial } : r)))

  // client 検証 (server と二重): away は文面必須 / 営業日は開始終了が埋まっていること。
  const awayMissing = mode === 'away_message' && awayMessage.trim() === ''
  const timeMissing = rows.some((r) => !r.closed && (toMin(r.open) === null || toMin(r.close) === null))
  const canSave = !saving && !awayMissing && !timeMissing

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    setError('')
    const weeklyHours: DayHours[] = rows.map((r) => ({
      day: r.day,
      closed: r.closed,
      open: r.closed ? '' : r.open,
      close: r.closed ? '' : r.close,
    }))
    try {
      const res = await api.responseSchedules.save({
        accountId,
        isEnabled,
        outsideHoursMode: mode,
        awayMessage: mode === 'away_message' ? awayMessage.trim() : null,
        weeklyHours,
      })
      if (res.success) {
        onClose()
      } else {
        setError(res.error || '保存に失敗しました')
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900">応答時間帯の設定</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-xs text-gray-500">
            営業時間内はスタッフが対応し、時間外は自動で返信します。
          </p>

          {loading ? (
            <p className="text-sm text-gray-400 py-8 text-center">読み込み中...</p>
          ) : (
            <>
              {/* 有効トグル */}
              <label className="flex items-center justify-between gap-3 py-2">
                <span className="text-sm font-medium text-gray-800">応答時間帯を使う</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  onClick={() => setIsEnabled((v) => !v)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    isEnabled ? 'bg-[#06C755]' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                      isEnabled ? 'translate-x-5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>

              {!isEnabled && (
                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  いまは <strong>OFF</strong> です。時間帯に関係なく、これまでどおり自動応答が動きます（今までと変わりません）。
                </div>
              )}

              {isEnabled && (
                <div className="rounded-md border border-[#06C755]/30 bg-[#06C755]/5 px-3 py-2 text-xs text-gray-700">
                  {buildSummary(rows, mode)}
                </div>
              )}

              {/* OFF の間は設定欄を薄く畳む/無効化 (非回帰を UI でも可視化) */}
              <div className={isEnabled ? '' : 'opacity-50 pointer-events-none select-none'}>
                <p className="text-xs text-gray-500 mb-3">
                  営業時間内に届いたメッセージには自動応答せず、<strong>未対応リスト</strong>に入ります（スタッフが返信します）。
                </p>

                {/* 曜日別 営業時間 */}
                <div className="space-y-2">
                  {rows.map((row) => (
                    <div key={row.day} className="flex flex-col sm:flex-row sm:items-center gap-2 border border-gray-100 rounded-md px-3 py-2">
                      <span className="w-8 text-sm font-medium text-gray-700">{DAY_LABEL[row.day]}</span>
                      <label className="flex items-center gap-1.5 text-xs text-gray-600 min-h-[36px]">
                        <input
                          type="checkbox"
                          checked={row.closed}
                          onChange={(e) => updateRow(row.day, { closed: e.target.checked })}
                        />
                        定休日
                      </label>
                      {row.closed ? (
                        <span className="text-xs text-gray-400">休み</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="time"
                            step={60}
                            value={row.open}
                            onChange={(e) => updateRow(row.day, { open: e.target.value })}
                            className="border border-gray-300 rounded px-2 py-1 text-sm min-h-[36px]"
                            aria-label={`${DAY_LABEL[row.day]} 開始`}
                          />
                          <span className="text-xs text-gray-400">〜</span>
                          <input
                            type="time"
                            step={60}
                            value={row.close}
                            onChange={(e) => updateRow(row.day, { close: e.target.value })}
                            className="border border-gray-300 rounded px-2 py-1 text-sm min-h-[36px]"
                            aria-label={`${DAY_LABEL[row.day]} 終了`}
                          />
                          {isOvernight(row) && (
                            <span className="text-[11px] text-gray-500">翌日 {row.close} まで（夜通し）</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* 営業時間外の応答方法 */}
                <div className="mt-4">
                  <p className="text-sm font-medium text-gray-800 mb-2">営業時間外の応答方法</p>
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                      <input type="radio" name="mode" checked={mode === 'auto_reply'} onChange={() => setMode('auto_reply')} className="mt-1" />
                      <span>
                        自動応答をつづける
                        <span className="block text-xs text-gray-500">時間外でも、いつもの自動応答を返します</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                      <input type="radio" name="mode" checked={mode === 'away_message'} onChange={() => setMode('away_message')} className="mt-1" />
                      <span>
                        不在メッセージを返す
                        <span className="block text-xs text-gray-500">「ただいま営業時間外です」など、決まった文を返します</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                      <input type="radio" name="mode" checked={mode === 'none'} onChange={() => setMode('none')} className="mt-1" />
                      <span>
                        なにもしない
                        <span className="block text-xs text-gray-500">自動では返さず、未対応リストに入れてスタッフが対応します</span>
                      </span>
                    </label>
                  </div>
                </div>

                {/* 不在メッセージ文面 (away のみ) */}
                {mode === 'away_message' && (
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-gray-700 mb-1">不在メッセージの文面</label>
                    <textarea
                      value={awayMessage}
                      onChange={(e) => setAwayMessage(e.target.value)}
                      rows={3}
                      placeholder="ただいま営業時間外です。翌営業日に順番にご返信します。"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    {awayMissing && (
                      <p className="text-xs text-red-500 mt-1">不在メッセージの文面を入力してください。</p>
                    )}
                  </div>
                )}
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-xs">{error}</div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || loading}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
