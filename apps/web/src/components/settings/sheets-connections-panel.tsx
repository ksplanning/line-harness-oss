'use client'

import { useState } from 'react'
import type { FriendFieldDefinition } from '@line-crm/shared'
import type {
  SheetsAuditEntry,
  SheetsConnection,
  SheetsSyncSummary,
  SheetsSyncDirection,
  UpdateSheetsConnectionInput,
} from '@/lib/sheets-connections-api'

type TestState = 'testing' | 'ok' | 'ng'

export type SheetsSyncResultState =
  | { status: 'running' }
  | { status: 'success' | 'warning'; summary: SheetsSyncSummary }
  | { status: 'failed'; message: string }

export interface SheetsConnectionDraft {
  formId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
  selectedFieldIds: string[]
}

export interface SheetsConnectionsPanelProps {
  connections: SheetsConnection[]
  onCreate: (input: SheetsConnectionDraft) => void
  onUpdate: (id: string, input: UpdateSheetsConnectionInput) => void
  onRemove: (id: string) => void
  onTest: (id: string) => void
  onSync: (id: string) => void
  fieldDefinitions: readonly FriendFieldDefinition[]
  testResults: Record<string, TestState>
  syncResults: Record<string, SheetsSyncResultState>
  auditEntries: Record<string, SheetsAuditEntry[]>
  error?: string | null
  busy?: boolean
}

const DIRECTION_LABELS: Record<SheetsSyncDirection, string> = {
  bidirectional: '双方向',
  to_sheets: '友だち情報 → シート',
  from_sheets: 'シート → 友だち情報',
}

const SYNC_STATUS_LABELS: Record<SheetsConnection['lastSyncStatus'], string> = {
  idle: '未同期',
  running: '同期中',
  success: '成功',
  warning: '警告',
  error: '失敗',
}

const AUDIT_SOURCE_LABELS: Record<string, string> = {
  sheet: 'シート',
  harness: 'ハーネス',
  polling: 'ポーリング',
  webhook: 'Webhook',
  manual: '手動同期',
}

const AUDIT_CHANGE_LABELS: Record<string, string> = {
  custom_field: 'カスタムフィールド更新',
  conflict: '競合（後の変更を採用）',
  identity_ignored: '識別項目の変更を無視',
}

