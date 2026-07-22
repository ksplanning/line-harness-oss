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
    setSyncResults((current) => ({ ...current, [id]: { status: 'running' } }))
    try {
      const summary = await sheetsConnectionsApi.sync(accountId, id)
      if (activeAccount.current !== accountId || syncVersions.current[id] !== syncVersion) return
      if (summary.status === 'failed') {
        setSyncResults((current) => ({
          ...current,
          [id]: { status: 'failed', message: summary.warning ?? '手動同期に失敗しました。' },
        }))
        return
      }
      const status = summary.status === 'warning' || summary.warning ? 'warning' : 'success'
      setSyncResults((current) => ({ ...current, [id]: { status, summary } }))
      await refreshIfCurrent(accountId)
    } catch (cause) {
      if (activeAccount.current === accountId && syncVersions.current[id] === syncVersion) {
        const message = errorMessage(cause)
        setSyncResults((current) => ({ ...current, [id]: { status: 'failed', message } }))
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
