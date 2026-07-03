'use client'

import { useState, useEffect } from 'react'
import { api, type RichMenuTapAnalyticsData } from '@/lib/api'
import { actionTypeLabel, tapCountToAlpha, tapRatio, maxTapCount } from '@/lib/rich-menu-analytics/tap-view'

interface GroupOption { id: string; name: string; thumbnailR2Key: string | null }

/**
 * G58 リッチメニュータップ数分析パネル (read-only 集計)。
 * accountId + メニューグループ + 期間 (JST) を選ぶと postback系タップ数を可視化する。
 * 計測範囲注記 (postback 推定・URI/message 不可) を必須表示。送信はしない。
 */
export default function TapAnalyticsPanel({ accountId }: { accountId: string }) {
  const [groups, setGroups] = useState<GroupOption[]>([])
  const [groupId, setGroupId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [data, setData] = useState<RichMenuTapAnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 集計に使った画像 (group サムネ) を保持。
  const [thumbKey, setThumbKey] = useState<string | null>(null)
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    api.richMenuGroups
      .list(accountId)
      .then((r) => {
        if (!cancelled && r.success) {
          setGroups(r.data.map((g) => ({ id: g.id, name: g.name, thumbnailR2Key: g.thumbnailR2Key ?? null }))) // gitleaks:allow — thumbnailR2Key は R2 画像キー名 (機密でない既存 API フィールド)
        }
      })
      .catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [accountId])

  const canRun = groupId && startDate && endDate && startDate <= endDate

  const run = async () => {
    if (!canRun) return
    setLoading(true)
    setError('')
    setData(null)
    try {
      const res = await api.richMenuTapAnalytics.taps({ accountId, groupId, startDate, endDate })
      if (res.success) {
        setData(res.data)
        setThumbKey(groups.find((g) => g.id === groupId)?.thumbnailR2Key ?? null)
      } else {
        setError('集計に失敗しました')
      }
    } catch {
      setError('集計に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const max = data ? maxTapCount(data.areas) : 0
  // オーバーレイの表示スケール (サムネ幅を基準に固定 320px 相当)。
  const displayW = 320
  const scale = imgDims ? displayW / imgDims.w : 0

  return (
    <div>
      {/* 計測範囲注記 (必須・常時表示) */}
      <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-800 text-xs p-3 rounded">
        タップ数は「ボタン応答（postback）」と「タブ切替（richmenuswitch）」のアクションのみ計測
        できます。URL アクション・メッセージ アクションのタップは LINE の仕様上カウントできません。
        また、リッチメニュー由来かどうかを完全に断定できない場合があります。
      </div>

      {/* フィルタ帯 */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">メニューグループ</label>
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">— グループを選ぶ —</option>
              {groups.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">開始日 (JST)</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">終了日 (JST)</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={run} disabled={!canRun || loading} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-40" style={{ backgroundColor: '#06C755' }}>
            {loading ? '集計中...' : '集計する'}
          </button>
        </div>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>}

      {!data ? (
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          上部でメニューグループと期間を選んで「集計する」を押してください。タップ数が多い領域が赤く表示されます。
        </div>
      ) : data.totalTaps === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          選択した期間にタップ記録がありません。対象は postback アクションのみです。
        </div>
      ) : (
        <div className="space-y-4">
          {/* メニュー画像オーバーレイ (read-only) */}
          {thumbKey && (
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="relative inline-block" style={imgDims ? { width: displayW, height: imgDims.h * scale } : undefined}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={api.richMenuGroups.imageUrl(thumbKey)}
                  alt="メニュー画像"
                  onLoad={(e) => setImgDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                  className="block w-[320px] h-auto rounded"
                />
                {imgDims && data.areas.filter((a) => a.measurable).map((a) => (
                  <div
                    key={a.areaId}
                    className="absolute flex items-center justify-center pointer-events-none"
                    style={{
                      left: a.boundsX * scale,
                      top: a.boundsY * scale,
                      width: a.boundsWidth * scale,
                      height: a.boundsHeight * scale,
                      background: tapCountToAlpha(a.count, max),
                      border: '1px solid rgba(255,255,255,0.6)',
                    }}
                  >
                    <span className="text-white text-xs font-bold bg-black/60 rounded px-1 py-0.5 tabular-nums">
                      {(a.count ?? 0).toLocaleString('ja-JP')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 領域別一覧 */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">領域</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">アクション種別</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">タップ数</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">割合</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.areas.map((a, i) => (
                    <tr key={a.areaId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">領域{i + 1}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{actionTypeLabel(a.actionType)}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 tabular-nums">
                        {a.measurable && a.count !== null ? `${a.count.toLocaleString('ja-JP')}回` : '─ ※'}
                      </td>
                      <td className="px-4 py-3">
                        {a.measurable && a.count !== null ? (
                          <div className="h-2 bg-gray-100 rounded overflow-hidden w-24">
                            <div className="h-full bg-green-200" style={{ width: `${tapRatio(a.count, max)}%` }} />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400"> </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.unattributedCount > 0 && (
                    <tr className="bg-gray-50">
                      <td className="px-4 py-3 text-sm text-gray-500" colSpan={2}>領域不明（複数領域に同じボタン設定がある場合など）</td>
                      <td className="px-4 py-3 text-sm text-gray-700 tabular-nums">{data.unattributedCount.toLocaleString('ja-JP')}回</td>
                      <td className="px-4 py-3"></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">
              ※ 「─ ※」の行は URL・メッセージ アクションで、LINE 仕様上タップ数をカウントできません。
            </p>
          </div>

          <p className="text-xs text-gray-400">計測期間: {startDate} 〜 {endDate}（JST）</p>
        </div>
      )}
    </div>
  )
}
