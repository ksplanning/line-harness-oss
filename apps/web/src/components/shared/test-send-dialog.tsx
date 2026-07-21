'use client'

import { useMemo, useRef, useState } from 'react'
import { api, type TestSendMessage, type TestSendSource } from '@/lib/api'

interface TestRecipient {
  id: string
  displayName: string
  pictureUrl: string | null
}

interface RecipientGroup {
  accountId: string
  recipients: TestRecipient[]
}

export interface TestSendDialogProps {
  accountIds: string[]
  source: TestSendSource
  messages: TestSendMessage[]
  buttonLabel?: string
  title?: string
  disabled?: boolean
  className?: string
  /** Account-scoped id only; the worker resolves name/icon and rejects cross-account ids. */
  senderPresetId?: string | null
}

type ResultState = { kind: 'success' | 'error'; message: string } | null

function operationKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function errorMessage(error: unknown, fallback: string): string {
  const apiBody = (error as { body?: unknown } | null)?.body
  if (apiBody && typeof apiBody === 'object' && 'error' in apiBody) {
    const message = (apiBody as { error?: unknown }).error
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (error instanceof Error && error.message && !error.message.startsWith('API error:')) {
    return error.message
  }
  return fallback
}

export default function TestSendDialog({
  accountIds,
  source,
  messages,
  buttonLabel = 'テスト送信',
  title = 'テスト送信',
  disabled = false,
  className = '',
  senderPresetId,
}: TestSendDialogProps) {
  const uniqueAccountIds = useMemo(
    () => [...new Set(accountIds.filter((id) => id.length > 0))],
    [accountIds],
  )
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<RecipientGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<ResultState>(null)
  const sendingRef = useRef(false)
  const requestKeysRef = useRef<Record<string, string>>({})

  const validMessageCount = messages.length >= 1 && messages.length <= 5
  const missingAccounts = groups.filter((group) => group.recipients.length === 0)
  const recipientCount = groups.reduce((total, group) => total + group.recipients.length, 0)

  const loadRecipients = async () => {
    setLoading(true)
    setLoadError('')
    setGroups([])
    setResult(null)
    try {
      const loaded = await Promise.all(uniqueAccountIds.map(async (accountId) => {
        const response = await api.testSends.getRecipients(source, accountId)
        if (!response.success) throw new Error(response.error || 'テスト送信先を読み込めませんでした')
        return { accountId, recipients: response.data }
      }))
      setGroups(loaded)
    } catch {
      setLoadError('テスト送信先を読み込めませんでした')
    } finally {
      setLoading(false)
    }
  }

  const handleOpen = () => {
    setOpen(true)
    requestKeysRef.current = {}
    void loadRecipients()
  }

  const handleClose = () => {
    if (sendingRef.current) return
    setOpen(false)
  }

  const handleSend = async () => {
    if (
      sendingRef.current
      || loading
      || loadError
      || missingAccounts.length > 0
      || uniqueAccountIds.length === 0
      || !validMessageCount
    ) return

    sendingRef.current = true
    setSending(true)
    setResult(null)
    try {
      const normalizedMessages = messages.map((message) => ({
        type: message.type,
        content: message.content,
        ...(typeof message.altText === 'string' ? { altText: message.altText } : {}),
      }))
      const outcomes = await Promise.allSettled(uniqueAccountIds.map(async (accountId) => {
        const idempotencyKey = requestKeysRef.current[accountId] ?? operationKey()
        requestKeysRef.current[accountId] = idempotencyKey
        const response = await api.testSends.send({
          accountId,
          source,
          messages: normalizedMessages,
          idempotencyKey,
          ...(senderPresetId ? { senderPresetId } : {}),
        })
        if (!response.success) throw new Error(response.error || 'テスト送信に失敗しました')
        return response
      }))
      const sentUserIds: string[] = []
      let failed = 0
      let firstError: unknown = null
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
          const responseSentUserIds = outcome.value.sentUserIds
          const responseSent = outcome.value.sent ?? responseSentUserIds?.length ?? 0
          if (
            !Array.isArray(responseSentUserIds)
            || responseSentUserIds.some((userId) => typeof userId !== 'string')
            || responseSentUserIds.length !== responseSent
          ) {
            firstError ??= new Error('送信結果に送信先userIdが含まれていません')
            failed += Math.max(outcome.value.failed ?? 0, outcome.value.sent ?? 0, 1)
            return
          }
          sentUserIds.push(...responseSentUserIds)
          failed += outcome.value.failed ?? 0
          return
        }
        firstError ??= outcome.reason
        failed += groups.find((group) => group.accountId === uniqueAccountIds[index])?.recipients.length ?? 1
      })
      if (failed > 0) {
        setResult({
          kind: 'error',
          message: sentUserIds.length > 0
            ? `一部失敗しました。送信済みuserId: ${sentUserIds.join(', ')}（失敗${failed}件）`
            : errorMessage(firstError, `${failed}件のテスト送信に失敗しました`),
        })
      } else if (sentUserIds.length === 0) {
        setResult({ kind: 'error', message: '送信結果に送信先userIdが含まれていません' })
      } else {
        setResult({
          kind: 'success',
          message: `テスト送信しました。送信先userId: ${sentUserIds.join(', ')}`,
        })
      }
    } catch (error) {
      setResult({ kind: 'error', message: errorMessage(error, 'テスト送信に失敗しました') })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const cannotSend = loading
    || Boolean(loadError)
    || missingAccounts.length > 0
    || uniqueAccountIds.length === 0
    || !validMessageCount
    || sending

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled || uniqueAccountIds.length === 0 || !validMessageCount}
        className={`px-3 py-2 min-h-[40px] text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      >
        {buttonLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
          onClick={handleClose}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="test-send-dialog-title"
            className="bg-white rounded-lg w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="test-send-dialog-title" className="text-lg font-medium">{title}</h2>
            <p className="text-sm text-gray-600">
              設定済みのテスト送信先だけに、現在の内容を実際に送ります。
            </p>

            {loading ? (
              <div className="py-5 text-center text-sm text-gray-400">送信先を確認中...</div>
            ) : loadError ? (
              <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                <p>{loadError}</p>
                <button
                  type="button"
                  onClick={() => void loadRecipients()}
                  className="mt-2 text-sm font-medium underline"
                >
                  再読み込み
                </button>
              </div>
            ) : (
              <>
                {missingAccounts.length > 0 ? (
                  <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800">
                    <p>テスト送信先を先に設定してください。</p>
                    <a href="/accounts" className="inline-block mt-2 font-medium underline">
                      テスト送信先を設定する
                    </a>
                  </div>
                ) : (
                  <div className="rounded-lg border border-gray-200 p-3">
                    <p className="text-xs font-medium text-gray-500 mb-2">
                      送信先（{recipientCount}件）
                    </p>
                    <ul className="space-y-1.5">
                      {groups.flatMap((group) => group.recipients.map((recipient) => (
                        <li key={`${group.accountId}:${recipient.id}`} className="flex items-center gap-2 text-sm text-gray-700">
                          {recipient.pictureUrl ? (
                            <img src={recipient.pictureUrl} alt="" className="w-6 h-6 rounded-full" />
                          ) : (
                            <span className="w-6 h-6 rounded-full bg-gray-200" aria-hidden="true" />
                          )}
                          {recipient.displayName || '名前未設定'}
                        </li>
                      )))}
                    </ul>
                  </div>
                )}

                {!validMessageCount && (
                  <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                    テスト送信できるメッセージは1〜5件です。
                  </div>
                )}
              </>
            )}

            {result && (
              <div
                role="status"
                className={`p-3 rounded-lg border text-sm ${result.kind === 'success'
                  ? 'border-green-200 bg-green-50 text-green-700'
                  : 'border-red-200 bg-red-50 text-red-700'}`}
              >
                {result.message}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={cannotSend}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: '#06C755' }}
              >
                {sending ? '送信中...' : 'テスト送信する'}
              </button>
              <button
                type="button"
                onClick={handleClose}
                disabled={sending}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
