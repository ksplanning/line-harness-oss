'use client'

import { useEffect, useState } from 'react'
import { api, type FriendRegistrationPoint } from '@/lib/api'

type TrendPeriod = 30 | 90

interface FriendStatsPanelProps {
  accountId: string
  total: number
  blocked: number
  sendable: number
}

function people(value: number): string {
  return `${value.toLocaleString('ja-JP')}人`
}

function shortDate(value: string): string {
  const [, month, day] = value.split('-')
  return `${Number(month)}/${Number(day)}`
}

export default function FriendStatsPanel({
  accountId,
  total,
  blocked,
  sendable,
}: FriendStatsPanelProps) {
  const [period, setPeriod] = useState<TrendPeriod>(30)
  const [points, setPoints] = useState<FriendRegistrationPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    void (async () => {
      try {
        const response = await api.lineAccounts.getFriendTrend(accountId, period)
        if (cancelled) return
        if (response.success) setPoints(response.data.points)
        else setError(response.error || '登録推移を取得できませんでした。')
      } catch {
        if (!cancelled) setError('登録推移を取得できませんでした。')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [accountId, period])

  const maxRegistrations = Math.max(1, ...points.map((point) => point.registrations))
  const periodRegistrations = points.reduce(
    (sum, point) => sum + point.registrations,
    0,
  )

  return (
    <>
      <section
        aria-label="友だちの状況"
        className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3"
      >
        <p className="mb-2 text-xs font-semibold text-gray-700">友だちの状況</p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-lg font-bold text-gray-900">{people(total)}</p>
            <p className="text-[11px] text-gray-500">友だち総数</p>
          </div>
          <div>
            <p className="text-lg font-bold text-amber-700">{people(blocked)}</p>
            <p className="text-[11px] text-gray-500">ブロック数</p>
          </div>
          <div>
            <p className="text-lg font-bold text-green-700">{people(sendable)}</p>
            <p className="text-[11px] text-gray-500">一斉送信可能数</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-gray-500">
          友だち総数はこの管理画面の全登録者です。ブロック数は、現在フォローしていない友だち、
          一斉送信可能数は現在フォロー中の友だちです。LINE公式側とは反映時刻などで差が出る場合があります。
        </p>
      </section>

      <section
        aria-label="友だち登録推移"
        className="mb-3 rounded-lg border border-green-100 bg-green-50/40 p-3"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-gray-700">友だち登録推移</p>
          <div className="flex rounded-md border border-gray-200 bg-white p-0.5">
            {([30, 90] as const).map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={period === days}
                onClick={() => setPeriod(days)}
                className={`rounded px-2 py-1 text-[11px] font-medium ${
                  period === days
                    ? 'bg-green-600 text-white'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {days}日
              </button>
            ))}
          </div>
        </div>
        <p className="mb-2 text-[11px] leading-4 text-gray-500">
          管理画面に初めて登録された日ごとの人数です。LINE上で実際に友だち追加した日とは異なる場合があります。
        </p>

        {loading ? (
          <p className="py-6 text-center text-xs text-gray-400">推移を取得中...</p>
        ) : error ? (
          <p className="py-6 text-center text-xs text-amber-700">{error}</p>
        ) : (
          <figure aria-label={`${period}日間の友だち登録推移`}>
            <div className="overflow-x-auto">
              <div
                className="flex h-24 min-w-[240px] items-end gap-px border-b border-gray-200"
                style={{ minWidth: period === 90 ? '360px' : '240px' }}
              >
                {points.map((point) => (
                  <span
                    key={point.date}
                    title={`${point.date}: ${point.registrations}人登録`}
                    className="min-w-[2px] flex-1 rounded-t-sm bg-green-400"
                    style={{
                      height: `${Math.max(
                        2,
                        Math.round((point.registrations / maxRegistrations) * 88),
                      )}px`,
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-gray-400">
              <span>{points[0] ? shortDate(points[0].date) : ''}</span>
              <span>期間中 {people(periodRegistrations)}登録</span>
              <span>{points.at(-1) ? shortDate(points.at(-1)!.date) : ''}</span>
            </div>
          </figure>
        )}
      </section>
    </>
  )
}
