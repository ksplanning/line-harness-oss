'use client'

/**
 * G2 配信通数の月次上限ガード設定 (F2 batch4 T-C10)。
 * accounts page の「今月送信」表示の隣に置く。上限トグル + 数値 + 進捗バー + 接近警告 + ブロック注記。
 * 表示分子 (messagesThisMonth) は worker の gate と同一計測。未設定=無制限 (既定挙動不変)。
 */
import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

const APPROACHING_THRESHOLD = 0.8 // 固定 80% で接近警告

export default function MonthlyCapSettings({ accountId }: { accountId: string }) {
  const [cap, setCap] = useState<number | null>(null)
  const [count, setCount] = useState<number>(0)
  const [enabled, setEnabled] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const res = await api.lineAccounts.getMonthlyCap(accountId)
    if (res.success && res.data) {
      setCap(res.data.monthlyCap)
      setCount(res.data.messagesThisMonth)
      setEnabled(res.data.monthlyCap !== null)
      setDraft(res.data.monthlyCap !== null ? String(res.data.monthlyCap) : '')
    }
    setLoaded(true)
  }, [accountId])

  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const value = enabled ? Math.max(1, Math.floor(Number(draft) || 0)) : null
      const res = await api.lineAccounts.updateMonthlyCap(accountId, value)
      if (res.success) { setCap(value); if (value !== null) setDraft(String(value)) }
    } finally { setSaving(false) }
  }

  if (!loaded) return <div className="text-xs text-gray-400">読み込み中...</div>

  const ratio = cap && cap > 0 ? Math.min(1, count / cap) : 0
  const over = cap !== null && count >= cap
  const approaching = cap !== null && !over && ratio >= APPROACHING_THRESHOLD
  const barColor = over ? '#DC2626' : approaching ? '#D97706' : '#06C755'

  return (
    <div className="rounded-lg border border-gray-200 p-3 bg-white">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">配信通数の上限</span>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="月の上限を設定する" />
          月の上限を設定する
        </label>
      </div>

      {enabled ? (
        <div className="flex items-center gap-2 mb-2">
          <input
            type="number" min={1} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="例: 1000"
            aria-label="月の上限通数"
            className="text-xs border border-gray-300 rounded px-2 py-1 w-28"
          />
          <span className="text-xs text-gray-500">通 / 月</span>
        </div>
      ) : (
        <p className="text-xs text-gray-500 mb-2">未設定なら無制限（今までどおり送れます）。</p>
      )}

      {/* 進捗表示: 今月◯ / 上限△ + プログレスバー */}
      <div className="mb-2">
        <div className="text-xs text-gray-600 mb-1">
          今月 {count.toLocaleString('ja-JP')}{cap !== null ? ` / 上限 ${cap.toLocaleString('ja-JP')}` : '（上限なし）'} 通
        </div>
        {cap !== null && (
          <div className="w-full h-2 rounded bg-gray-100 overflow-hidden">
            <div style={{ width: `${Math.round(ratio * 100)}%`, backgroundColor: barColor }} className="h-full" />
          </div>
        )}
      </div>

      {approaching && (
        <p className="text-xs rounded px-2 py-1 mb-2" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
          上限に近づいています（今月 {count} / 上限 {cap}）。
        </p>
      )}
      {over && (
        <p className="text-xs rounded px-2 py-1 mb-2" style={{ backgroundColor: '#FEE2E2', color: '#991B1B' }}>
          今月の上限に達しています。上限を変えるか来月までお待ちください。
        </p>
      )}

      <p className="text-xs text-gray-400 mb-2">※ テスト送信もこの通数に含まれます。</p>

      <button
        onClick={save} disabled={saving}
        className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50"
        style={{ backgroundColor: '#06C755' }}
      >
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  )
}
