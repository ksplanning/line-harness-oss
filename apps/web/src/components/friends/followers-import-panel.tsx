'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { FollowerImportJob } from '@/lib/api'

const ACCOUNT_NOT_VERIFIED_MESSAGE =
  'このアカウントは認証済みではないため利用できません (LINE の仕様)'
const DEFAULT_ERROR_MESSAGE =
  '既存友だちの取り込みに失敗しました。進捗は保存されているため、もう一度お試しください。'

interface Props {
  accountId: string | null
  onCompleted: () => void | Promise<void>
  /** Tests may shorten this; production deliberately avoids tight API loops. */
  pollIntervalMs?: number
}

type ErrorBody = {
  error?: string
  errorCode?: string
  data?: FollowerImportJob
}

function isRunning(job: FollowerImportJob | null): boolean {
  return job?.status === 'fetching' || job?.status === 'profiling'
}

function errorBody(error: unknown): ErrorBody | null {
  if (!error || typeof error !== 'object') return null
  const body = (error as { body?: unknown }).body
  return body && typeof body === 'object' ? body as ErrorBody : null
}

function honestError(error: unknown): string {
  const status = error && typeof error === 'object'
    ? (error as { status?: number }).status
    : undefined
  const body = errorBody(error)
  if ((status === 403 || status === 404) && body?.errorCode === 'account_not_verified') {
    return ACCOUNT_NOT_VERIFIED_MESSAGE
  }
  return body?.error || DEFAULT_ERROR_MESSAGE
}

function failedJobMessage(job: FollowerImportJob): string {
  if (job.errorCode === 'account_not_verified') return ACCOUNT_NOT_VERIFIED_MESSAGE
  return job.errorMessage || DEFAULT_ERROR_MESSAGE
}

export default function FollowersImportPanel({
  accountId,
  onCompleted,
  pollIntervalMs = 1_000,
}: Props) {
  const [job, setJob] = useState<FollowerImportJob | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [pollPaused, setPollPaused] = useState(false)
  const completedCallbacks = useRef(new Set<string>())
  const accountGeneration = useRef(0)

  // Account changes restore the latest persisted job before the action becomes available.
  useEffect(() => {
    accountGeneration.current += 1
    let active = true
    setJob(null)
    setError('')
    setPollPaused(false)
    setStarting(false)
    if (!accountId) {
      setRestoring(false)
      return () => { active = false }
    }

    setRestoring(true)
    void api.followerImports.latest(accountId)
      .then((response) => {
        if (!active) return
        if (!response.success) {
          setError(response.error)
          return
        }
        setJob(response.data)
        if (response.data?.status === 'failed') {
          setError(failedJobMessage(response.data))
        }
      })
      .catch((caught) => {
        if (active) setError(honestError(caught))
      })
      .finally(() => {
        if (active) setRestoring(false)
      })

    return () => { active = false }
  }, [accountId])

  // A tick schedules its successor only after advance settles. That makes a slow
  // request incapable of overlapping another advance for the same persisted job.
  useEffect(() => {
    if (!accountId || !job || !isRunning(job) || pollPaused) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      timer = setTimeout(async () => {
        try {
          const response = await api.followerImports.advance(job.id, accountId)
          if (!active) return
          if (!response.success) {
            setError(response.error)
            setPollPaused(true)
            return
          }
          setJob(response.data)
          if (response.data.status === 'failed') {
            setError(failedJobMessage(response.data))
            setPollPaused(true)
            return
          }
          setError('')
          if (isRunning(response.data)) schedule()
        } catch (caught) {
          if (!active) return
          const body = errorBody(caught)
          if (body?.data) setJob(body.data)
          setError(honestError(caught))
          setPollPaused(true)
        }
      }, pollIntervalMs)
    }

    schedule()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [accountId, job?.id, job?.status, pollIntervalMs, pollPaused])

  useEffect(() => {
    if (job?.status !== 'completed' || completedCallbacks.current.has(job.id)) return
    completedCallbacks.current.add(job.id)
    void onCompleted()
  }, [job?.id, job?.status, onCompleted])

  const start = async () => {
    if (!accountId || starting || isRunning(job)) return
    const requestedAccountId = accountId
    const requestedGeneration = accountGeneration.current
    setStarting(true)
    setJob(null)
    setError('')
    setPollPaused(false)
    try {
      const response = await api.followerImports.start(requestedAccountId)
      if (accountGeneration.current !== requestedGeneration) return
      if (!response.success) {
        setError(response.error)
        return
      }
      setJob(response.data)
      if (response.data.status === 'failed') setError(failedJobMessage(response.data))
    } catch (caught) {
      if (accountGeneration.current !== requestedGeneration) return
      const body = errorBody(caught)
      if (body?.data) setJob(body.data)
      setError(honestError(caught))
    } finally {
      if (accountGeneration.current === requestedGeneration) setStarting(false)
    }
  }

  const running = isRunning(job)
  const disabled = !accountId || restoring || starting || running

  return (
    <section className="mb-4 rounded-lg border border-gray-200 bg-white p-4" aria-labelledby="followers-import-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="followers-import-title" className="text-sm font-semibold text-gray-900">
            以前からいる友だちの取り込み
          </h2>
          <p className="mt-1 text-xs leading-5 text-gray-600">
            認証済みLINE公式アカウントの友だちを、友だち管理へ追加します。
            この操作ではメッセージを送信しません。
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void start() }}
          disabled={disabled}
          className="min-h-[44px] shrink-0 rounded-lg px-4 py-2 text-sm font-medium text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: '#06C755' }}
        >
          {starting ? '開始しています…' : running ? '取り込み中…' : '既存友だちを取り込む (認証済みアカウント用)'}
        </button>
      </div>

      {!accountId && (
        <p className="mt-3 text-xs text-amber-700">先に対象のLINE公式アカウントを選択してください。</p>
      )}

      {restoring && <p className="mt-3 text-xs text-gray-500">前回の進捗を確認しています…</p>}

      {job?.status === 'fetching' && (
        <div className="mt-3 rounded-md bg-blue-50 p-3 text-sm text-blue-800" role="status">
          <p className="font-medium">友だちIDを取得中… {job.fetchedCount} 名確認済み</p>
          <p className="mt-1 text-xs">新規候補 {job.newCount} 名 / 既存 {job.existingCount} 名</p>
        </div>
      )}

      {job?.status === 'profiling' && (
        <div className="mt-3 rounded-md bg-blue-50 p-3 text-sm text-blue-800" role="status">
          <p className="font-medium">プロフィール取得中… {job.profileCompletedCount} / {job.newCount} 名</p>
          <p className="mt-1 text-xs">既存 {job.existingCount} 名 / 失敗 {job.failedCount} 名</p>
        </div>
      )}

      {job?.status === 'completed' && (
        <div className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-800" role="status">
          <p className="font-medium">取り込みが完了しました。</p>
          <p className="mt-1">新規 {job.newCount} 名 / 既存 {job.existingCount} 名 / 失敗 {job.failedCount} 名</p>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          <p>{error}</p>
          {running && (
            <>
              <p className="mt-1 text-xs">{job?.fetchedCount ?? 0} 名まで確認済みです。進捗は保存されています。</p>
              <button
                type="button"
                className="mt-2 min-h-[36px] rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium"
                onClick={() => {
                  setError('')
                  setPollPaused(false)
                }}
              >
                取り込みを再開
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}
