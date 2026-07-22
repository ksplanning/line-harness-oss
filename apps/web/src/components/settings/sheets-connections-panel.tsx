'use client'

import Link from 'next/link'
import type {
  SheetsAuditEntry,
  SheetsConnection,
  SheetsSyncDirection,
  SheetsSyncJobStatus,
} from '@/lib/sheets-connections-api'

type TestState = 'testing' | 'ok' | 'ng'

export interface SheetsSyncResultState {
  id?: string
  createdAt?: string
  status: SheetsSyncJobStatus
  source?: 'manual' | 'polling'
  processedCount?: number
  totalCount?: number
  warning?: string | null
  errorMessage?: string | null
  updatedAt?: string
}

export interface SheetsConnectionsPanelProps {
  connections: SheetsConnection[]
  onTest: (id: string) => void
  onSync: (id: string) => void
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
  identity_sync: '識別項目をシートへ反映',
  conflict: '競合（後の変更を採用）',
  identity_ignored: '識別項目の変更を無視',
}

const AUDIT_OUTCOME_LABELS: Record<string, string> = {
  applied: '反映済み',
  skipped: '安全のため取り込まず',
  failed: '反映失敗',
}

function formName(connection: SheetsConnection): string {
  return connection.formName?.trim() || 'フォーム名を確認できません'
}

