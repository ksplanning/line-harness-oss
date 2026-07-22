'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import SheetsConnectionsPanel, {
  type SheetsSyncResultState,
} from '@/components/settings/sheets-connections-panel'
import { useAccount } from '@/contexts/account-context'
import {
  sheetsConnectionsApi,
  type SheetsAuditEntry,
  type SheetsConnection,
} from '@/lib/sheets-connections-api'

type TestState = 'testing' | 'ok' | 'ng'

function errorMessage(error: unknown): string {
  const body = (error as { body?: { error?: string } })?.body
  return body?.error || '操作に失敗しました。入力内容と接続設定を確認してください。'
}

function shouldUseLatestJob(
  current: SheetsSyncResultState | undefined,
  latest: SheetsSyncResultState,
): boolean {
  if (!current) return true
  if (!current.id) return current.status !== 'running'
  if (current.id !== latest.id) {
    if (current.updatedAt && latest.updatedAt && latest.updatedAt <= current.updatedAt) return false
    return true
  }
  if (
    current.status === 'running'
    && latest.status === 'running'
    && (latest.processedCount ?? 0) < (current.processedCount ?? 0)
  ) return false
  if (current.updatedAt && latest.updatedAt && latest.updatedAt < current.updatedAt) return false
  if (
    current.status === latest.status
    && current.processedCount === latest.processedCount
    && current.totalCount === latest.totalCount
    && current.warning === latest.warning
    && current.errorMessage === latest.errorMessage
    && current.updatedAt === latest.updatedAt
  ) return false
  return true
}

