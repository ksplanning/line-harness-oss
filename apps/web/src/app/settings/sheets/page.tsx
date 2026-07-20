'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import SheetsConnectionsPanel from '@/components/settings/sheets-connections-panel'
import { useAccount } from '@/contexts/account-context'
import {
  sheetsConnectionsApi,
  type SheetsConnection,
  type SheetsSyncDirection,
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
  const [testResults, setTestResults] = useState<Record<string, TestState>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef(0)
  const activeAccount = useRef<string | null>(selectedAccountId)
  activeAccount.current = selectedAccountId

  const load = useCallback(async (accountId: string) => {
    const version = ++requestVersion.current
    setError(null)
    try {
      const list = await sheetsConnectionsApi.list(accountId)
      if (version === requestVersion.current && activeAccount.current === accountId) setConnections(list)
    } catch (cause) {
      if (version === requestVersion.current && activeAccount.current === accountId) {
        setConnections([])
        setError(errorMessage(cause))
      }
    }
  }, [])

  useEffect(() => {
    requestVersion.current += 1
    setConnections([])
    setTestResults({})
    setError(null)
    setBusy(false)
    if (selectedAccountId) void load(selectedAccountId)
  }, [selectedAccountId, load])

  const refreshIfCurrent = async (accountId: string) => {
    if (activeAccount.current === accountId) await load(accountId)
  }

  const handleCreate = async (input: {
    formId: string
    spreadsheetId: string
    sheetName: string
    syncDirection: SheetsSyncDirection
  }) => {
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
    try {
      await sheetsConnectionsApi.update(id, input)
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
    try {
      await sheetsConnectionsApi.remove(id)
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
    setTestResults((current) => ({ ...current, [id]: 'testing' }))
    try {
      const ok = await sheetsConnectionsApi.test(id)
      if (activeAccount.current === accountId) {
        setTestResults((current) => ({ ...current, [id]: ok ? 'ok' : 'ng' }))
      }
    } catch (cause) {
      if (activeAccount.current === accountId) {
        setTestResults((current) => ({ ...current, [id]: 'ng' }))
        setError(errorMessage(cause))
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
          connections={connections}
          onCreate={(input) => { void handleCreate(input) }}
          onUpdate={(id, input) => { void handleUpdate(id, input) }}
          onRemove={(id) => { void handleRemove(id) }}
          onTest={(id) => { void handleTest(id) }}
          testResults={testResults}
          error={error}
          busy={busy}
        />
      )}
    </div>
  )
}