export default function SheetsConnectionsPanel({
  connections,
  onTest,
  onSync,
  testResults,
  syncResults,
  auditEntries,
  error = null,
  busy = false,
}: SheetsConnectionsPanelProps) {
  return (
    <div data-testid="sheets-connections-panel" className="space-y-6">
      <section className="rounded-lg border border-green-200 bg-green-50 p-4">
        <h2 className="text-sm font-semibold text-green-900">接続の追加・変更はフォームから行います</h2>
        <p className="mt-1 text-sm text-green-800">
          各フォームのビルダーを開き、「回答後の動き」にある自前シート連携から設定してください。
          このページでは、接続状態と同期結果をまとめて確認できます。
        </p>
        <Link
          href="/forms-advanced"
          className="mt-3 inline-flex rounded-lg bg-[#087A39] px-4 py-2 text-sm font-medium text-white"
        >
          フォーム一覧を開く
        </Link>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">接続状況</h2>
        {connections.length === 0 ? (
          <div data-testid="sheets-empty" className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600">
            接続中のフォームはありません。フォーム一覧から設定してください。
          </div>
        ) : (
          <ul className="space-y-2">
            {connections.map((connection) => {
              const name = formName(connection)
              const testState = testResults[connection.id]
              const syncState = syncResults[connection.id] ?? connection.latestSyncJob ?? undefined
              const syncLabel = syncState?.source === 'polling' ? '定期同期' : '手動同期'
              const audits = auditEntries[connection.id] ?? []
              const mappings = connection.friendFieldMappings ?? []
              const lastSyncStatus = connection.lastSyncStatus ?? 'idle'
              const hasDurableIssue = Boolean(syncState?.warning)
                || syncState?.status === 'warning'
                || syncState?.status === 'error'
              const lastError = (syncState?.status === 'error' ? syncState.errorMessage : null)
                || (!hasDurableIssue ? connection.lastSyncWarning : null)
                || (lastSyncStatus === 'error' ? '前回の同期に失敗しました。接続テストで共有設定を確認してください。' : 'ありません')

              return (
                <li
                  key={connection.id}
                  data-testid={`sheets-item-${connection.id}`}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-3"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">{name}</p>
                      <p className="truncate text-xs text-gray-500">対応シート: {connection.sheetName}</p>
                      <p className="mt-1 text-xs text-gray-600">接続状態: {connection.isActive ? '接続中' : '停止中'}</p>
                      <p className="mt-1 text-xs text-gray-600">同期方向: {DIRECTION_LABELS[connection.syncDirection]}</p>
                      <p className="mt-1 text-xs text-gray-600">同期状態: {SYNC_STATUS_LABELS[lastSyncStatus]}</p>
                      <p className="mt-1 text-xs text-gray-600">最終同期: {connection.lastSyncAt ?? 'まだありません'}</p>
                      <p className="mt-1 text-xs text-gray-600">
                        同期項目: {mappings.length > 0 ? mappings.map((mapping) => mapping.header).join(' / ') : '全項目'}
                      </p>
                      <p className={`mt-1 text-xs ${lastError === 'ありません' ? 'text-gray-600' : 'text-amber-800'}`}>
                        エラー: {lastError}
                      </p>
                      <Link
                        href={`/forms-advanced/detail?id=${encodeURIComponent(connection.formId)}`}
                        aria-label={`${name}の「回答後の動き」を開く`}
                        className="mt-2 inline-flex text-xs font-medium text-[#087A39] underline"
                      >
                        ビルダーの「回答後の動き」で設定する
                      </Link>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid={`sheets-test-${connection.id}`}
                        onClick={() => onTest(connection.id)}
                        aria-label={`${name}の接続テスト`}
                        disabled={busy || testState === 'testing'}
                        className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
                      >
                        {testState === 'testing' ? '確認中...' : '接続テスト'}
                      </button>
                      <button
                        type="button"
                        data-testid={`sheets-sync-${connection.id}`}
                        onClick={() => onSync(connection.id)}
                        aria-label={`${name}を手動同期`}
                        disabled={busy || testState === 'testing' || syncState?.status === 'running'}
                        className="rounded border border-[#087A39] px-3 py-1.5 text-xs text-[#087A39] disabled:opacity-50"
                      >
                        {syncState?.status === 'running'
                          ? '同期中...'
                          : syncState?.status === 'error' ? '続きから再開' : '手動同期'}
                      </button>
                    </div>
                  </div>
                  {testState === 'ok' && (
                    <p role="status" data-testid={`sheets-test-result-${connection.id}`} className="mt-2 text-xs text-green-700">
                      接続できました。
                    </p>
                  )}
                  {testState === 'ng' && (
                    <p role="alert" data-testid={`sheets-test-result-${connection.id}`} className="mt-2 text-xs text-red-600">
                      接続できませんでした。スプレッドシートの共有設定を確認してください。
                    </p>
                  )}
                  {connection.lastSyncWarning && !hasDurableIssue && (
                    <p role="alert" className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      {connection.lastSyncWarning}
                    </p>
                  )}
                  {syncState?.status === 'running' && (
                    <p role="status" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-blue-700">
                      処理済み {syncState.processedCount ?? 0} / {syncState.totalCount ?? 0}件
                    </p>
                  )}
                  {syncState?.status === 'running' && syncState.warning && (
                    <p role="alert" className="mt-2 text-xs text-amber-800">
                      {syncState.warning}
                    </p>
                  )}
                  {syncState?.status === 'success' && (
                    <p role="status" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-green-700">
                      {syncLabel}が完了しました。
                    </p>
                  )}
                  {syncState?.status === 'warning' && (
                    <p role="alert" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-amber-800">
                      {syncLabel}は警告つきで完了しました。
                      {syncState.processedCount ?? 0} / {syncState.totalCount ?? 0}件を処理しました。
                      {syncState.warning ?? ''}
                    </p>
                  )}
                  {syncState?.status === 'error' && (
                    <p role="alert" data-testid={`sheets-sync-result-${connection.id}`} className="mt-2 text-xs text-red-600">
                      同期は途中で停止しました。{syncState.processedCount ?? 0} / {syncState.totalCount ?? 0}件まで処理しました。
                      {syncState.errorMessage ?? '続きから再開してください。'}
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
                            {entry.outcome && ` · ${AUDIT_OUTCOME_LABELS[entry.outcome] ?? entry.outcome}`}
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

      {error && <p role="alert" data-testid="sheets-error" className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
