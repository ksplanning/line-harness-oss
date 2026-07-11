'use client'

import { useState, useEffect, useCallback } from 'react'
import Header from '@/components/layout/header'
import FormalooWorkspacesPanel from '@/components/settings/formaloo-workspaces-panel'
import FormalooAccountBindingsPanel, { type AccountLite } from '@/components/settings/formaloo-account-bindings-panel'
import { formalooWorkspacesApi, type FormalooWorkspace } from '@/lib/formaloo-workspaces-api'
import { formalooAccountBindingsApi } from '@/lib/formaloo-account-bindings-api'
import { api } from '@/lib/api'

// F6-1/F6-2: Formaloo workspace の API キー設定管理 + アカウント→既定 workspace binding (owner のみ /
//   静的 export 互換 = dynamic route なし / N-18)。

function errorMessage(e: unknown): string {
  const body = (e as { body?: { error?: string } })?.body
  if (body?.error) return body.error
  return '保存に失敗しました。しばらくしてからお試しください。'
}

export default function FormalooWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<FormalooWorkspace[]>([])
  const [accounts, setAccounts] = useState<AccountLite[]>([])
  const [bindings, setBindings] = useState<Record<string, string | null>>({})
  const [testResult, setTestResult] = useState<'idle' | 'testing' | 'ok' | 'ng'>('idle')
  const [addError, setAddError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setWorkspaces(await formalooWorkspacesApi.list())
    } catch {
      // 権限なし (非 owner) 等は空表示 (enforcement は worker 側)。
      setWorkspaces([])
    }
  }, [])

  const reloadBindings = useCallback(async () => {
    try {
      const list = await formalooAccountBindingsApi.list()
      setBindings(Object.fromEntries(list.map((b) => [b.lineAccountId, b.defaultWorkspaceId])))
    } catch {
      setBindings({})
    }
  }, [])

  useEffect(() => {
    void reload()
    void reloadBindings()
    void (async () => {
      try {
        const res = await api.lineAccounts.list()
        if (res.success) setAccounts((res.data as AccountLite[]) ?? [])
      } catch {
        setAccounts([])
      }
    })()
  }, [reload, reloadBindings])

  const handleSetBinding = async (lineAccountId: string, workspaceId: string) => {
    setBusy(true)
    try {
      await formalooAccountBindingsApi.set(lineAccountId, workspaceId)
      await reloadBindings()
    } catch {
      /* enforcement は worker 側 (非 owner 403 等) */
    } finally {
      setBusy(false)
    }
  }

  const handleClearBinding = async (lineAccountId: string) => {
    setBusy(true)
    try {
      await formalooAccountBindingsApi.clear(lineAccountId)
      await reloadBindings()
    } finally {
      setBusy(false)
    }
  }

  const handleAdd = async (input: { label: string; key: string; secret: string; businessSlug: string }) => {
    setBusy(true)
    setAddError(null)
    setTestResult('idle')
    try {
      await formalooWorkspacesApi.add({ ...input, businessSlug: input.businessSlug || null })
      await reload()
    } catch (e) {
      setAddError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async (key: string, secret: string) => {
    if (!key || !secret) return
    setTestResult('testing')
    try {
      const ok = await formalooWorkspacesApi.test(key, secret)
      setTestResult(ok ? 'ok' : 'ng')
    } catch {
      setTestResult('ng')
    }
  }

  const handleToggle = async (id: string, isActive: boolean) => {
    setBusy(true)
    try {
      await formalooWorkspacesApi.setActive(id, isActive)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (id: string) => {
    setBusy(true)
    try {
      await formalooWorkspacesApi.remove(id)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Header
        title="Formaloo ワークスペース"
        description="複数の Formaloo ワークスペースの API キーを安全に登録・切替できます（キーは暗号化して保管され、画面には再表示されません）"
      />
      <FormalooWorkspacesPanel
        workspaces={workspaces}
        onAdd={handleAdd}
        onTest={handleTest}
        onToggleActive={handleToggle}
        onRemove={handleRemove}
        testResult={testResult}
        addError={addError}
        busy={busy}
      />
      <div className="mt-8">
        <FormalooAccountBindingsPanel
          accounts={accounts}
          workspaces={workspaces.filter((w) => w.isActive)}
          bindings={bindings}
          onSet={handleSetBinding}
          onClear={handleClearBinding}
          busy={busy}
        />
      </div>
    </div>
  )
}
