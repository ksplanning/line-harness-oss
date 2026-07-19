'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import { formsAdvancedApi, type AdvancedForm } from '@/lib/formaloo-advanced-api'
import {
  formalooRecurringSubmissionsApi,
  type FormalooRecurringStatus,
  type FormalooRecurringSubmission,
} from '@/lib/formaloo-recurring-submissions-api'

type FormScope = Pick<AdvancedForm, 'id' | 'title' | 'lineAccountId'>

const STATUS_LABEL: Record<FormalooRecurringStatus, string> = {
  resumed: '稼働中',
  paused: '一時停止',
  cancelled: '取消済み',
}

function errorMessage(error: unknown): string {
  const body = (error as { body?: { error?: unknown } })?.body
  return typeof body?.error === 'string'
    ? body.error
    : '定期自動回答の操作に失敗しました。もう一度お試しください。'
}

function parseJsonObject(label: string, raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${label} を正しい JSON object で入力してください`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} は JSON object で入力してください`)
  }
  return value as Record<string, unknown>
}

function parseInterval(raw: string): Record<string, string> {
  const value = parseJsonObject('間隔 JSON', raw)
  for (const item of Object.values(value)) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error('間隔 JSON の各値は空でない文字列にしてください')
    }
  }
  return value as Record<string, string>
}

