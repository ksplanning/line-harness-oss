'use client'

import { useEffect, useState } from 'react'
import Toggle from '@/components/shared/toggle'
import {
  formalooInstantWebhookApi,
  type FormalooInstantWebhookStatus,
} from '@/lib/formaloo-instant-webhook-api'

function errorMessage(error: unknown): string {
  const body = (error as { body?: { error?: unknown } })?.body
  return typeof body?.error === 'string'
    ? body.error
    : '即時反映の設定に失敗しました。しばらくしてから再試行してください。'
}

export default function InstantWebhookSettings({ formId }: { formId: string }) {
  const [status, setStatus] = useState<FormalooInstantWebhookStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void formalooInstantWebhookApi.get(formId)
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause))
      })
    return () => { cancelled = true }
  }, [formId])

  const handleToggle = async () => {
    if (!status || !status.available || busy) return
    const enabled = !status.enabled
    setBusy(true)
    setError(null)
    try {
      setStatus(await formalooInstantWebhookApi.set(formId, enabled))
    } catch (cause) {
      setError(errorMessage(cause))
      // OFF は remote cleanup 失敗時でも server 側で先に成立する。再取得して見かけと真値を揃える。
      try { setStatus(await formalooInstantWebhookApi.get(formId)) } catch { /* 現在表示を維持 */ }
    } finally {
      setBusy(false)
    }
  }

  const enabled = status?.enabled === true
  const available = status?.available !== false

  return (
    <section
      data-testid="instant-webhook-settings"
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">回答をすぐ管理画面へ反映</h2>
          <p data-testid="instant-webhook-description" className="mt-1 text-xs leading-5 text-gray-500">
            回答が届いた瞬間に管理画面へ反映されます（最大6時間待ち→即時）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            data-testid="instant-webhook-status"
            className={`text-xs font-semibold ${enabled ? 'text-green-600' : 'text-gray-400'}`}
          >
            {enabled ? 'ON' : 'OFF'}
          </span>
          <Toggle
            value={enabled}
            disabled={busy || status === null || !available}
            onClick={() => { void handleToggle() }}
          />
        </div>
      </div>
      {!available && (
        <p data-testid="instant-webhook-unavailable" className="mt-2 text-xs text-amber-600">
          先にフォームを保存して Formaloo へ接続すると有効にできます。
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  )
}
