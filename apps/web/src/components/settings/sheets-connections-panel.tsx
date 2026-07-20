'use client'

import { useState } from 'react'
import type {
  SheetsConnection,
  SheetsSyncDirection,
  UpdateSheetsConnectionInput,
} from '@/lib/sheets-connections-api'

type TestState = 'testing' | 'ok' | 'ng'

export interface SheetsConnectionDraft {
  formId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
}

export interface SheetsConnectionsPanelProps {
  connections: SheetsConnection[]
  onCreate: (input: SheetsConnectionDraft) => void
  onUpdate: (id: string, input: UpdateSheetsConnectionInput) => void
  onRemove: (id: string) => void
  onTest: (id: string) => void
  testResults: Record<string, TestState>
  error?: string | null
  busy?: boolean
}

const DIRECTION_LABELS: Record<SheetsSyncDirection, string> = {
  bidirectional: '双方向',
  to_sheets: '回答 → シート',
  from_sheets: 'シート → ハーネス',
}

export default function SheetsConnectionsPanel({
  connections,
  onCreate,
  onUpdate,
  onRemove,
  onTest,
  testResults,
  error = null,
  busy = false,
}: SheetsConnectionsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formId, setFormId] = useState('')
  const [spreadsheetId, setSpreadsheetId] = useState('')
  const [sheetName, setSheetName] = useState('Sheet1')
  const [syncDirection, setSyncDirection] = useState<SheetsSyncDirection>('bidirectional')

  const resetDraft = () => {
    setEditingId(null)
    setFormId('')
    setSpreadsheetId('')
    setSheetName('Sheet1')
    setSyncDirection('bidirectional')
  }

  const beginEdit = (connection: SheetsConnection) => {
    setEditingId(connection.id)
    setFormId(connection.formId)
    setSpreadsheetId(connection.spreadsheetId)
    setSheetName(connection.sheetName)
    setSyncDirection(connection.syncDirection)
  }

  const canSave = Boolean(formId.trim() && spreadsheetId.trim() && sheetName.trim() && !busy)

  const save = () => {
    if (!canSave) return
    const mutable = {
      spreadsheetId: spreadsheetId.trim(),
      sheetName: sheetName.trim(),
      syncDirection,
    }
    if (editingId) onUpdate(editingId, mutable)
    else onCreate({ formId: formId.trim(), ...mutable })
  }

  return (
    <div data-testid="sheets-connections-panel" className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">登録済みの接続</h2>
        {connections.length === 0 ? (
          <div data-testid="sheets-empty" className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            まだ接続設定がありません。下の欄から最初の接続を登録してください。
          </div>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => {
              const testState = testResults[connection.id]
              return (
                <li
                  key={connection.id}
                  data-testid={`sheets-item-${connection.id}`}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-3"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-900">フォーム: {connection.formId}</p>
                      <p className="truncate text-xs text-gray-500">シート: {connection.sheetName}</p>
                      <p className="truncate text-xs text-gray-400">ID: {connection.spreadsheetId}</p>
                      <p className="mt-1 text-xs text-gray-500">同期: {DIRECTION_LABELS[connection.syncDirection]}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid={`sheets-test-${connection.id}`}
                        onClick={() => onTest(connection.id)}
                        disabled={busy || testState === 'testing'}
                        className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                      >
                        {testState === 'testing' ? '確認中...' : '接続テスト'}
                      </button>
                      <button
                        type="button"
                        data-testid={`sheets-edit-${connection.id}`}
                        onClick={() => beginEdit(connection)}
                        disabled={busy}
                        className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        data-testid={`sheets-remove-${connection.id}`}
                        onClick={() => onRemove(connection.id)}
                        disabled={busy}
                        className="px-2 py-1.5 text-xs text-red-600 disabled:opacity-50"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  {testState === 'ok' && (
                    <p data-testid={`sheets-test-result-${connection.id}`} className="mt-2 text-xs text-green-700">
                      接続できました（先頭セルを 1 回読み取りました）。
                    </p>
                  )}
                  {testState === 'ng' && (
                    <p data-testid={`sheets-test-result-${connection.id}`} className="mt-2 text-xs text-red-600">
                      接続できませんでした。シート共有とサービスアカウント設定を確認してください。
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">{editingId ? '接続設定を編集' : '接続設定を追加'}</h2>
          <p className="mt-1 text-xs text-gray-400">
            Google の秘密鍵はこの画面には入力しません。Worker secret にだけ保存します。
          </p>
        </div>

        <label className="block space-y-1 text-xs text-gray-600">
          <span>フォーム ID</span>
          <input
            data-testid="sheets-form-id"
            value={formId}
            disabled={Boolean(editingId)}
            onChange={(event) => setFormId(event.target.value)}
            placeholder="例: form_123"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"
          />
        </label>

        <label className="block space-y-1 text-xs text-gray-600">
          <span>スプレッドシート ID</span>
          <input
            data-testid="sheets-spreadsheet-id"
            value={spreadsheetId}
            onChange={(event) => setSpreadsheetId(event.target.value)}
            placeholder="URL の /d/ と /edit の間の文字列"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1 text-xs text-gray-600">
          <span>シート名</span>
          <input
            data-testid="sheets-sheet-name"
            value={sheetName}
            onChange={(event) => setSheetName(event.target.value)}
            placeholder="Sheet1"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
        </label>

        <label className="block space-y-1 text-xs text-gray-600">
          <span>同期方向</span>
          <select
            data-testid="sheets-direction"
            value={syncDirection}
            onChange={(event) => setSyncDirection(event.target.value as SheetsSyncDirection)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="bidirectional">双方向（回答 → シート / シート → ハーネス）</option>
            <option value="to_sheets">回答 → シート</option>
            <option value="from_sheets">シート → ハーネス</option>
          </select>
        </label>

        {error && <p data-testid="sheets-error" className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            data-testid="sheets-save"
            disabled={!canSave}
            onClick={save}
            className="rounded-lg bg-[#06C755] px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {busy ? '保存中...' : editingId ? '変更を保存' : '接続を登録'}
          </button>
          {editingId && (
            <button type="button" onClick={resetDraft} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700">
              キャンセル
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
