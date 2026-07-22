'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  extractGoogleSpreadsheetId,
  getInternalSubmissionNotificationAnswerFields,
  type HarnessField,
} from '@line-crm/shared'
// Keep this browser asset out of the shared root barrel consumed by Worker bundles.
import { GOOGLE_SHEETS_FRIEND_LEDGER_APPS_SCRIPT_URL } from '../../../../../packages/shared/src/google-sheets-friend-ledger-apps-script'

export type InternalSheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional'

export interface InternalSheetsSetupConnection {
  id: string
  lineAccountId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: InternalSheetsSyncDirection
  friendLedgerEnabled: boolean
  formResultsEnabled: boolean
  formResultsSheetName: string | null
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
  friendLedgerEnabled: boolean
  formResultsEnabled: boolean
  formResultsSheetName: string | null
}

export interface InternalSheetsSetupPanelProps {
  serviceAccountEmail: string | null
  connection?: InternalSheetsSetupConnection | null
  fields: readonly HarnessField[]
  onInspect: (url: string) => Promise<InternalSheetsInspectResult>
  onSave: (input: InternalSheetsSaveInput) => Promise<void>
  loadAppsScript?: () => Promise<string>
  onRequestWebhookSecret?: (lineAccountId: string, connectionId: string) => Promise<string>
}

type Feedback = { kind: 'error' | 'success'; text: string }
type AsyncStatus = 'idle' | 'loading' | 'error'

type SetupPropertyName =
  | 'SHEETS_WEBHOOK_URL'
  | 'SHEETS_WEBHOOK_SECRET'
  | 'SHEETS_CONNECTION_ID'
  | 'SHEETS_SPREADSHEET_ID'
  | 'SHEETS_SHEET_NAME'

const PERMISSION_MESSAGE = 'スプレッドシートの共有設定に上のアドレスを追加してください'
const FRIEND_LEDGER_WEBHOOK_PATH = '/api/integrations/google-sheets/friend-ledger/webhook'
const MASKED_WEBHOOK_SECRET = '●●●●●●●●●●●●'
const SETUP_PROPERTY_NAMES: readonly SetupPropertyName[] = [
  'SHEETS_WEBHOOK_URL',
  'SHEETS_WEBHOOK_SECRET',
  'SHEETS_CONNECTION_ID',
  'SHEETS_SPREADSHEET_ID',
  'SHEETS_SHEET_NAME',
]
const SETUP_STEPS = [
  'Google スプレッドシートを開き、「拡張機能」→「Apps Script」を押します。',
  'Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に、下の5つの名前と値を追加します。',
  'Apps Script のコード欄を空にして、下の「Apps Script 全文をコピー」を押し、貼り付けて保存します。',
  '関数一覧で「installFriendLedgerSync」を選び、「実行」を1回押してアクセスを許可します。',
  'スプレッドシートへ戻り、友だち台帳のセルを1つ直して、すぐ反映されることを確認します。',
] as const

async function loadCanonicalAppsScript(): Promise<string> {
  const response = await fetch(GOOGLE_SHEETS_FRIEND_LEDGER_APPS_SCRIPT_URL)
  if (!response.ok) throw new Error('apps script unavailable')
  const source = await response.text()
  if (!source.includes('function installFriendLedgerSync()')) {
    throw new Error('apps script is incomplete')
  }
  return source
}