export default function SheetsConnectionsPanel({
  connections,
  onCreate,
  onUpdate,
  onRemove,
  onTest,
  onSync,
  fieldDefinitions,
  testResults,
  syncResults,
  auditEntries,
  error = null,
  busy = false,
}: SheetsConnectionsPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formId, setFormId] = useState('')
  const [spreadsheetId, setSpreadsheetId] = useState('')
  const [sheetName, setSheetName] = useState('Sheet1')
  const [syncDirection, setSyncDirection] = useState<SheetsSyncDirection>('bidirectional')
  const [selectedFieldIds, setSelectedFieldIds] = useState<string[]>([])

  const resetDraft = () => {
    setEditingId(null)
    setFormId('')
    setSpreadsheetId('')
    setSheetName('Sheet1')
    setSyncDirection('bidirectional')
    setSelectedFieldIds([])
  }

  const beginEdit = (connection: SheetsConnection) => {
    setEditingId(connection.id)
    setFormId(connection.formId)
    setSpreadsheetId(connection.spreadsheetId)
    setSheetName(connection.sheetName)
    setSyncDirection(connection.syncDirection)
    const activeIds = new Set(fieldDefinitions.map((definition) => definition.id))
    setSelectedFieldIds(
      (connection.friendFieldMappings ?? []).map((mapping) => mapping.fieldId).filter((id) => activeIds.has(id)),
    )
  }

  const canSave = Boolean(formId.trim() && spreadsheetId.trim() && sheetName.trim() && !busy)

  const save = () => {
    if (!canSave) return
    const mutable = {
      spreadsheetId: spreadsheetId.trim(),
      sheetName: sheetName.trim(),
      syncDirection,
      selectedFieldIds,
    }
    if (editingId) onUpdate(editingId, mutable)
    else onCreate({ formId: formId.trim(), ...mutable })
  }

  const toggleField = (fieldId: string, checked: boolean) => {
    setSelectedFieldIds((current) => checked
      ? current.includes(fieldId) ? current : [...current, fieldId]
      : current.filter((id) => id !== fieldId))
  }

  return (
    <div data-testid="sheets-connections-panel" className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">登録済みの接続</h2>
        {connections.length === 0 ? (
          <div data-testid="sheets-empty" className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600">
            まだ接続設定がありません。下の欄から最初の接続を登録してください。
          </div>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => {
              const testState = testResults[connection.id]
              const syncState = syncResults[connection.id]
              const audits = auditEntries[connection.id] ?? []
              const mappings = connection.friendFieldMappings ?? []
              const lastSyncStatus = connection.lastSyncStatus ?? 'idle'
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
                      <p className="truncate text-xs text-gray-600">ID: {connection.spreadsheetId}</p>
                      <p className="mt-1 text-xs text-gray-500">同期: {DIRECTION_LABELS[connection.syncDirection]}</p>
                      <p className="mt-1 text-xs text-gray-500">
                        同期項目: {mappings.length > 0 ? mappings.map((mapping) => mapping.header).join(' / ') : '未選択'}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        最終同期: {connection.lastSyncAt ?? 'まだありません'}（{SYNC_STATUS_LABELS[lastSyncStatus]}）
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid={`sheets-test-${connection.id}`}
                        onClick={() => onTest(connection.id)}
                        aria-label={`${connection.formId} の接続テスト`}
                        disabled={busy || testState === 'testing'}
                        className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                      >
                        {testState === 'testing' ? '確認中...' : '接続テスト'}
                      </button>
                      <button
                        type="button"
                        data-testid={`sheets-sync-${connection.id}`}
                        onClick={() => onSync(connection.id)}
                        aria-label={`${connection.formId} を手動同期`}
                        disabled={busy || testState === 'testing' || syncState?.status === 'running'}
                        className="rounded border border-[#087A39] px-3 py-1.5 text-xs text-[#087A39] disabled:opacity-50"
                      >
                        {syncState?.status === 'running' ? '同期中...' : '手動同期'}
                      </button>
                      <button
                        type="button"
                        data-testid={`sheets-edit-${connection.id}`}
                        onClick={() => beginEdit(connection)}
                        aria-label={`${connection.formId} の接続設定を編集`}
                        disabled={busy || testState === 'testing'}
                        className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        data-testid={`sheets-remove-${connection.id}`}
                        onClick={() => {
                          if (window.confirm(`${connection.formId} の接続設定を削除しますか？`)) onRemove(connection.id)
                        }}
                        aria-label={`${connection.formId} の接続設定を削除`}
                        disabled={busy || testState === 'testing'}
                        className="px-2 py-1.5 text-xs text-red-600 disabled:opacity-50"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                  {testState === 'ok' && (
                    <p role="status" data-testid={`sheets-test-result-${connection.id}`} className="mt-2 text-xs text-green-700">
                      接続できました（先頭セルを 1 回読み取りました）。
                    </p>
                  )}
                  {testState === 'ng' && (
                    <p role="alert" data-testid={`sheets-test-result-${connection.id}`} className="mt-2 text-xs text-red-600">
                      接続できませんでした。シート共有とサービスアカウント設定を確認してください。
                    </p>
                  )}
                  {connection.lastSyncWarning && (
                    <p role="alert" className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {connection.lastSyncWarning}
                    </p>
                  )}
                  {syncState?.status === 'success' && (
                    <p role="status" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-green-700">
                      手動同期が完了しました。
                    </p>
                  )}
                  {syncState?.status === 'warning' && (
                    <p role="alert" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-amber-800">
                      手動同期は警告つきで完了しました。{syncState.summary.warning ?? ''}
                    </p>
                  )}
                  {syncState?.status === 'failed' && (
                    <p role="alert" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-red-600">
                      {syncState.message}
                    </p>
                  )}
                  {audits.length > 0 && (
                    <section data-testid={`sheets-audit-${connection.id}`} className="mt-3 border-t border-gray-100 pt-3">
                      <h3 className="text-xs font-semibold text-gray-700">最近の監査</h3>
                      <ul className="mt-1 space-y-1">
                        {audits.map((entry, index) => (
                          <li key={`${entry.fieldName}-${index}`} className="text-xs text-gray-600">
                            <span>{entry.actor}</span>
                            {' · '}{entry.fieldName}: {entry.oldValue ?? '（空）'} → {entry.newValue ?? '（空）'}
                            {' · '}{AUDIT_SOURCE_LABELS[entry.source] ?? entry.source}
                            {' · '}{AUDIT_CHANGE_LABELS[entry.changeKind] ?? entry.changeKind}
                          </li>
                        ))}
                      </ul>
                    </section>
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
          <p className="mt-1 text-xs text-gray-600">
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
            <option value="bidirectional">双方向（友だち情報 ↔ シート）</option>
            <option value="to_sheets">友だち情報 → シート</option>
            <option value="from_sheets">シート → 友だち情報</option>
          </select>
        </label>

        <fieldset className="space-y-2">
          <legend className="text-xs text-gray-600">同期するカスタムフィールド</legend>
          {fieldDefinitions.length === 0 ? (
            <p className="text-xs text-gray-500">同期できる有効なカスタムフィールドはありません。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {fieldDefinitions.map((definition) => (
                <label key={definition.id} className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={selectedFieldIds.includes(definition.id)}
                    onChange={(event) => toggleField(definition.id, event.target.checked)}
                  />
                  <span>{definition.name}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {error && <p role="alert" data-testid="sheets-error" className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            data-testid="sheets-save"
            disabled={!canSave}
            onClick={save}
            className="rounded-lg bg-[#087A39] px-4 py-2 text-sm text-white disabled:opacity-50"
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
