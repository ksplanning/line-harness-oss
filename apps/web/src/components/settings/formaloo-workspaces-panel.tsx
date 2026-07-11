'use client'

import { useState } from 'react'
import type { FormalooWorkspace } from '@/lib/formaloo-workspaces-api'

// =============================================================================
// Formaloo workspace キー管理 パネル (F6-1 / T-A5 web)。表示専用 (state は親が保持)。
// -----------------------------------------------------------------------------
// - 登録済み workspace の一覧 (label / business slug / 有効状態) を出す。KEY/SECRET は API が返さない
//   ため一覧に出しようがない (write-only)。
// - 追加フォーム: label + KEY + SECRET (KEY/SECRET は password 入力でマスク)。
//   「追加」押下で即 KEY/SECRET を state から消す (保存後は画面に再表示しない)。
// =============================================================================

const LINE_GREEN = '#06C755'

export interface FormalooWorkspacesPanelProps {
  workspaces: FormalooWorkspace[]
  onAdd: (input: { label: string; key: string; secret: string; businessSlug: string }) => void
  onTest: (key: string, secret: string) => void
  onToggleActive: (id: string, isActive: boolean) => void
  onRemove: (id: string) => void
  testResult?: 'idle' | 'testing' | 'ok' | 'ng'
  addError?: string | null
  busy?: boolean
}

export default function FormalooWorkspacesPanel({
  workspaces,
  onAdd,
  onTest,
  onToggleActive,
  onRemove,
  testResult = 'idle',
  addError = null,
  busy = false,
}: FormalooWorkspacesPanelProps) {
  const [label, setLabel] = useState('')
  const [businessSlug, setBusinessSlug] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')

  const canSubmit = label.trim() !== '' && apiKey.trim() !== '' && apiSecret.trim() !== '' && !busy

  const submit = () => {
    if (!canSubmit) return
    onAdd({ label: label.trim(), key: apiKey.trim(), secret: apiSecret.trim(), businessSlug: businessSlug.trim() })
    // 保存後は鍵を画面に残さない (再表示しない / マスク)。label 等は成功後に親が再取得で反映。
    setApiKey('')
    setApiSecret('')
  }

  return (
    <div data-testid="formaloo-workspaces-panel" className="space-y-6">
      {/* 登録済み一覧 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">登録済みワークスペース</h2>
        {workspaces.length === 0 ? (
          <div data-testid="ws-empty" className="bg-white rounded-lg border border-gray-200 p-6 text-center text-gray-400 text-sm">
            まだ登録がありません。下の「ワークスペースを追加」から鍵を登録してください。
          </div>
        ) : (
          <ul data-testid="ws-list" className="space-y-2">
            {workspaces.map((ws) => (
              <li
                key={ws.id}
                data-testid={`ws-item-${ws.id}`}
                className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{ws.label}</p>
                  {ws.businessSlug && (
                    <p className="text-xs text-gray-400 truncate">{ws.businessSlug}</p>
                  )}
                </div>
                <span
                  data-testid={`ws-active-${ws.id}`}
                  className={`text-[11px] px-2 py-0.5 rounded-full ${ws.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                >
                  {ws.isActive ? '有効' : '無効'}
                </span>
                <button
                  type="button"
                  onClick={() => onToggleActive(ws.id, !ws.isActive)}
                  disabled={busy}
                  className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
                >
                  {ws.isActive ? '無効化' : '有効化'}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(ws.id)}
                  disabled={busy}
                  className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 追加フォーム */}
      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">ワークスペースを追加</h2>
        <p className="text-xs text-gray-400">
          API キーは暗号化して安全に保管されます。保存後は画面に再表示されません（もう一度確認したい場合は入力し直してください）。
        </p>

        <div className="space-y-1">
          <label className="text-xs text-gray-500">表示名（ラベル）</label>
          <input
            data-testid="ws-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例：A社アカウント"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-gray-500">ビジネス slug（任意）</label>
          <input
            data-testid="ws-business-slug"
            type="text"
            value={businessSlug}
            onChange={(e) => setBusinessSlug(e.target.value)}
            placeholder="任意"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-gray-500">API キー</label>
          <input
            data-testid="ws-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-gray-500">API シークレット</label>
          <input
            data-testid="ws-secret"
            type="password"
            autoComplete="off"
            value={apiSecret}
            onChange={(e) => setApiSecret(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        {addError && (
          <p data-testid="ws-add-error" className="text-xs text-red-600">{addError}</p>
        )}
        {testResult === 'ok' && (
          <p data-testid="ws-test-ok" className="text-xs text-green-600">接続に成功しました。</p>
        )}
        {testResult === 'ng' && (
          <p data-testid="ws-test-ng" className="text-xs text-red-600">接続できませんでした。キー・シークレットをご確認ください。</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            data-testid="ws-test-btn"
            onClick={() => onTest(apiKey.trim(), apiSecret.trim())}
            disabled={busy || apiKey.trim() === '' || apiSecret.trim() === '' || testResult === 'testing'}
            className="px-3 py-2 rounded-lg text-sm border border-gray-300 text-gray-700 disabled:opacity-50"
          >
            {testResult === 'testing' ? 'テスト中...' : '疎通テスト'}
          </button>
          <button
            type="button"
            data-testid="ws-add-btn"
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm text-white disabled:opacity-50"
            style={{ backgroundColor: LINE_GREEN }}
          >
            {busy ? '保存中...' : '追加する'}
          </button>
        </div>
      </section>
    </div>
  )
}