export default function SheetsSettingsPage() {
  const { selectedAccountId, loading } = useAccount()
  const [connections, setConnections] = useState<SheetsConnection[]>([])
  const [testResults, setTestResults] = useState<Record<string, TestState>>({})
  const [syncResults, setSyncResults] = useState<Record<string, SheetsSyncResultState>>({})
  const [auditEntries, setAuditEntries] = useState<Record<string, SheetsAuditEntry[]>>({})
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const auditGeneration = useRef(0)
  const testVersions = useRef<Record<string, number>>({})
  const syncVersions = useRef<Record<string, number>>({})
  const activeAccount = useRef<string | null>(selectedAccountId)
  activeAccount.current = selectedAccountId

  const load = useCallback(async (accountId: string) => {
    const version = ++requestVersion.current
    setError(null)
    try {
      const list = await sheetsConnectionsApi.list(accountId)
      if (version === requestVersion.current && activeAccount.current === accountId) {
        const generation = ++auditGeneration.current
        setConnections(list)
        setSyncResults((current) => {
          const next = { ...current }
          for (const connection of list) {
            if (
              connection.latestSyncJob
              && shouldUseLatestJob(next[connection.id], connection.latestSyncJob)
            ) {
              next[connection.id] = connection.latestSyncJob
            }
          }
          return next
        })
        setAuditEntries({})
        for (const connection of list) {
          void sheetsConnectionsApi.audit(accountId, connection.id)
            .then((entries) => {
              if (generation === auditGeneration.current && activeAccount.current === accountId) {
                setAuditEntries((current) => ({ ...current, [connection.id]: entries }))
              }
            })
            .catch(() => {
              if (generation === auditGeneration.current && activeAccount.current === accountId) {
                setAuditEntries((current) => ({ ...current, [connection.id]: [] }))
              }
            })
        }
      }
    } catch (cause) {
      if (version === requestVersion.current && activeAccount.current === accountId) {
        setConnections([])
        setError(errorMessage(cause))
      }
    }
  }, [])

  useEffect(() => {
    requestVersion.current += 1
    auditGeneration.current += 1
    setConnections([])
    setTestResults({})
    setSyncResults({})
    setAuditEntries({})
    testVersions.current = {}
    syncVersions.current = {}
    setError(null)
    if (selectedAccountId) void load(selectedAccountId)
  }, [selectedAccountId, load])

  const refreshIfCurrent = async (accountId: string) => {
    if (activeAccount.current === accountId) await load(accountId)
  }

  useEffect(() => {
    const accountId = selectedAccountId
    const runningIds = Object.entries(syncResults)
      .filter(([, result]) => result.status === 'running')
      .map(([id]) => id)
    if (!accountId || runningIds.length === 0) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      const results = await Promise.all(runningIds.map(async (id) => {
        try {
          const latest = await sheetsConnectionsApi.latestSyncJob(accountId, id)
          if (cancelled || activeAccount.current !== accountId || !latest) return false
          setSyncResults((current) => {
            if (current[id]?.status !== 'running') return current
            return { ...current, [id]: latest }
          })
          return latest.status !== 'running'
        } catch {
          return false
        }
      }))

      if (activeAccount.current !== accountId) return
      if (results.some(Boolean)) {
        await load(accountId)
        return
      }
      if (cancelled) return
      timer = setTimeout(() => { void poll() }, 5_000)
    }

    timer = setTimeout(() => { void poll() }, 5_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [selectedAccountId, syncResults, load])

  useEffect(() => {
    const accountId = selectedAccountId
    const connectionIds = connections.map((connection) => connection.id)
    if (!accountId || connectionIds.length === 0) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const discover = async () => {
      const latestJobs = await Promise.all(connectionIds.map(async (id) => {
        try {
          return [id, await sheetsConnectionsApi.latestSyncJob(accountId, id)] as const
        } catch {
          return [id, null] as const
        }
      }))
      if (cancelled || activeAccount.current !== accountId) return
      setSyncResults((current) => {
        let changed = false
        const next = { ...current }
        for (const [id, latest] of latestJobs) {
          if (!latest || !shouldUseLatestJob(next[id], latest)) continue
          next[id] = latest
          changed = true
        }
        return changed ? next : current
      })
      if (!cancelled) timer = setTimeout(() => { void discover() }, 30_000)
    }

    timer = setTimeout(() => { void discover() }, 30_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [selectedAccountId, connections])

  const handleTest = async (id: string) => {
    const accountId = selectedAccountId
    if (!accountId) return
    setError(null)
    const testVersion = (testVersions.current[id] ?? 0) + 1
    testVersions.current[id] = testVersion
    setTestResults((current) => ({ ...current, [id]: 'testing' }))
    try {
      const ok = await sheetsConnectionsApi.test(accountId, id)
      if (activeAccount.current === accountId && testVersions.current[id] === testVersion) {
        setTestResults((current) => ({ ...current, [id]: ok ? 'ok' : 'ng' }))
      }
    } catch (cause) {
      if (activeAccount.current === accountId && testVersions.current[id] === testVersion) {
        setTestResults((current) => ({ ...current, [id]: 'ng' }))
        setError(errorMessage(cause))
      }
    }
  }

  const handleSync = async (id: string) => {
    const accountId = selectedAccountId
    if (!accountId) return
    setError(null)
    const syncVersion = (syncVersions.current[id] ?? 0) + 1
    syncVersions.current[id] = syncVersion
    setSyncResults((current) => {
      const previous = current[id] ?? connections.find((connection) => connection.id === id)?.latestSyncJob
      return {
        ...current,
        [id]: {
          status: 'running',
          processedCount: previous?.processedCount ?? 0,
          totalCount: previous?.totalCount ?? 0,
          warning: null,
          errorMessage: null,
        },
      }
    })
    try {
      const job = await sheetsConnectionsApi.sync(accountId, id)
      if (activeAccount.current !== accountId || syncVersions.current[id] !== syncVersion) return
      setSyncResults((current) => ({ ...current, [id]: job }))
      if (job.status !== 'running') await refreshIfCurrent(accountId)
    } catch (cause) {
      if (activeAccount.current === accountId && syncVersions.current[id] === syncVersion) {
        const message = errorMessage(cause)
        setSyncResults((current) => ({
          ...current,
          [id]: {
            status: 'error',
            processedCount: current[id]?.processedCount ?? 0,
            totalCount: current[id]?.totalCount ?? 0,
            warning: null,
            errorMessage: message,
          },
        }))
        setError(message)
      }
    }
  }

  return (
    <div>
      <Header
        title="Google スプレッドシート連携"
        description="フォームごとの接続状態、最終同期、エラーをまとめて確認します。"
      />
      {loading ? (
        <p className="text-sm text-gray-500">LINEアカウントを読み込んでいます...</p>
      ) : !selectedAccountId ? (
        <div data-testid="sheets-account-required" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          先に左上で LINEアカウントを選択してください。
        </div>
      ) : (
        <SheetsConnectionsPanel
          key={selectedAccountId}
          connections={connections}
          onTest={(id) => { void handleTest(id) }}
          onSync={(id) => { void handleSync(id) }}
          testResults={testResults}
          syncResults={syncResults}
          auditEntries={auditEntries}
          error={error}
        />
      )}
    </div>
  )
}