async function requestConnectionWebhookSecret(lineAccountId: string, connectionId: string): Promise<string> {
  const { sheetsConnectionsApi } = await import('../../lib/sheets-connections-api')
  return sheetsConnectionsApi.webhookSecret(lineAccountId, connectionId)
}

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
  loadAppsScript = loadCanonicalAppsScript,
  onRequestWebhookSecret = requestConnectionWebhookSecret,
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
  const [sheetNames, setSheetNames] = useState<string[]>(() => connection
    ? uniqueSheetNames([connection.sheetName, connection.formResultsSheetName ?? ''])
    : [])
  const [sheetName, setSheetName] = useState(connection?.sheetName ?? '')
  const [friendLedgerEnabled, setFriendLedgerEnabled] = useState(connection?.friendLedgerEnabled ?? false)
  const [formResultsEnabled, setFormResultsEnabled] = useState(connection?.formResultsEnabled ?? true)
  const [formResultsSheetName, setFormResultsSheetName] = useState(connection?.formResultsSheetName ?? '')
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
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupFeedback, setSetupFeedback] = useState<Feedback | null>(null)
  const [appsScript, setAppsScript] = useState<string | null>(null)
  const [appsScriptStatus, setAppsScriptStatus] = useState<AsyncStatus>('idle')
  const [webhookSecret, setWebhookSecret] = useState<{
    connectionId: string
    lineAccountId: string
    value: string
  } | null>(null)
  const [webhookSecretVisible, setWebhookSecretVisible] = useState(false)
  const [webhookSecretStatus, setWebhookSecretStatus] = useState<AsyncStatus>('idle')
  const inspectGeneration = useRef(0)
  const secretRequestGeneration = useRef(0)
  const setupTriggerRef = useRef<HTMLButtonElement>(null)
  const setupCloseRef = useRef<HTMLButtonElement>(null)
  const setupDialogRef = useRef<HTMLDivElement>(null)
  const secretToggleRef = useRef<HTMLButtonElement>(null)

  const hasSavedConnection = Boolean(connection?.id && connection.lineAccountId)
  const instantSyncReady = Boolean(hasSavedConnection && connection?.friendLedgerEnabled)
  const activeWebhookSecret = webhookSecret
    && webhookSecret.connectionId === connection?.id
    && webhookSecret.lineAccountId === connection?.lineAccountId
    ? webhookSecret.value
    : null
  const webhookBaseUrl = process.env.NEXT_PUBLIC_API_URL
    || (typeof window === 'undefined' ? null : window.location.origin)
  const webhookUrl = webhookBaseUrl
    ? new URL(FRIEND_LEDGER_WEBHOOK_PATH, webhookBaseUrl).href
    : ''

  useEffect(() => {
    secretRequestGeneration.current += 1
    setWebhookSecret(null)
    setWebhookSecretVisible(false)
    setWebhookSecretStatus('idle')
  }, [connection?.id, connection?.lineAccountId])

  useEffect(() => {
    if (setupOpen && activeWebhookSecret) secretToggleRef.current?.focus()
  }, [activeWebhookSecret, setupOpen])

  useEffect(() => {
    if (!setupOpen) return undefined
    setupCloseRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        secretRequestGeneration.current += 1
        setSetupOpen(false)
        setWebhookSecret(null)
        setWebhookSecretVisible(false)
        setWebhookSecretStatus('idle')
        setupTriggerRef.current?.focus()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = setupDialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [setupOpen])

  const loadAppsScriptForSetup = async () => {
    setAppsScriptStatus('loading')
    setSetupFeedback(null)
    try {
      const source = await loadAppsScript()
      if (!source.trim()) throw new Error('apps script is empty')
      setAppsScript(source)
      setAppsScriptStatus('idle')
    } catch {
      setAppsScriptStatus('error')
      setSetupFeedback({
        kind: 'error',
        text: 'Apps Scriptを読み込めませんでした。「もう一度読み込む」を押してください。',
      })
    }
  }

  const openInstantSetup = () => {
    setSetupOpen(true)
    setSetupFeedback(null)
    if (!appsScript && appsScriptStatus !== 'loading') {
      void loadAppsScriptForSetup()
    }
  }

  const closeInstantSetup = () => {
    secretRequestGeneration.current += 1
    setSetupOpen(false)
    setWebhookSecret(null)
    setWebhookSecretVisible(false)
    setWebhookSecretStatus('idle')
    setSetupFeedback(null)
    setupTriggerRef.current?.focus()
  }

  const requestWebhookSecret = async () => {
    if (
      !connection?.id
      || !connection.lineAccountId
      || !connection.friendLedgerEnabled
      || webhookSecretStatus === 'loading'
    ) return
    const connectionId = connection.id
    const lineAccountId = connection.lineAccountId
    const generation = ++secretRequestGeneration.current
    setWebhookSecretStatus('loading')
    setWebhookSecret(null)
    setWebhookSecretVisible(false)
    setSetupFeedback(null)
    try {
      const secret = await onRequestWebhookSecret(lineAccountId, connectionId)
      if (generation !== secretRequestGeneration.current) return
      if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('invalid webhook secret')
      setWebhookSecret({ connectionId, lineAccountId, value: secret })
      setWebhookSecretStatus('idle')
      setSetupFeedback({
        kind: 'success',
        text: '署名キーを取得しました。共有せず、Apps Scriptの設定だけに貼り付けてください。',
      })
    } catch {
      if (generation !== secretRequestGeneration.current) return
      setWebhookSecretStatus('error')
      setSetupFeedback({
        kind: 'error',
        text: '署名キーを取得できませんでした。接続を保存してから、もう一度お試しください。',
      })
    }
  }

  const copySetupValue = async (
    label: string,
    value: string | null,
    destination: 'name' | 'value' | 'script',
  ) => {
    if (!value) return
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(value)
      setSetupFeedback({
        kind: 'success',
        text: destination === 'script'
          ? 'Apps Scriptをコピーしました。手順3のコード欄へ、そのまま貼り付けてください。'
          : `${label}をコピーしました。スクリプト プロパティの${destination === 'name' ? '名前' : '値'}へ貼り付けてください。`,
      })
    } catch {
      setSetupFeedback({
        kind: 'error',
        text: 'コピーできませんでした。値を選んでコピーしてください。',
      })
    }
  }

  const resetInspection = () => {
    inspectGeneration.current += 1
    setBusy(null)
    setSpreadsheetId(null)
    setSheetNames([])
    setSheetName('')
    setFormResultsSheetName('')
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
      const savedLedgerSheet = connection?.sheetName ?? ''
      const savedResultsSheet = connection?.formResultsSheetName ?? ''
      const nextResultsSheet = nextSheetNames.includes(savedResultsSheet)
        ? savedResultsSheet
        : nextSheetNames[0]
      const nextLedgerSheet = nextSheetNames.includes(savedLedgerSheet)
        ? savedLedgerSheet
        : nextSheetNames.find((name) => name !== nextResultsSheet) ?? nextSheetNames[0]
      setSheetName(nextLedgerSheet)
      setFormResultsSheetName(nextResultsSheet)
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
  const usesSameSheet = Boolean(sheetName && formResultsSheetName && sheetName === formResultsSheetName)
  const canSave = Boolean(
    spreadsheetId
    && sheetName
    && (!formResultsEnabled || formResultsSheetName)
    && !usesSameSheet
    && busy === null,
  )

  const save = async () => {
    if (!spreadsheetId || !sheetName || busy !== null) return
    setBusy('save')
    setFeedback(null)
    try {
      await onSave({
        spreadsheetId,
        sheetName,
        syncDirection,
        selectedFormFieldIds,
        friendLedgerEnabled,
        formResultsEnabled,
        formResultsSheetName: formResultsSheetName || null,
      })
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

  const setupPropertyValue = (name: SetupPropertyName): string | null => {
    if (!instantSyncReady) return null
    switch (name) {
      case 'SHEETS_WEBHOOK_URL':
        return webhookUrl || null
      case 'SHEETS_WEBHOOK_SECRET':
        return activeWebhookSecret
      case 'SHEETS_CONNECTION_ID':
        return connection?.id ?? null
      case 'SHEETS_SPREADSHEET_ID':
        return connection?.spreadsheetId ?? null
      case 'SHEETS_SHEET_NAME':
        return connection?.sheetName ?? null
    }
  }

  const setupPropertyDisplay = (name: SetupPropertyName): string => {
    if (!hasSavedConnection) return '接続保存後に表示'
    if (!connection?.friendLedgerEnabled) return '友だち台帳の同期をオンにして保存後に表示'
    if (name === 'SHEETS_WEBHOOK_SECRET') {
      if (webhookSecretStatus === 'loading') return '取得中...'
      if (!activeWebhookSecret) return '「署名キーを取得」を押してください'
      return webhookSecretVisible ? activeWebhookSecret : MASKED_WEBHOOK_SECRET
    }
    return setupPropertyValue(name) ?? '接続保存後に表示'
  }

  return (
    <section data-testid="internal-sheets-setup-panel" className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-900">自前シート連携</h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-600">先にこのアドレスへ閲覧/編集共有してから貼り付け</p>
        </div>
        <button
          ref={setupTriggerRef}
          type="button"
          onClick={openInstantSetup}
          className="min-h-10 rounded-lg border border-[#087A39] bg-white px-4 text-sm font-medium text-[#087A39]"
        >
          即時反映の設定を見る
        </button>
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

      <div className="space-y-3 rounded-lg border border-gray-200 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
          <input
            type="checkbox"
            checked={formResultsEnabled}
            onChange={(event) => setFormResultsEnabled(event.target.checked)}
          />
          フォーム回答シート（別タブ）
        </label>
        <p className="text-xs leading-relaxed text-gray-600">
          1回の回答を1行に記録し、シート側の修正もLINEハーネスに戻します。
        </p>
        {spreadsheetId && sheetNames.length > 0 && (
          <label className="block text-xs text-gray-600">
            フォーム回答を記録するシート（タブ）
            <select
              aria-label="フォーム回答を記録するシート（タブ）"
              value={formResultsSheetName}
              onChange={(event) => setFormResultsSheetName(event.target.value)}
              className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              {!formResultsSheetName && <option value="">選択してください</option>}
              {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="space-y-3 rounded-lg border border-gray-200 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
          <input
            type="checkbox"
            checked={friendLedgerEnabled}
            onChange={(event) => setFriendLedgerEnabled(event.target.checked)}
          />
          友だち台帳も同期する
        </label>
        <p className="text-xs leading-relaxed text-gray-600">
          友だち一覧をシートで管理したい場合だけオンにします。
        </p>
        {spreadsheetId && sheetNames.length > 0 && (
          <label className="block text-xs text-gray-600">
            友だち台帳のシート（タブ）
            <select
              aria-label="友だち台帳のシート（タブ）"
              value={sheetName}
              onChange={(event) => setSheetName(event.target.value)}
              className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}
      </div>

      {usesSameSheet && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">
          友だち台帳とフォーム回答は別のタブを選んでください。
        </p>
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

      {setupOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3 sm:p-6">
          <div
            ref={setupDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="instant-sheets-setup-title"
            className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white shadow-2xl"
          >
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-gray-200 bg-white px-4 py-4 sm:px-6">
              <div>
                <h2 id="instant-sheets-setup-title" className="text-lg font-bold text-gray-900">
                  即時反映の設定
                </h2>
                <p className="mt-1 text-sm leading-relaxed text-gray-600">
                  全体の流れは「Apps Scriptを開く」→「5つの値を入れる」→「コードを貼る」→「1回実行」→「セルで確認」です。
                </p>
              </div>
              <button
                ref={setupCloseRef}
                type="button"
                onClick={closeInstantSetup}
                className="min-h-10 shrink-0 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700"
              >
                閉じる
              </button>
            </div>

            <div className="space-y-6 px-4 pb-24 pt-5 sm:px-6">
              <section aria-labelledby="instant-sheets-steps-title">
                <h3 id="instant-sheets-steps-title" className="text-base font-bold text-gray-900">
                  全体の流れ（5ステップ）
                </h3>
                <ol aria-label="設定手順" className="mt-3 space-y-3">
                  {SETUP_STEPS.map((step, index) => (
                    <li key={step} className="flex gap-3 rounded-lg bg-green-50 px-3 py-3 text-sm leading-relaxed text-gray-800">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#087A39] font-bold text-white">
                        {index + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <section aria-labelledby="instant-sheets-properties-title">
                <h3 id="instant-sheets-properties-title" className="text-base font-bold text-gray-900">
                  次に、この5つをスクリプト プロパティへ入れます
                </h3>
                <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium leading-relaxed text-amber-900">
                  署名キーは秘密・共有禁止です。Apps Script の設定以外へ貼らないでください。
                </p>
                {!hasSavedConnection && (
                  <p className="mt-2 text-sm leading-relaxed text-gray-700">
                    先にこの画面を閉じて「シート連携を保存」してください。保存後、この接続専用の値が表示されます。
                  </p>
                )}
                {hasSavedConnection && !connection?.friendLedgerEnabled && (
                  <p className="mt-2 text-sm leading-relaxed text-gray-700">
                    先にこの画面を閉じて「友だち台帳も同期する」をオンにし、「シート連携を保存」してください。
                  </p>
                )}
                <div className="mt-3 overflow-hidden rounded-lg border border-gray-200">
                  <table className="block w-full border-collapse text-left text-sm sm:table sm:table-fixed">
                    <colgroup className="hidden sm:table-column-group">
                      <col className="w-[42%] sm:w-[38%]" />
                      <col />
                      <col className="w-20 sm:w-28" />
                    </colgroup>
                    <thead className="sr-only bg-gray-50 text-xs text-gray-600 sm:not-sr-only sm:table-header-group">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">プロパティ名</th>
                        <th scope="col" className="px-3 py-2 font-medium">この接続の値</th>
                        <th scope="col" className="px-2 py-2 font-medium">コピー</th>
                      </tr>
                    </thead>
                    <tbody className="block divide-y divide-gray-200 sm:table-row-group">
                      {SETUP_PROPERTY_NAMES.map((name) => {
                        const value = setupPropertyValue(name)
                        const isSecret = name === 'SHEETS_WEBHOOK_SECRET'
                        return (
                          <tr key={name} className="block space-y-2 p-3 sm:table-row sm:space-y-0 sm:p-0">
                            <th scope="row" className="block break-all p-0 font-mono text-xs font-semibold text-gray-900 sm:table-cell sm:px-3 sm:py-3">
                              {name}
                            </th>
                            <td className="block p-0 sm:table-cell sm:px-3 sm:py-3">
                              <span className="break-all font-mono text-xs text-gray-800">
                                {setupPropertyDisplay(name)}
                              </span>
                              {isSecret && instantSyncReady && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {!activeWebhookSecret && (
                                    <button
                                      type="button"
                                      onClick={() => { void requestWebhookSecret() }}
                                      disabled={webhookSecretStatus === 'loading'}
                                      className="min-h-9 rounded border border-amber-500 bg-white px-3 text-xs font-medium text-amber-800 disabled:opacity-50"
                                    >
                                      {webhookSecretStatus === 'loading' ? '取得中...' : '署名キーを取得'}
                                    </button>
                                  )}
                                  {activeWebhookSecret && (
                                    <button
                                      ref={secretToggleRef}
                                      type="button"
                                      aria-label={webhookSecretVisible ? '署名キーを隠す' : '署名キーを表示'}
                                      onClick={() => setWebhookSecretVisible((visible) => !visible)}
                                      className="min-h-9 rounded border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700"
                                    >
                                      {webhookSecretVisible ? '隠す' : '表示'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="block p-0 sm:table-cell sm:px-2 sm:py-3">
                              <div className="flex flex-row gap-2 sm:flex-col">
                                <button
                                  type="button"
                                  aria-label={`${name} の名前をコピー`}
                                  onClick={() => { void copySetupValue(`${name} の名前`, name, 'name') }}
                                  className="min-h-9 flex-1 rounded border border-gray-300 bg-white px-2 text-xs font-medium text-gray-700 sm:flex-none"
                                >
                                  名前をコピー
                                </button>
                                <button
                                  type="button"
                                  aria-label={`${name} の値をコピー`}
                                  disabled={!value || (isSecret && webhookSecretStatus === 'loading')}
                                  onClick={() => { void copySetupValue(name, value, 'value') }}
                                  className="min-h-9 flex-1 rounded border border-gray-300 bg-white px-2 text-xs font-medium text-gray-700 disabled:opacity-40 sm:flex-none"
                                >
                                  値をコピー
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section aria-labelledby="instant-sheets-script-title">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 id="instant-sheets-script-title" className="text-base font-bold text-gray-900">
                      手順3：Apps Script をコピーして貼ります
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-gray-600">
                      下のコードを Apps Script に貼り付けます
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {appsScriptStatus === 'error' && (
                      <button
                        type="button"
                        onClick={() => { void loadAppsScriptForSetup() }}
                        className="min-h-10 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700"
                      >
                        もう一度読み込む
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Apps Script 全文をコピー"
                      disabled={!appsScript || appsScriptStatus === 'loading'}
                      onClick={() => { void copySetupValue('Apps Script', appsScript, 'script') }}
                      className="min-h-10 rounded-lg bg-[#087A39] px-4 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Apps Script 全文をコピー
                    </button>
                  </div>
                </div>
                {appsScriptStatus === 'loading' && (
                  <p role="status" className="mt-3 rounded-lg bg-gray-50 px-3 py-3 text-sm text-gray-600">
                    Apps Scriptを読み込んでいます...
                  </p>
                )}
                {appsScript && (
                  <pre
                    aria-label="Apps Script 全文"
                    className="mt-3 max-h-72 overflow-auto whitespace-pre rounded-lg bg-gray-950 p-4 text-xs leading-relaxed text-gray-100"
                  >
                    {appsScript}
                  </pre>
                )}
                <p className="mt-3 rounded-lg bg-blue-50 px-3 py-3 text-sm leading-relaxed text-blue-900">
                  貼り付けて保存したら、手順4で installFriendLedgerSync を1回実行します。最後に手順5でセルを1つ直し、すぐ反映されることを確認します。
                </p>
              </section>

              {setupFeedback && (
                <p
                  role={setupFeedback.kind === 'error' ? 'alert' : 'status'}
                  className={`pointer-events-none fixed bottom-4 left-1/2 z-[120] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 rounded-lg px-4 py-3 text-sm shadow-lg ${setupFeedback.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-800'}`}
                >
                  {setupFeedback.text}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
