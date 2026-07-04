'use client'

/**
 * G1 A/B テスト配信 UI (F2 batch4 T-C9)。作成 (名前 + 比較指標) → 決定論的分割プレビュー → 比較 →
 * 勝ち案を残りへ配信する下書き作成、まで。**送信はしない** (実 A/B 送信・勝ち全配信は owner 立会 gated)。
 * audience (conditions) は既存 segment-builder で選んだものを prop で受け取る。
 */
import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

interface AbTest { id: string; name: string; metric: 'open_rate' | 'click_rate'; status: string; winnerBroadcastId: string | null }

const METRIC_LABEL: Record<'open_rate' | 'click_rate', string> = { open_rate: '開封率', click_rate: 'クリック率' }

export default function AbTestPanel({ accountId, conditions }: { accountId: string; conditions?: unknown }) {
  const [tests, setTests] = useState<AbTest[]>([])
  const [name, setName] = useState('')
  const [metric, setMetric] = useState<'open_rate' | 'click_rate'>('open_rate')
  const [selected, setSelected] = useState<AbTest | null>(null)
  const [split, setSplit] = useState<{ total: number; counts: Record<string, number> } | null>(null)
  const [compare, setCompare] = useState<{ variants: Array<{ variant: string; openRate: number | null; clickRate: number | null }>; winner: string | null; tie: boolean; dataPending: boolean; metric: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await api.abTests.list(accountId)
    if (res.success && res.data) setTests(res.data as AbTest[])
  }, [accountId])
  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await api.abTests.create(accountId, { name: name.trim(), metric })
      if (res.success) { setName(''); await load() }
    } finally { setBusy(false) }
  }

  const doSplit = async (t: AbTest) => {
    setSelected(t); setSplit(null); setCompare(null); setBusy(true)
    try {
      const res = await api.abTests.splitPreview(t.id, accountId, conditions ?? { operator: 'AND', rules: [] })
      if (res.success && res.data) setSplit(res.data)
    } finally { setBusy(false) }
  }

  const doCompare = async (t: AbTest) => {
    setSelected(t); setBusy(true)
    try {
      const res = await api.abTests.compare(t.id, accountId)
      if (res.success && res.data) setCompare(res.data)
    } finally { setBusy(false) }
  }

  const makeWinnerDraft = async () => {
    if (!selected || !compare?.winner) return
    setBusy(true)
    try { await api.abTests.winnerDraft(selected.id, accountId, compare.winner) }
    finally { setBusy(false) }
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4 bg-white space-y-4">
      <h3 className="text-sm font-semibold text-gray-700">A/B テスト</h3>

      {/* 作成 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="テスト名" aria-label="A/Bテスト名"
          className="text-xs border border-gray-300 rounded px-2 py-1 flex-1 min-w-[140px]"
        />
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <label className="flex items-center gap-1">
            <input type="radio" name="metric" checked={metric === 'open_rate'} onChange={() => setMetric('open_rate')} />開封率で比べる
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="metric" checked={metric === 'click_rate'} onChange={() => setMetric('click_rate')} />クリック率で比べる
          </label>
        </div>
        <button onClick={create} disabled={busy} className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>作成</button>
      </div>

      {/* 一覧 */}
      <div className="space-y-1">
        {tests.map(t => (
          <div key={t.id} className="flex items-center justify-between text-xs border border-gray-100 rounded px-2 py-1">
            <span className="text-gray-700">{t.name}（{METRIC_LABEL[t.metric]}で判定）</span>
            <span className="flex gap-2">
              <button onClick={() => doSplit(t)} className="text-blue-600 hover:underline">分割プレビュー</button>
              <button onClick={() => doCompare(t)} className="text-blue-600 hover:underline">比較</button>
            </span>
          </div>
        ))}
      </div>

      {/* 分割プレビュー */}
      {split && (
        <div className="text-xs rounded px-2 py-2 bg-gray-50 border border-gray-200">
          <div className="font-medium text-gray-700 mb-1">分割プレビュー（対象 {split.total.toLocaleString('ja-JP')}人）</div>
          <div className="flex gap-4">
            {Object.entries(split.counts).map(([v, n]) => <span key={v}>案{v}：{n.toLocaleString('ja-JP')}人</span>)}
          </div>
          <p className="mt-1 rounded px-2 py-1" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>実際に送るのは owner 確認後です（このプレビューは送信しません）。</p>
        </div>
      )}

      {/* 比較 */}
      {compare && (
        <div className="text-xs rounded px-2 py-2 bg-gray-50 border border-gray-200">
          <div className="font-medium text-gray-700 mb-1">比較（{compare.metric === 'open_rate' ? '開封率' : 'クリック率'}で判定）</div>
          {compare.dataPending ? (
            <p className="text-gray-500">データ取得待ち（配信して集計が届くまでお待ちください）。</p>
          ) : (
            <>
              <table className="w-full">
                <tbody>
                  {compare.variants.map(v => (
                    <tr key={v.variant} className={compare.winner === v.variant ? 'font-semibold' : ''} style={compare.winner === v.variant ? { color: '#06C755' } : undefined}>
                      <td>案{v.variant}{compare.winner === v.variant ? '（勝ち）' : ''}</td>
                      <td>開封率 {v.openRate != null ? `${Math.round(v.openRate * 100)}%` : '-'}</td>
                      <td>クリック率 {v.clickRate != null ? `${Math.round(v.clickRate * 100)}%` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {compare.tie && <p className="text-gray-600 mt-1">引き分け（{compare.metric === 'open_rate' ? '開封率' : 'クリック率'}が同じ）です。</p>}
              {compare.winner && (
                <button onClick={makeWinnerDraft} disabled={busy} className="mt-2 px-3 py-1.5 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                  勝ち案（案{compare.winner}）で残りに配信する下書きを作成（すぐには送りません）
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
