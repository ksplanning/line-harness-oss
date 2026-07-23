'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ChatMessageHistory from '@/components/chats/chat-message-history'
import {
  api,
  type InquiryChatDetail,
  type InquiryPreferences,
} from '@/lib/api'

const STATUS_LABELS: Record<InquiryChatDetail['status'], string> = {
  unread: '未対応',
  in_progress: '対応中',
  resolved: '完了',
}

function errorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof Error
    && 'status' in error
    && (error as Error & { status?: number }).status === 409
  ) {
    return '別のスタッフが対応中か、送信先のLINE公式アカウントを利用できません。画面を開き直して確認してください。'
  }
  return fallback
}

export default function InquiryConsoleClient({ friendId }: { friendId: string }) {
  const [detail, setDetail] = useState<InquiryChatDetail | null>(null)
  const [preferences, setPreferences] = useState<InquiryPreferences | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [savingPreference, setSavingPreference] = useState(false)
  const [error, setError] = useState('')
  const [sentNotice, setSentNotice] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')

    void Promise.all([
      api.chats.openInquiry(friendId),
      api.chats.inquiryPreferences.get(),
    ])
      .then(([detailResponse, preferenceResponse]) => {
        if (!active) return
        if (!detailResponse.success) throw new Error(detailResponse.error)
        if (!preferenceResponse.success) throw new Error(preferenceResponse.error)
        setDetail(detailResponse.data)
        setPreferences(preferenceResponse.data)
      })
      .catch((loadError: unknown) => {
        if (!active) return
        setError(errorMessage(
          loadError,
          '問い合わせを開けませんでした。通信状態を確認して、もう一度お試しください。',
        ))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [friendId])

  useEffect(() => {
    if (!detail) return
    const history = scrollRef.current
    if (history) history.scrollTop = history.scrollHeight
  }, [detail])

  const handledByOther = useMemo(
    () => Boolean(
      detail
      && preferences
      && detail.status === 'in_progress'
      && detail.assignedStaffId
      && detail.assignedStaffId !== preferences.staffId,
    ),
    [detail, preferences],
  )
  const interactionDisabled = !detail
    || loading
    || handledByOther
    || detail.status === 'resolved'

  async function sendReply() {
    const content = message.trim()
    if (!detail || !content || interactionDisabled || sending) return
    setSending(true)
    setError('')
    setSentNotice('')
    try {
      const response = await api.chats.send(friendId, {
        content,
        messageType: 'text',
      })
      if (!response.success) throw new Error(response.error)
      setDetail((current) => current
        ? {
            ...current,
            status: 'in_progress',
            messages: [...current.messages, response.data.message],
          }
        : current)
      setMessage('')
      setSentNotice('送信済み')
    } catch (sendError) {
      setError(errorMessage(
        sendError,
        '返信を送信できませんでした。内容を残したまま再度お試しください。',
      ))
    } finally {
      setSending(false)
    }
  }

  async function completeInquiry() {
    if (!detail || interactionDisabled || completing) return
    setCompleting(true)
    setError('')
    try {
      const response = await api.chats.complete(friendId)
      if (!response.success) throw new Error(response.error)
      setDetail(response.data)
      setSentNotice('')
    } catch (completeError) {
      setError(errorMessage(
        completeError,
        '対応を完了にできませんでした。画面を開き直して状態を確認してください。',
      ))
    } finally {
      setCompleting(false)
    }
  }

  async function updateSignature(enabled: boolean) {
    if (!preferences?.canUpdate || savingPreference) return
    setSavingPreference(true)
    setError('')
    try {
      const response = await api.chats.inquiryPreferences.update(enabled)
      if (!response.success) throw new Error(response.error)
      setPreferences(response.data)
    } catch {
      setError('担当名の設定を変更できませんでした。もう一度お試しください。')
    } finally {
      setSavingPreference(false)
    }
  }

  return (
    <main
      data-testid="inquiry-console"
      className="mx-auto flex h-[100dvh] w-full max-w-3xl flex-col overflow-hidden bg-white text-gray-900"
    >
      {loading ? (
        <div className="flex flex-1 items-center justify-center px-6" aria-live="polite">
          <p className="text-sm text-gray-600">問い合わせを開いています…</p>
        </div>
      ) : !detail || !preferences ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-lg font-bold">問い合わせを開けませんでした</h1>
          <p role="alert" className="text-sm text-red-700">
            {error || '通知リンクが正しいか確認してください。'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-lg bg-gray-900 px-5 py-2 text-sm font-semibold text-white"
          >
            再読み込み
          </button>
        </div>
      ) : (
        <>
          <header className="border-b border-gray-200 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="flex items-start gap-3">
              {detail.friendPictureUrl ? (
                <img
                  src={detail.friendPictureUrl}
                  alt=""
                  className="h-11 w-11 flex-none rounded-full object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-gray-200 font-semibold text-gray-600"
                >
                  {detail.friendName.charAt(0)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="break-words text-base font-bold leading-tight">
                  {detail.friendName}
                </h1>
                <p className="mt-1 text-xs font-medium text-gray-700">
                  送信先: {detail.friendName}
                </p>
                <p className="mt-0.5 break-words text-xs text-gray-500">
                  LINE公式アカウント: {detail.lineAccountName || '既定アカウント'}
                </p>
              </div>
              <span className={`flex-none rounded-full px-2.5 py-1 text-xs font-semibold ${
                detail.status === 'resolved'
                  ? 'bg-green-100 text-green-800'
                  : detail.status === 'in_progress'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-red-100 text-red-800'
              }`}>
                {STATUS_LABELS[detail.status]}
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2">
              <div className="min-w-0 text-sm">
                {handledByOther ? (
                  <p className="font-semibold text-amber-800">
                    {detail.assignedStaffName || '別のスタッフ'}さんが対応中です
                  </p>
                ) : (
                  <p className="truncate font-medium text-gray-700">
                    担当: {detail.assignedStaffName || preferences.staffName}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void completeInquiry()}
                disabled={interactionDisabled || completing}
                className="min-h-11 flex-none rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {completing ? '完了中…' : '対応完了'}
              </button>
            </div>
          </header>

          {error && (
            <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <ChatMessageHistory
            messages={detail.messages}
            friendPictureUrl={detail.friendPictureUrl}
            scrollRef={scrollRef}
            expanded
          />

          <footer className="border-t border-gray-200 bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            <label className="mb-3 flex min-h-11 items-center gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                aria-label="返信の文頭に担当名を付ける"
                checked={preferences.replySignatureEnabled}
                disabled={!preferences.canUpdate || savingPreference}
                onChange={(event) => void updateSignature(event.target.checked)}
                className="h-5 w-5 accent-green-600"
              />
              <span className="flex-1">返信の文頭に「担当: {preferences.staffName}」を付ける</span>
              {savingPreference && <span className="text-xs text-gray-500">保存中…</span>}
            </label>

            <label htmlFor="inquiry-reply" className="sr-only">返信内容</label>
            <textarea
              id="inquiry-reply"
              aria-label="返信内容"
              rows={3}
              value={message}
              disabled={interactionDisabled || sending}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={
                handledByOther
                  ? '別のスタッフが対応中です'
                  : detail.status === 'resolved'
                    ? 'この問い合わせは完了しています'
                    : '返信を入力'
              }
              className="min-h-[76px] w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-base outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100 disabled:bg-gray-100"
            />
            <div className="mt-2 flex items-center gap-3">
              <p aria-live="polite" className="min-w-0 flex-1 text-sm font-medium text-green-700">
                {sentNotice}
              </p>
              <button
                type="button"
                onClick={() => void sendReply()}
                disabled={interactionDisabled || sending || !message.trim()}
                className="min-h-11 min-w-24 rounded-lg bg-[#06C755] px-5 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {sending ? '送信中…' : '送信'}
              </button>
            </div>
          </footer>
        </>
      )}
    </main>
  )
}
