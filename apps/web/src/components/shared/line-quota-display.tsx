'use client'

import { useEffect, useState } from 'react'
import { api, type LineQuotaData } from '@/lib/api'

function useLineQuota(accountId: string | null) {
  const [quota, setQuota] = useState<LineQuotaData | null>(null)
  const [loading, setLoading] = useState(Boolean(accountId))
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setQuota(null)
    setError('')
    setLoading(Boolean(accountId))
    if (!accountId) return () => { cancelled = true }

    void (async () => {
      try {
        const getQuota = api.lineAccounts?.getQuota
        if (typeof getQuota !== 'function') throw new Error('quota API unavailable')
        const response = await getQuota(accountId)
        if (cancelled) return
        if (response.success) setQuota(response.data)
        else setError(response.error || 'LINEの送信数を取得できませんでした。')
      } catch {
        if (!cancelled) setError('LINEの送信数を取得できませんでした。')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [accountId])

  return { quota, loading, error }
}

function countLabel(value: number | null): string {
  return value === null ? '無制限' : `${value.toLocaleString('ja-JP')}通`
}

export function LineQuotaSummary({ accountId }: { accountId: string }) {
  const { quota, loading, error } = useLineQuota(accountId)

  return (
    <section aria-label="LINE公式の送信数" className="mb-3 rounded-lg border border-green-100 bg-green-50/50 p-3">
      <p className="mb-2 text-xs font-semibold text-gray-700">LINE公式の送信数</p>
      {loading ? (
        <p className="text-xs text-gray-400">取得中...</p>
      ) : quota ? (
        <>
          <p className="mb-2 text-xs text-gray-700">
            <span className="text-gray-500">プラン（推定）</span>{' '}
            <span className="font-medium">{quota.plan_label}</span>
          </p>
          <div className="grid grid-cols-3 gap-2 text-center text-xs text-gray-700">
            <span>最大 {countLabel(quota.limit)}</span>
            <span>使用 {countLabel(quota.used)}</span>
            <span className="font-semibold text-green-700">残り {countLabel(quota.remaining)}</span>
          </div>
          {quota.message && <p className="mt-2 text-xs text-amber-700">{quota.message}</p>}
        </>
      ) : (
        <p className="text-xs text-amber-700">{error || 'LINEの送信数を取得できませんでした。'}</p>
      )}
    </section>
  )
}

export function LineQuotaAudienceStatus({
  accountId,
  targetCount,
}: {
  accountId: string | null
  targetCount: number
}) {
  const { quota, loading, error } = useLineQuota(accountId)
  const exceedsRemaining = quota?.remaining !== null
    && quota?.remaining !== undefined
    && targetCount > quota.remaining

  return (
    <div
      role="status"
      aria-label="LINE公式の残り送信数"
      className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
    >
      {loading ? (
        <p>残り送信数を確認中... (対象 {targetCount.toLocaleString('ja-JP')}人)</p>
      ) : quota ? (
        <>
          <p className="font-medium">
            残り送信数 {countLabel(quota.remaining)} (対象 {targetCount.toLocaleString('ja-JP')}人)
          </p>
          {exceedsRemaining && (
            <p role="alert" className="mt-1 font-semibold text-red-700">
              残り送信数が対象人数より少ないです。送信前に内容を確認してください。
            </p>
          )}
          {quota.message && <p className="mt-1 text-amber-700">{quota.message}</p>}
        </>
      ) : (
        <p className="text-amber-700">{error || 'LINEの送信数を取得できませんでした。'}</p>
      )}
    </div>
  )
}

export function LineQuotaBadge({ accountId }: { accountId: string | null }) {
  const { quota, loading, error } = useLineQuota(accountId)
  if (loading) return null

  return (
    <span
      role="status"
      aria-label="LINE公式の残り送信数"
      title={quota?.message || error || undefined}
      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${quota ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}
    >
      {quota ? `残り ${countLabel(quota.remaining)}` : '残り送信数を取得できませんでした'}
    </span>
  )
}
