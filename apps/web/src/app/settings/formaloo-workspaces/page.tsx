'use client'

import { useState, useEffect, useCallback } from 'react'
import Header from '@/components/layout/header'
import FormalooWorkspacesPanel from '@/components/settings/formaloo-workspaces-panel'
import { formalooWorkspacesApi, type FormalooWorkspace } from '@/lib/formaloo-workspaces-api'

// F6-1: Formaloo workspace の API キー設定管理画面 (owner のみ / 静的 export 互換 = dynamic route なし / N-18)。

function errorMessage(e: unknown): string {
  const body = (e as { body?: { error?: string } })?.body
  if (body?.error) return body.error
  return '保存に失敗しました。しばらくしてからお試しください。'
}

export default function FormalooWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<FormalooWorkspace[]>([])
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

  useEffect(() => {
    void reload()
  }, [reload])

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
    </div>
  )
}
