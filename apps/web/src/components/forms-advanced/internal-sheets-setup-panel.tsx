'use client'

import { useMemo, useRef, useState } from 'react'
import {
  extractGoogleSpreadsheetId,
  getInternalSubmissionNotificationAnswerFields,
  type HarnessField,
} from '@line-crm/shared'

export type InternalSheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional'

export interface InternalSheetsSetupConnection {
  spreadsheetId: string
  sheetName: string
  syncDirection: InternalSheetsSyncDirection
  /** null/undefined means every syncable form field for backward compatibility. */
  selectedFormFieldIds?: string[] | null
}

export interface InternalSheetsInspectResult {
  spreadsheetId: string
  sheetNames: string[]
}

export interface InternalSheetsSaveInput {
  spreadsheetId: string
  sheetName: string
  syncDirection: InternalSheetsSyncDirection
  selectedFormFieldIds: string[]
}

export interface InternalSheetsSetupPanelProps {
  serviceAccountEmail: string | null
  connection?: InternalSheetsSetupConnection | null
  fields: readonly HarnessField[]
  onInspect: (url: string) => Promise<InternalSheetsInspectResult>
  onSave: (input: InternalSheetsSaveInput) => Promise<void>
}

type Feedback = { kind: 'error' | 'success'; text: string }

const PERMISSION_MESSAGE = 'スプレッドシートの共有設定に上のアドレスを追加してください'

function japaneseMessage(value: unknown): string | null {
  return typeof value === 'string' && /[ぁ-んァ-ヶ一-龠]/.test(value) ? value : null
}

function dailyError(error: unknown, fallback: string): string {
  const direct = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const body = direct?.body && typeof direct.body === 'object'
    ? direct.body as Record<string, unknown>
    : null
  const category = body?.category ?? direct?.category
  const raw = body?.error ?? direct?.error ?? (error instanceof Error ? error.message : null)
  if (
    category === 'sheet_permission'
    || (typeof raw === 'string' && /(permission|forbidden|\b403\b)/i.test(raw))
  ) {
    return PERMISSION_MESSAGE
  }
  return japaneseMessage(raw) ?? fallback
}

function uniqueSheetNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function initialUrl(connection: InternalSheetsSetupConnection | null | undefined): string {
  return connection
    ? `https://docs.google.com/spreadsheets/d/${connection.spreadsheetId}/edit`
    : ''
}