function toIso(label: string, value: string): string {
  const timestamp = new Date(value)
  if (!value || Number.isNaN(timestamp.getTime())) throw new Error(`${label}を入力してください`)
  return timestamp.toISOString()
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `recurring-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function rowKey(item: FormalooRecurringSubmission): string {
  return item.remoteSlug ?? item.id
}

export default function RecurringSubmissionsClient({ formId }: { formId: string }) {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const scopeToken = `${formId}\u0000${selectedAccountId ?? '<none>'}\u0000${accountLoading ? 'loading' : 'ready'}`
  const currentScopeToken = useRef(scopeToken)
  currentScopeToken.current = scopeToken
  const [form, setForm] = useState<FormScope | null>(null)
  const [formLoaded, setFormLoaded] = useState(false)
  const [items, setItems] = useState<FormalooRecurringSubmission[]>([])
  const [available, setAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [confirmCancelSlug, setConfirmCancelSlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [intervalJson, setIntervalJson] = useState('{}')
  const [submissionJson, setSubmissionJson] = useState('{}')
  const createKey = useRef<string | null>(null)

  useEffect(() => {
    setItems([])
    setAvailable(false)
    setLoading(true)
    setBusySlug(null)
    setConfirmCancelSlug(null)
    setError(null)
    setStartTime('')
    setEndTime('')
    setIntervalJson('{}')
    setSubmissionJson('{}')
    createKey.current = null
  }, [scopeToken])

  useEffect(() => {
    let active = true
    setFormLoaded(false)
    setForm(null)
    setError(null)
    void formsAdvancedApi.get(formId)
      .then((value) => {
        if (active) setForm({ id: value.id, title: value.title, lineAccountId: value.lineAccountId })
      })
      .catch(() => {
        if (active) setError('フォームが見つかりません')
      })
      .finally(() => {
        if (active) setFormLoaded(true)
      })
    return () => { active = false }
  }, [formId])

  const scopedForm = form?.id === formId ? form : null
  const scopeBlocked = scopedForm != null
    && scopedForm.lineAccountId != null
    && selectedAccountId != null
    && scopedForm.lineAccountId !== selectedAccountId
  const scopeUnknown = accountLoading
    || !formLoaded
    || scopedForm == null
    || (scopedForm.lineAccountId != null && selectedAccountId == null)
  const scopeAllowed = scopedForm != null && !scopeBlocked && !scopeUnknown

  const loadRecurring = useCallback(async () => {
    const requestScopeToken = scopeToken
    setLoading(true)
    try {
      const result = await formalooRecurringSubmissionsApi.list(formId)
      if (currentScopeToken.current !== requestScopeToken) return
      setItems(result.items)
      setAvailable(result.available)
      setError(null)
    } catch (cause) {
      if (currentScopeToken.current !== requestScopeToken) return
      setError(errorMessage(cause))
    } finally {
      if (currentScopeToken.current === requestScopeToken) setLoading(false)
    }
  }, [formId, scopeToken])

  useEffect(() => {
    if (scopeAllowed) void loadRecurring()
  }, [scopeAllowed, loadRecurring])

  const replaceItem = (next: FormalooRecurringSubmission) => {
    setItems((current) => current.map((item) => item.id === next.id ? next : item))
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const requestScopeToken = scopeToken
    setError(null)
    let interval: Record<string, string>
    let submissionData: Record<string, unknown>
    let startIso: string
    let endIso: string | null
    try {
      interval = parseInterval(intervalJson)
      submissionData = parseJsonObject('回答内容 JSON', submissionJson)
      startIso = toIso('開始時刻', startTime)
      endIso = endTime ? toIso('終了時刻', endTime) : null
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '入力が不正です')
      return
    }

    createKey.current ??= newIdempotencyKey()
    setBusySlug('create')
    try {
      const created = await formalooRecurringSubmissionsApi.create(formId, {
        idempotencyKey: createKey.current,
        schedule: { interval, startTime: startIso, endTime: endIso },
        submissionData,
      })
      if (currentScopeToken.current !== requestScopeToken) return
      setItems((current) => [created, ...current.filter((item) => item.id !== created.id)])
      createKey.current = null
      setStartTime('')
      setEndTime('')
      setIntervalJson('{}')
      setSubmissionJson('{}')
    } catch (cause) {
      if (currentScopeToken.current !== requestScopeToken) return
      setError(errorMessage(cause))
    } finally {
      if (currentScopeToken.current === requestScopeToken) setBusySlug(null)
    }
  }

  const handleStatus = async (
    item: FormalooRecurringSubmission,
    status: 'resumed' | 'paused' | 'cancelled',
  ) => {
    if (!item.remoteSlug) return
    const requestScopeToken = scopeToken
    setBusySlug(item.remoteSlug)
    setError(null)
    try {
      const updated = status === 'cancelled'
        ? await formalooRecurringSubmissionsApi.cancel(formId, item.remoteSlug)
        : await formalooRecurringSubmissionsApi.setStatus(formId, item.remoteSlug, status)
      if (currentScopeToken.current !== requestScopeToken) return
      replaceItem(updated)
      setConfirmCancelSlug(null)
    } catch (cause) {
      if (currentScopeToken.current !== requestScopeToken) return
      setError(errorMessage(cause))
    } finally {
      if (currentScopeToken.current === requestScopeToken) setBusySlug(null)
    }
  }

  if (formLoaded && form == null) {
    return (
      <div>
        <Header title="定期自動回答" description="決まった回答を、決めた時刻に自動で送ります" />
        <div className="mb-3"><Link href="/forms-advanced" className="text-xs text-gray-500">← 一覧に戻る</Link></div>
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-8 text-center text-sm text-red-700">
          {error ?? 'フォームが見つかりません'}
        </div>
      </div>
    )
  }

  if (scopeBlocked || scopeUnknown) {
    return (
      <div>
        <Header title="定期自動回答" description="決まった回答を、決めた時刻に自動で送ります" />
        <div className="mb-3"><Link href="/forms-advanced" className="text-xs text-gray-500">← 一覧に戻る</Link></div>
        {scopeBlocked ? (
          <div data-testid="scope-blocked" className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
            このフォームは別の LINE アカウント向けです。対象アカウントへ切り替えてください。
          </div>
        ) : (
          <div data-testid="scope-hold" className="text-sm text-gray-400">アカウントを確認しています...</div>
        )}
      </div>
    )
  }

  return (
    <div>
      <Header title="定期自動回答" description="決まった回答を、決めた時刻に自動で送ります" />
      <div className="mb-4 flex items-center gap-3">
        <Link href="/forms-advanced" className="text-xs text-gray-500 hover:text-gray-800">← 一覧に戻る</Link>
        {form && <span className="text-sm font-medium text-gray-800">{form.title}</span>}
      </div>

      {error && <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <form data-testid="recurring-create" onSubmit={handleCreate} className="mb-5 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">新しい定期回答</h2>
        <p className="mt-1 text-xs leading-5 text-amber-700">
          Formaloo 公式文書は interval のキー名・単位を公開していません。host 実測で確認した JSON をそのまま入力してください。
        </p>
        {!available && <p className="mt-2 text-xs text-amber-700">先にフォームを保存して Formaloo へ接続してください。</p>}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="text-xs text-gray-600" htmlFor="recurring-start">
            開始時刻
            <input id="recurring-start" aria-label="開始時刻" type="datetime-local" required value={startTime} onChange={(event) => { createKey.current = null; setStartTime(event.target.value) }} disabled={!available || busySlug !== null} className="mt-1 w-full rounded border border-gray-200 px-2 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-600" htmlFor="recurring-end">
            終了時刻（任意）
            <input id="recurring-end" aria-label="終了時刻" type="datetime-local" value={endTime} onChange={(event) => { createKey.current = null; setEndTime(event.target.value) }} disabled={!available || busySlug !== null} className="mt-1 w-full rounded border border-gray-200 px-2 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-600" htmlFor="recurring-interval">
            間隔 JSON
            <textarea id="recurring-interval" aria-label="間隔 JSON" rows={4} value={intervalJson} onChange={(event) => { createKey.current = null; setIntervalJson(event.target.value) }} disabled={!available || busySlug !== null} className="mt-1 w-full rounded border border-gray-200 px-2 py-2 font-mono text-xs" />
          </label>
          <label className="text-xs text-gray-600" htmlFor="recurring-submission">
            回答内容 JSON
            <textarea id="recurring-submission" aria-label="回答内容 JSON" rows={4} value={submissionJson} onChange={(event) => { createKey.current = null; setSubmissionJson(event.target.value) }} disabled={!available || busySlug !== null} className="mt-1 w-full rounded border border-gray-200 px-2 py-2 font-mono text-xs" />
          </label>
        </div>
        <button type="submit" disabled={!available || busySlug !== null} className="mt-3 rounded bg-[#06C755] px-4 py-2 text-sm text-white disabled:opacity-50">
          {busySlug === 'create' ? '登録中...' : '追加'}
        </button>
      </form>

      <section aria-label="登録済み定期自動回答" className="space-y-3">
        {loading ? (
          <div className="text-sm text-gray-400">読み込み中...</div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">登録はまだありません。</div>
        ) : items.map((item) => {
          const key = rowKey(item)
          const busy = busySlug === item.remoteSlug
          return (
            <article key={item.id} data-testid={`recurring-row-${key}`} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span data-testid={`recurring-status-${key}`} aria-live="polite" className="rounded bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700">
                    {STATUS_LABEL[item.status]}
                  </span>
                  {item.syncState !== 'synced' && (
                    <span className="ml-2 text-xs text-amber-700">反映未確認（{item.lastError ?? item.syncState}）</span>
                  )}
                </div>
                {item.remoteSlug && item.status !== 'cancelled' && (
                  <div className="flex flex-wrap gap-2">
                    {item.status === 'resumed' ? (
                      <button type="button" aria-label={`一時停止: ${key}`} disabled={busy} onClick={() => { void handleStatus(item, 'paused') }} className="rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200 disabled:opacity-50">一時停止</button>
                    ) : (
                      <button type="button" aria-label={`再開: ${key}`} disabled={busy} onClick={() => { void handleStatus(item, 'resumed') }} className="rounded bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200 disabled:opacity-50">再開</button>
                    )}
                    {confirmCancelSlug === item.remoteSlug ? (
                      <>
                        <button autoFocus type="button" aria-label={`本当に取消: ${key}`} disabled={busy} onClick={() => { void handleStatus(item, 'cancelled') }} className="rounded bg-red-600 px-3 py-1 text-xs text-white disabled:opacity-50">本当に取消</button>
                        <button type="button" aria-label={`取消確認から戻る: ${key}`} disabled={busy} onClick={() => setConfirmCancelSlug(null)} className="rounded bg-gray-100 px-3 py-1 text-xs">戻る</button>
                      </>
                    ) : (
                      <button type="button" aria-label={`取消: ${key}`} disabled={busy} onClick={() => setConfirmCancelSlug(item.remoteSlug)} className="rounded bg-red-50 px-3 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-50">取消</button>
                    )}
                  </div>
                )}
              </div>
              <dl className="mt-3 grid gap-3 text-xs md:grid-cols-3">
                <div><dt className="text-gray-400">開始</dt><dd className="mt-1 text-gray-700">{item.schedule.start_time}</dd></div>
                <div><dt className="text-gray-400">終了</dt><dd className="mt-1 text-gray-700">{item.schedule.end_time ?? '指定なし'}</dd></div>
                <div><dt className="text-gray-400">間隔</dt><dd><pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-gray-700">{JSON.stringify(item.schedule.interval, null, 2)}</pre></dd></div>
              </dl>
              <details className="mt-3 text-xs text-gray-600">
                <summary className="cursor-pointer">送信する回答内容</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-2">{JSON.stringify(item.submissionData, null, 2)}</pre>
              </details>
            </article>
          )
        })}
      </section>
    </div>
  )
}
