'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FriendFieldDefinition } from '@line-crm/shared'
import Header from '@/components/layout/header'
import SheetsConnectionsPanel, {
  type SheetsConnectionDraft,
  type SheetsSyncResultState,
} from '@/components/settings/sheets-connections-panel'
import { useAccount } from '@/contexts/account-context'
import { api } from '@/lib/api'
import {
  sheetsConnectionsApi,
  type SheetsAuditEntry,
  type SheetsConnection,
  type UpdateSheetsConnectionInput,
} from '@/lib/sheets-connections-api'

type TestState = 'testing' | 'ok' | 'ng'

function errorMessage(error: unknown): string {
  const body = (error as { body?: { error?: string } })?.body
  return body?.error || '操作に失敗しました。入力内容と接続設定を確認してください。'
}

export default function SheetsSettingsPage() {
  const { selectedAccountId, loading } = useAccount()
  const [connections, setConnections] = useState<SheetsConnection[]>([])
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  const [testResults, setTestResults] = useState<Record<string, TestState>>({})
  const [syncResults, setSyncResults] = useState<Record<string, SheetsSyncResultState>>({})
  const [auditEntries, setAuditEntries] = useState<Record<string, SheetsAuditEntry[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
    let active = true
    void api.friendFieldDefinitions.list()
      .then((response) => {
        if (active && response.success) {
          setFieldDefinitions(
            response.data
              .filter((definition) => definition.isActive)
              .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id)),
          )
        }
      })
      .catch(() => {
        if (active) setFieldDefinitions([])
      })
    return () => { active = false }
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
    setBusy(false)
    if (selectedAccountId) void load(selectedAccountId)
  }, [selectedAccountId, load])

  const refreshIfCurrent = async (accountId: string) => {
    if (activeAccount.current === accountId) await load(accountId)
  }

  const handleCreate = async (input: SheetsConnectionDraft) => {
    const accountId = selectedAccountId
    if (!accountId) return
    setBusy(true)
    setError(null)
    try {
      await sheetsConnectionsApi.create({ lineAccountId: accountId, ...input })
      await refreshIfCurrent(accountId)
    } catch (cause) {
      if (activeAccount.current === accountId) setError(errorMessage(cause))
    } finally {
      if (activeAccount.current === accountId) setBusy(false)
    }
  }

  const handleUpdate = async (id: string, input: UpdateSheetsConnectionInput) => {
    const accountId = selectedAccountId
    if (!accountId) return
    setBusy(true)
    setError(null)
    testVersions.current[id] = (testVersions.current[id] ?? 0) + 1
    syncVersions.current[id] = (syncVersions.current[id] ?? 0) + 1
    setTestResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setSyncResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setAuditEntries((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    try {
      await sheetsConnectionsApi.update(accountId, id, input)
      await refreshIfCurrent(accountId)
    } catch (cause) {
      if (activeAccount.current === accountId) setError(errorMessage(cause))
    } finally {
      if (activeAccount.current === accountId) setBusy(false)
    }
  }

  const handleRemove = async (id: string) => {
    const accountId = selectedAccountId
    if (!accountId) return
    setBusy(true)
    setError(null)
    testVersions.current[id] = (testVersions.current[id] ?? 0) + 1
    syncVersions.current[id] = (syncVersions.current[id] ?? 0) + 1
    setTestResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setSyncResults((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setAuditEntries((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    try {
      await sheetsConnectionsApi.remove(accountId, id)
      await refreshIfCurrent(accountId)
    } catch (cause) {
      if (activeAccount.current === accountId) setError(errorMessage(cause))
    } finally {
      if (activeAccount.current === accountId) setBusy(false)
    }
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
        description="フォームごとに接続先と同期方向を登録し、実際に 1 セル読めるか確認します。"
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
          fieldDefinitions={fieldDefinitions}
          onCreate={(input) => { void handleCreate(input) }}
          onUpdate={(id, input) => { void handleUpdate(id, input) }}
          onRemove={(id) => { void handleRemove(id) }}
          onTest={(id) => { void handleTest(id) }}
          onSync={(id) => { void handleSync(id) }}
          testResults={testResults}
          syncResults={syncResults}
          auditEntries={auditEntries}
          error={error}
          busy={busy}
        />
      )}
    </div>
  )
}