export default function InternalSheetsSetupPanel({
  serviceAccountEmail,
  connection = null,
  fields,
  onInspect,
  onSave,
}: InternalSheetsSetupPanelProps) {
  const syncableFields = useMemo(
    () => getInternalSubmissionNotificationAnswerFields(fields).filter((field) => (
      field.type !== 'variable' || field.config.variableSubType === 'formula'
    )),
    [fields],
  )
  const allFieldIds = useMemo(() => syncableFields.map((field) => field.id), [syncableFields])
  const [sharedUrl, setSharedUrl] = useState(() => initialUrl(connection))
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(connection?.spreadsheetId ?? null)
  const [sheetNames, setSheetNames] = useState<string[]>(() => connection ? [connection.sheetName] : [])
  const [sheetName, setSheetName] = useState(connection?.sheetName ?? '')
  const [syncDirection, setSyncDirection] = useState<InternalSheetsSyncDirection>(
    connection?.syncDirection ?? 'bidirectional',
  )
  const [selectedFormFieldIds, setSelectedFormFieldIds] = useState<string[]>(() => {
    const configured = connection?.selectedFormFieldIds
    if (!Array.isArray(configured)) return allFieldIds
    const selected = new Set(configured)
    return allFieldIds.filter((id) => selected.has(id))
  })
  const [busy, setBusy] = useState<'inspect' | 'save' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const inspectGeneration = useRef(0)

  const resetInspection = () => {
    inspectGeneration.current += 1
    setBusy(null)
    setSpreadsheetId(null)
    setSheetNames([])
    setSheetName('')
  }

  const inspect = async () => {
    const url = sharedUrl.trim()
    if (!extractGoogleSpreadsheetId(url)) {
      resetInspection()
      setFeedback({ kind: 'error', text: 'Google スプレッドシートの共有URLを貼り付けてください。' })
      return
    }

    const generation = ++inspectGeneration.current
    setSpreadsheetId(null)
    setSheetNames([])
    setSheetName('')
    setFeedback(null)
    setBusy('inspect')
    try {
      const inspected = await onInspect(url)
      if (generation !== inspectGeneration.current) return
      const nextSheetNames = uniqueSheetNames(inspected.sheetNames)
      if (!nextSheetNames.length) {
        setFeedback({ kind: 'error', text: '選べるシート（タブ）が見つかりませんでした。' })
        return
      }
      setSpreadsheetId(inspected.spreadsheetId)
      setSheetNames(nextSheetNames)
      setSheetName(nextSheetNames.includes(connection?.sheetName ?? '')
        ? connection?.sheetName ?? nextSheetNames[0]
        : nextSheetNames[0])
      setFeedback({ kind: 'success', text: '接続できました。対応するシート（タブ）を選んでください。' })
    } catch (error) {
      if (generation !== inspectGeneration.current) return
      setFeedback({
        kind: 'error',
        text: dailyError(error, '接続を確認できませんでした。共有設定を確認して、もう一度お試しください。'),
      })
    } finally {
      if (generation === inspectGeneration.current) setBusy(null)
    }
  }

  const copyServiceAccountEmail = async () => {
    if (!serviceAccountEmail) return
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(serviceAccountEmail)
      setFeedback({ kind: 'success', text: 'メールアドレスをコピーしました。' })
    } catch {
      setFeedback({ kind: 'error', text: 'コピーできませんでした。メールアドレスを選んでコピーしてください。' })
    }
  }

  const toggleField = (fieldId: string, checked: boolean) => {
    setSelectedFormFieldIds((current) => checked
      ? allFieldIds.filter((id) => id === fieldId || current.includes(id))
      : current.filter((id) => id !== fieldId))
  }

  const allSelected = allFieldIds.length > 0 && allFieldIds.every((id) => selectedFormFieldIds.includes(id))
  const canSave = Boolean(spreadsheetId && sheetName && busy === null)

  const save = async () => {
    if (!spreadsheetId || !sheetName || busy !== null) return
    setBusy('save')
    setFeedback(null)
    try {
      await onSave({ spreadsheetId, sheetName, syncDirection, selectedFormFieldIds })
      setFeedback({ kind: 'success', text: 'シート連携を保存しました。' })
    } catch (error) {
      setFeedback({
        kind: 'error',
        text: dailyError(error, 'シート連携を保存できませんでした。もう一度お試しください。'),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-testid="internal-sheets-setup-panel" className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <div>
        <h3 className="text-sm font-bold text-gray-900">自前シート連携</h3>
        <p className="mt-1 text-xs leading-relaxed text-gray-600">先にこのアドレスへ閲覧/編集共有してから貼り付け</p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-all text-xs font-medium text-gray-800">
            {serviceAccountEmail ?? 'サービスアカウントのメールアドレスを確認できません。'}
          </span>
          <button
            type="button"
            aria-label="サービスアカウントのメールアドレスをコピー"
            disabled={!serviceAccountEmail}
            onClick={() => { void copyServiceAccountEmail() }}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50"
          >
            コピー
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <label className="block text-xs text-gray-600">
          スプレッドシートの共有URL
          <input
            aria-label="スプレッドシートの共有URL"
            type="url"
            value={sharedUrl}
            disabled={busy === 'save'}
            onChange={(event) => {
              setSharedUrl(event.target.value)
              resetInspection()
              setFeedback(null)
            }}
            placeholder="https://docs.google.com/spreadsheets/d/.../edit"
            className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => { void inspect() }}
          disabled={busy !== null || !sharedUrl.trim()}
          className="min-h-10 rounded-lg border border-[#087A39] px-4 text-sm font-medium text-[#087A39] disabled:opacity-50"
        >
          {busy === 'inspect' ? '接続を確認中...' : '接続を確認'}
        </button>
      </div>

      {spreadsheetId && sheetNames.length > 0 && (
        <label className="block text-xs text-gray-600">
          対応するシート（タブ）
          <select
            aria-label="対応するシート（タブ）"
            value={sheetName}
            onChange={(event) => setSheetName(event.target.value)}
            className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      )}

      <label className="block text-xs text-gray-600">
        同期方向
        <select
          aria-label="同期方向"
          value={syncDirection}
          onChange={(event) => setSyncDirection(event.target.value as InternalSheetsSyncDirection)}
          className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
        >
          <option value="bidirectional">双方向（フォーム ↔ シート）</option>
          <option value="to_sheets">フォーム → シート</option>
          <option value="from_sheets">シート → フォーム</option>
        </select>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-gray-700">同期するフォーム項目</legend>
        <div className="flex justify-end">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              aria-label="同期する項目をすべて選択"
              checked={allSelected}
              disabled={allFieldIds.length === 0}
              onChange={(event) => setSelectedFormFieldIds(event.target.checked ? allFieldIds : [])}
            />
            すべて選択
          </label>
        </div>
        {syncableFields.length === 0 ? (
          <p className="text-xs text-gray-500">同期できる回答項目はありません。</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {syncableFields.map((field) => (
              <label key={field.id} className="flex items-center gap-2 rounded border border-gray-200 px-3 py-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={selectedFormFieldIds.includes(field.id)}
                  onChange={(event) => toggleField(field.id, event.target.checked)}
                />
                <span>{field.label}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {feedback && (
        <p
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={`rounded px-3 py-2 text-xs ${feedback.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}
        >
          {feedback.text}
        </p>
      )}

      <button
        type="button"
        onClick={() => { void save() }}
        disabled={!canSave}
        className="min-h-10 rounded-lg bg-[#087A39] px-4 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy === 'save' ? '保存中...' : 'シート連携を保存'}
      </button>
    </section>
  )
}
