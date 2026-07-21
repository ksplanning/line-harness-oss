'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared'
import { api, fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import FlexPreviewComponent from '@/components/flex-preview'
import FriendInfoSidebar from '@/components/chats/friend-info-sidebar'
import ImageUploader, { type ImageUploaderValue } from '@/components/shared/image-uploader'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'
import CannedResponsePicker from '@/components/chats/canned-response-picker'
import { applyCannedSelection } from '@/lib/canned-responses/insert-canned-text'
import {
  notifyFaqDraftReviewChanged,
  subscribeFaqDraftReviewChanges,
} from '@/lib/faq-draft-review-sync'

interface Chat {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  notes: string | null
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface InlineAiFaqDraft {
  id: string
  question: string
  draftAnswer: string
  createdAt: string
  updatedAt: string
  questionMessageId: string | null
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
  pendingDrafts?: InlineAiFaqDraft[]
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'resolved'

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
]

const SHOW_LOADING_PREF_KEY = 'lh_chat_show_loading_indicator'
const LOADING_SECONDS_PREF_KEY = 'lh_chat_loading_seconds'
const LOADING_REFRESH_INTERVAL_MS = 4000

function StickerMessageImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  if (!sticker || failed) return <span>{fallback}</span>

  return (
    <img
      src={sticker.stickerUrl}
      alt={fallback}
      className="max-h-[140px] max-w-[140px] object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sameYmd(aIso: string, bIso: string): boolean {
  const a = new Date(aIso)
  const b = new Date(bIso)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatYmdSlash(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function InlineAiDraftCard({
  draft,
  onUpdate,
  onApprove,
  onDiscard,
}: {
  draft: InlineAiFaqDraft
  onUpdate: (draftId: string, draftAnswer: string) => Promise<void>
  onApprove: (draftId: string) => Promise<void>
  onDiscard: (draftId: string) => Promise<void>
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draftAnswer, setDraftAnswer] = useState(draft.draftAnswer)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [busyAction, setBusyAction] = useState<'edit' | 'approve' | 'discard' | null>(null)
  const [actionError, setActionError] = useState('')
  const [reviewBlocked, setReviewBlocked] = useState(false)
  const actionLockRef = useRef(false)
  const controlsDisabled = busyAction !== null || reviewBlocked

  useEffect(() => {
    if (!isEditing) setDraftAnswer(draft.draftAnswer)
  }, [draft.draftAnswer, isEditing])

  const runAction = async (
    action: 'edit' | 'approve' | 'discard',
    callback: () => Promise<void>,
  ) => {
    if (actionLockRef.current) return
    actionLockRef.current = true
    setBusyAction(action)
    setActionError('')
    try {
      await callback()
    } catch {
      if (action === 'approve') setReviewBlocked(true)
      setActionError(action === 'approve'
        ? '送信結果を確認できません。再送せず管理者へ確認してください。'
        : '操作に失敗しました。もう一度お試しください。')
    } finally {
      actionLockRef.current = false
      setBusyAction(null)
    }
  }

  return (
    <div
      data-testid="inline-ai-draft"
      className="ml-10 mt-2 rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 p-3 text-gray-900 shadow-sm"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">
          AI下書き
        </span>
        <span className="text-[11px] text-amber-800">確認後に送信されます</span>
      </div>

      {isEditing ? (
        <textarea
          aria-label="AI下書き本文"
          rows={4}
          value={draftAnswer}
          onChange={(event) => setDraftAnswer(event.target.value)}
          className="min-h-[96px] w-full resize-y rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{draft.draftAnswer}</p>
      )}

      {actionError && (
        <p role="alert" className="mt-2 text-xs text-red-700">{actionError}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isEditing ? (
          <>
            <button
              type="button"
              disabled={controlsDisabled || !draftAnswer.trim()}
              onClick={() => void runAction('edit', async () => {
                await onUpdate(draft.id, draftAnswer.trim())
                setIsEditing(false)
              })}
              className="min-h-[40px] rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyAction === 'edit' ? '保存中...' : '編集を保存'}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => {
                setDraftAnswer(draft.draftAnswer)
                setIsEditing(false)
              }}
              className="min-h-[40px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              キャンセル
            </button>
          </>
        ) : confirmingDiscard ? (
          <>
            <span className="text-xs font-medium text-red-700">この下書きを破棄しますか？</span>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void runAction('discard', () => onDiscard(draft.id))}
              className="min-h-[40px] rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busyAction === 'discard' ? '破棄中...' : '破棄する'}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setConfirmingDiscard(false)}
              className="min-h-[40px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              キャンセル
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setIsEditing(true)}
              className="min-h-[40px] rounded-md border border-amber-500 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              下書きを編集
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => void runAction('approve', () => onApprove(draft.id))}
              className="min-h-[40px] rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busyAction === 'approve' ? '送信中...' : '承認して送信'}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setConfirmingDiscard(true)}
              className="min-h-[40px] rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              下書きを破棄
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ChatMessageHistory({
  messages,
  friendPictureUrl,
  scrollRef,
  pendingDrafts = [],
  onUpdateDraft,
  onApproveDraft,
  onDiscardDraft,
  expanded = false,
}: {
  messages: ChatMessage[]
  friendPictureUrl: string | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  pendingDrafts?: InlineAiFaqDraft[]
  onUpdateDraft?: (draftId: string, draftAnswer: string) => Promise<void>
  onApproveDraft?: (draftId: string) => Promise<void>
  onDiscardDraft?: (draftId: string) => Promise<void>
  expanded?: boolean
}) {
  return (
    <div
      ref={scrollRef}
      data-testid="chat-message-history"
      className="min-h-0 flex-1 overflow-y-auto p-4 space-y-2"
      style={{ backgroundColor: '#7494C0' }}
    >
      {messages.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-white/60 text-sm">メッセージはまだありません。</p>
        </div>
      ) : (
        messages.map((msg, idx) => {
          const prevMsg = idx > 0 ? messages[idx - 1] : null
          const showDateSep = !prevMsg || !sameYmd(prevMsg.createdAt, msg.createdAt)
          const isOutgoing = msg.direction === 'outgoing'
          const draftsAfterMessage = pendingDrafts.filter((draft) => draft.questionMessageId === msg.id)

          let bubbleContent: React.ReactNode
          if (msg.messageType === 'flex') {
            bubbleContent = (
              <div
                data-testid="chat-flex-message"
                className={expanded ? 'min-w-0 max-w-full' : 'max-w-[300px]'}
              >
                <FlexPreviewComponent content={msg.content} maxWidth={280} />
              </div>
            )
          } else if (msg.messageType === 'image') {
            try {
              const parsed = JSON.parse(msg.content)
              bubbleContent = (
                <img
                  src={parsed.originalContentUrl || parsed.previewImageUrl}
                  alt=""
                  className={`${expanded ? 'max-w-full sm:max-w-lg' : 'max-w-[200px]'} h-auto rounded`}
                />
              )
            } catch {
              bubbleContent = <span>🖼️ [画像]</span>
            }
          } else if (msg.messageType === 'sticker') {
            bubbleContent = <StickerMessageImage content={msg.content} />
          } else {
            bubbleContent = <span>{msg.content}</span>
          }

          return (
            <div key={msg.id}>
              {showDateSep && (
                <div className="flex justify-center my-3">
                  <span className="text-[11px] text-white/85 bg-black/20 px-2.5 py-0.5 rounded-full">
                    {formatYmdSlash(msg.createdAt)}
                  </span>
                </div>
              )}
              <div className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}>
                {!isOutgoing && (
                  friendPictureUrl ? (
                    <img src={friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
                  )
                )}

                <div className={`min-w-0 max-w-full flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                  <div
                    data-testid="chat-message-bubble"
                    className={`${expanded ? 'w-fit max-w-full sm:max-w-3xl' : 'max-w-[320px]'} px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                      isOutgoing
                        ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                        : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
                    }`}
                    style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                  >
                    {bubbleContent}
                  </div>
                  <span className="text-xs text-white/50 mt-0.5 px-1">
                    {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
              {onUpdateDraft && onApproveDraft && onDiscardDraft && draftsAfterMessage.map((draft) => (
                <InlineAiDraftCard
                  key={`${draft.id}:${draft.draftAnswer}`}
                  draft={draft}
                  onUpdate={onUpdateDraft}
                  onApprove={onApproveDraft}
                  onDiscard={onDiscardDraft}
                />
              ))}
            </div>
          )
        })
      )}
    </div>
  )
}

const ccPrompts = [
  {
    title: 'チャット対応テンプレート',
    prompt: `チャット対応で使えるテンプレートメッセージを作成してください。
1. よくある質問への回答テンプレート（挨拶、FAQ、サポート）
2. クレーム対応用の丁寧な返信テンプレート
3. フォローアップメッセージのテンプレート
手順を示してください。`,
  },
  {
    title: '未対応チャット確認',
    prompt: `未対応のチャットを確認し、対応優先度を整理してください。
1. 未読・対応中のチャット数を集計
2. 最終メッセージからの経過時間で優先度を判定
3. 長時間未対応のチャットへの対応アクションを提案
結果をレポートしてください。`,
  },
]

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const isComposingRef = useRef(false)
  const sendLockRef = useRef(false)

  useEffect(() => {
    const loadMessages = async () => {
      setLoadingMessages(true)
      try {
        const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
          `/api/friends/${friendId}/messages`
        )
        if (res.success) setMessages(res.data)
      } catch { /* silent */ }
      setLoadingMessages(false)
    }
    loadMessages()
  }, [friendId])

  const handleSend = async () => {
    if (!message.trim() || sending || sendLockRef.current) return
    sendLockRef.current = true
    setSending(true)
    try {
      await fetchApi(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: message, messageType: 'text' }),
      })
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        direction: 'outgoing',
        messageType: 'text',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      setMessage('')
    } catch { /* silent */ }
    setSending(false)
    sendLockRef.current = false
  }

  function renderContent(msg: MessageLog) {
    if (msg.messageType === 'text') return msg.content
    if (msg.messageType === 'flex') {
      try {
        const parsed = JSON.parse(msg.content)
        // Extract ALL text from flex (up to 200 chars)
        const texts: string[] = []
        const collectText = (obj: Record<string, unknown>) => {
          if (texts.join(' ').length > 200) return
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const t = (obj.text as string).trim()
            if (t && !t.startsWith('{{')) texts.push(t)
          }
          for (const key of ['header', 'body', 'footer']) {
            if (obj[key]) collectText(obj[key] as Record<string, unknown>)
          }
          if (Array.isArray(obj.contents)) {
            for (const c of obj.contents) collectText(c as Record<string, unknown>)
          }
        }
        collectText(parsed)
        return texts.slice(0, 4).join('\n') || '[Flex Message]'
      } catch { return '[Flex Message]' }
    }
    if (msg.messageType === 'sticker') {
      return <StickerMessageImage content={msg.content} />
    }
    return `[${msg.messageType}]`
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                msg.direction === 'outgoing'
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}>
                <div className="text-sm whitespace-pre-wrap break-words">{renderContent(msg)}</div>
                <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200">
        <div className="flex items-end gap-2">
          <PersonalizedTextEditor
            mode="emoji-only"
            multiline={false}
            value={message}
            onChange={setMessage}
            pickerPlacement="above"
            inputProps={{
              onCompositionStart: () => { isComposingRef.current = true },
              onCompositionEnd: () => { isComposingRef.current = false },
              onKeyDown: (e) => {
                // IME変換確定のEnterでは送信しない
                if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              },
            }}
            placeholder="メッセージを入力..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            containerClassName="flex-1 space-y-2"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends, setAllFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const statusFilterRef = useRef<StatusFilter>('all')
  const unansweredOnlyRef = useRef(false)
  const [unansweredOnly, setUnansweredOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('unanswered') === '1'
  })

  // unansweredOnly 変更時に URL を書き戻す
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    if (unansweredOnly) urlParams.set('unanswered', '1')
    else urlParams.delete('unanswered')
    const qs = urlParams.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', url)
  }, [unansweredOnly])
  // Send mode: 'enter' = Enter sends, Shift+Enter = newline; 'shift-enter' = reverse
  const [sendMode, setSendMode] = useState<'enter' | 'shift-enter'>('enter')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [pendingImage, setPendingImage] = useState<ImageUploaderValue | null>(null)
  const [showImageUploader, setShowImageUploader] = useState(false)
  const [sending, setSending] = useState(false)
  const sendLockRef = useRef(false)
  const detailRequestSequenceRef = useRef(0)
  const draftReviewSyncSourceIdRef = useRef(`chats-${Math.random().toString(36).slice(2)}`)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(5)
  const lastLoadingTriggerAtRef = useRef<Record<string, number>>({})
  const [isMessageInputFocused, setIsMessageInputFocused] = useState(false)
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false)
  const isComposingRef = useRef(false)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const expandedMessagesScrollRef = useRef<HTMLDivElement | null>(null)
  const expandedHistoryDialogRef = useRef<HTMLElement | null>(null)
  const expandHistoryButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeExpandedHistoryButtonRef = useRef<HTMLButtonElement | null>(null)
  const expandedHistoryUserScrolledRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const closeExpandedHistory = useCallback(() => {
    setIsHistoryExpanded(false)
    window.setTimeout(() => expandHistoryButtonRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    try {
      const rawEnabled = localStorage.getItem(SHOW_LOADING_PREF_KEY)
      const rawSeconds = localStorage.getItem(LOADING_SECONDS_PREF_KEY)
      if (rawEnabled !== null) setShowLoadingIndicator(rawEnabled === '1')
      if (rawSeconds) {
        const n = Number.parseInt(rawSeconds, 10)
        if (Number.isFinite(n) && n >= 5 && n <= 60) setLoadingSeconds(n)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_LOADING_PREF_KEY, showLoadingIndicator ? '1' : '0')
      localStorage.setItem(LOADING_SECONDS_PREF_KEY, String(loadingSeconds))
    } catch {
      // localStorage unavailable
    }
  }, [showLoadingIndicator, loadingSeconds])

  const loadChats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: { status?: string; accountId?: string; unansweredOnly?: boolean } = {}
      if (statusFilter !== 'all' && !unansweredOnly) params.status = statusFilter
      if (selectedAccountId) params.accountId = selectedAccountId
      if (unansweredOnly) params.unansweredOnly = true
      const chatRes = await api.chats.list(params)
      if (chatRes.success) {
        setChats(chatRes.data as unknown as Chat[])
      }
    } catch {
      setError('チャットの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, selectedAccountId, unansweredOnly])

  // Friends list (for the "new direct message" modal) — loaded lazily in the background
  // Previously fetched 800 friends in parallel with chats, which blocked the initial render.
  const loadAllFriends = useCallback(async () => {
    try {
      const friendRes = await api.friends.list({ accountId: selectedAccountId || undefined, limit: '800' })
      if (friendRes.success) {
        setAllFriends((friendRes.data as unknown as { items: FriendItem[] }).items)
      }
    } catch { /* silent */ }
  }, [selectedAccountId])

  useEffect(() => { void loadAllFriends() }, [loadAllFriends])

  // Keep refs in sync so setChats updater can read the latest filter without stale closure
  useEffect(() => { statusFilterRef.current = statusFilter }, [statusFilter])
  useEffect(() => { unansweredOnlyRef.current = unansweredOnly }, [unansweredOnly])

  // Load/save sendMode preference (guarded — privacy-restricted browsers throw)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('chat.sendMode')
      if (saved === 'enter' || saved === 'shift-enter') setSendMode(saved)
    } catch { /* localStorage unavailable */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem('chat.sendMode', sendMode) } catch { /* ignore */ }
  }, [sendMode])

  const loadChatDetail = useCallback(async (chatId: string) => {
    const requestSequence = ++detailRequestSequenceRef.current
    setDetailLoading(true)
    setError('')
    try {
      const res = await api.chats.get(chatId)
      if (requestSequence !== detailRequestSequenceRef.current) return
      if (res.success) {
        setChatDetail(res.data as unknown as ChatDetail)
        setNotes((res.data as unknown as ChatDetail).notes || '')
      } else {
        // API は 200 で success:false を返す可能性 (例: 404 lookup)。詳細を画面に出す。
        const errMsg = (res as { error?: string }).error ?? '不明なエラー'
        setError(`チャット詳細の読み込みに失敗しました: ${errMsg}`)
      }
    } catch (err) {
      if (requestSequence !== detailRequestSequenceRef.current) return
      // ネットワーク / parse / auth fail などの例外。empty catch だと原因不明だったので詳細を出す。
      const msg = err instanceof Error ? err.message : String(err)
      setError(`チャット詳細の読み込みに失敗しました: ${msg}`)
    } finally {
      if (requestSequence === detailRequestSequenceRef.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // Deep-link from other pages (e.g. /form-submissions): ?friend=<friendId>
  // chat list returns id = friend_id, so selectedChatId === friendId is correct.
  // If no chat exists yet, loadChatDetail will fail and the user can fall back to
  // the friend list — acceptable for now.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const friendId = params.get('friend')
    if (friendId) setSelectedChatId(friendId)
  }, [])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      detailRequestSequenceRef.current += 1
      setDetailLoading(false)
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  useEffect(() => {
    if (!selectedChatId || !selectedAccountId) return
    const reload = () => { void loadChatDetail(selectedChatId) }
    const unsubscribe = subscribeFaqDraftReviewChanges((event) => {
      if (
        event.accountId === selectedAccountId
        && event.sourceId !== draftReviewSyncSourceIdRef.current
      ) reload()
    })
    window.addEventListener('focus', reload)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', reload)
    }
  }, [loadChatDetail, selectedAccountId, selectedChatId])

  // Surface deep-linked chats in the sidebar even when the current account
  // filter or status filter would exclude them — otherwise the user replies
  // and the conversation stays invisible until they refresh.
  // Re-runs when `chats` changes (e.g. after loadChats refetches on filter
  // change) so the synthetic entry is re-injected if the next API result
  // does not include it. Returning `prev` unchanged when already present
  // avoids any update loop.
  useEffect(() => {
    if (!chatDetail) return
    setChats((prev) => {
      if (prev.some((c) => c.id === chatDetail.id)) return prev
      // /api/chats/:id may not populate the lastMessage* fields; derive
      // from the messages array as a fallback so the sidebar preview is
      // not stuck on "(まだメッセージなし)".
      const lastMsg = chatDetail.messages?.[chatDetail.messages.length - 1]
      const entry: Chat = {
        id: chatDetail.id,
        friendId: chatDetail.friendId,
        friendName: chatDetail.friendName,
        friendPictureUrl: chatDetail.friendPictureUrl,
        operatorId: chatDetail.operatorId ?? null,
        status: chatDetail.status,
        notes: chatDetail.notes ?? null,
        lastMessageAt: chatDetail.lastMessageAt ?? lastMsg?.createdAt ?? null,
        lastMessageContent: chatDetail.lastMessageContent ?? lastMsg?.content ?? null,
        lastMessageDirection: chatDetail.lastMessageDirection ?? lastMsg?.direction ?? null,
        lastMessageType: chatDetail.lastMessageType ?? lastMsg?.messageType ?? null,
        createdAt: chatDetail.createdAt,
        updatedAt: chatDetail.updatedAt,
      }
      return [entry, ...prev]
    })
  }, [chatDetail, chats])

  // 詳細が新しくロードされたら最下部（＝最新メッセージ）までスクロールする。
  // そこから上にスクロールすれば過去のメッセージを辿れる（LINE受信画面と同じUX）。
  // ユーザーが手動でスクロールしたら delayed auto-scroll は発動させない。
  useEffect(() => {
    if (!chatDetail?.messages || chatDetail.messages.length === 0) return
    const el = messagesScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    let userScrolled = false
    const onScroll = () => {
      if (!messagesScrollRef.current) return
      const current = messagesScrollRef.current
      // 下端から一定以上離れたらユーザー操作とみなす
      if (current.scrollHeight - current.scrollTop - current.clientHeight > 20) {
        userScrolled = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 画像/Flex の表示後に高さが増える場合に追従するフォロワー（ユーザーがスクロール済みなら発動させない）
    const id = window.setTimeout(() => {
      if (userScrolled || !messagesScrollRef.current) return
      messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight
    }, 150)
    return () => {
      window.clearTimeout(id)
      el.removeEventListener('scroll', onScroll)
    }
  }, [chatDetail?.id, chatDetail?.messages?.length])

  useEffect(() => {
    if (!isHistoryExpanded) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeExpandedHistoryButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeExpandedHistory()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = expandedHistoryDialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active) || (!event.shiftKey && active === last) || (event.shiftKey && active === first)) {
        event.preventDefault()
        const nextTarget = event.shiftKey ? last : first
        nextTarget.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeExpandedHistory, isHistoryExpanded])

  // 拡大表示は広さで折り返し量が変わるため、開くたびに独立して最新位置へ合わせる。
  useEffect(() => {
    if (!isHistoryExpanded || !chatDetail?.messages?.length) return
    const el = expandedMessagesScrollRef.current
    if (!el) return
    expandedHistoryUserScrolledRef.current = false
    const keepAtLatest = () => {
      if (!expandedHistoryUserScrolledRef.current) el.scrollTop = el.scrollHeight
    }
    keepAtLatest()
    const onScroll = () => {
      expandedHistoryUserScrolledRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 20
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(keepAtLatest)
    Array.from(el.children).forEach((child) => resizeObserver?.observe(child))
    const id = window.setTimeout(keepAtLatest, 150)
    return () => {
      window.clearTimeout(id)
      el.removeEventListener('scroll', onScroll)
      resizeObserver?.disconnect()
    }
  }, [chatDetail?.id, chatDetail?.messages?.length, isHistoryExpanded])

  // Auto-resize textarea as messageContent grows
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [messageContent])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
    setPendingImage(null)
    setShowImageUploader(false)
  }

  const triggerLoadingAnimation = useCallback(async (chatId: string) => {
    if (!showLoadingIndicator) return

    const now = Date.now()
    const last = lastLoadingTriggerAtRef.current[chatId] ?? 0
    if (now - last < LOADING_REFRESH_INTERVAL_MS) return
    lastLoadingTriggerAtRef.current[chatId] = now

    try {
      await fetchApi<{ success: boolean }>(`/api/chats/${chatId}/loading`, {
        method: 'POST',
        body: JSON.stringify({ loadingSeconds }),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown'
      setError(`ローディング表示の開始に失敗しました: ${detail}`)
    }
  }, [showLoadingIndicator, loadingSeconds])

  const handleSendMessage = async () => {
    if (!selectedChatId || sending || sendLockRef.current) return
    if (!messageContent.trim() && !pendingImage) return
    const sendingChatId = selectedChatId  // capture the chat id for this send
    sendLockRef.current = true
    setSending(true)
    try {
      const now = new Date().toISOString()
      // --- Image send path (runs first when image is present) ---
      if (pendingImage && pendingImage.mode === 'line-image') {
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        await api.chats.send(sendingChatId, { messageType: 'image', content: imgPayload })
        setPendingImage(null)
        setShowImageUploader(false)
        // Optimistic update for image
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'image',
              content: imgPayload,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: '[画像]',
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'image' as const,
          } : c)
          let filtered = currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter)
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // --- Text send path (runs independently — both paths execute when both image and text are present) ---
      if (messageContent.trim()) {
        const content = messageContent.trim()
        await api.chats.send(sendingChatId, { content })
        setMessageContent('')
        // Optimistic update: append message locally instead of refetching (prevents scroll jump / full reload feel)
        // Only mutate chatDetail if it still corresponds to the chat we just sent to
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'text',
              content,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          // Skip reconciliation if the list no longer contains this chat (e.g. tab changed mid-send)
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            // 一覧の preview も即時更新する。incoming 優先ロジックで上書きされ得るが、
            // 楽観 UI では「operator が今送った文面」が一瞬見えるのが期待動作。
            // 次回 loadChats() で server 側の真の最新 (incoming 優先) に reconcile される。
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c)
          // Drop rows that no longer match the current tab (e.g. replying from 未読 moves chat to in_progress)
          let filtered = currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter)
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  const handleUpdateInlineDraft = async (draftId: string, draftAnswer: string) => {
    if (!selectedChatId || !chatDetail) throw new Error('チャットが選択されていません')
    const friendId = chatDetail.friendId
    const accountId = selectedAccountId
    try {
      const res = await api.chats.drafts.update(friendId, draftId, { draftAnswer })
      if (!res.success) throw new Error(res.error)
      setChatDetail((prev) => (prev && prev.friendId === friendId) ? {
        ...prev,
        pendingDrafts: (prev.pendingDrafts ?? []).map((draft) => draft.id === draftId ? {
          ...draft,
          ...res.data,
          questionMessageId: draft.questionMessageId,
        } : draft),
      } : prev)
      if (accountId) {
        notifyFaqDraftReviewChanged({
          accountId,
          draftId,
          sourceId: draftReviewSyncSourceIdRef.current,
        })
      }
    } catch (err) {
      setError('AI下書きの編集に失敗しました。')
      throw err
    }
  }

  const handleApproveInlineDraft = async (draftId: string) => {
    if (!selectedChatId || !chatDetail) throw new Error('チャットが選択されていません')
    const friendId = chatDetail.friendId
    const accountId = selectedAccountId
    try {
      const res = await api.chats.drafts.approve(friendId, draftId)
      if (!res.success) throw new Error(res.error)
      const { message } = res.data
      setChatDetail((prev) => (prev && prev.friendId === friendId) ? {
        ...prev,
        status: 'in_progress',
        lastMessageAt: message.createdAt,
        lastMessageContent: message.content,
        lastMessageDirection: 'outgoing',
        lastMessageType: message.messageType,
        pendingDrafts: (prev.pendingDrafts ?? []).filter((draft) => draft.id !== draftId),
        messages: [...(prev.messages ?? []), message],
      } : prev)
      setChats((prev) => {
        if (!prev.some((chat) => chat.friendId === friendId)) return prev
        const updated = prev.map((chat) => chat.friendId === friendId ? {
          ...chat,
          status: 'in_progress' as const,
          lastMessageAt: message.createdAt,
          lastMessageContent: message.content,
          lastMessageDirection: 'outgoing' as const,
          lastMessageType: message.messageType,
        } : chat)
        const currentFilter = statusFilterRef.current
        const currentUnansweredOnly = unansweredOnlyRef.current
        let filtered = currentFilter === 'all'
          ? updated
          : updated.filter((chat) => chat.status === currentFilter)
        if (currentUnansweredOnly) {
          filtered = filtered.filter((chat) => chat.friendId !== friendId)
        }
        return [...filtered].sort((a, b) => {
          const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
          const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
          return bt - at
        })
      })
      if (accountId) {
        notifyFaqDraftReviewChanged({
          accountId,
          draftId,
          sourceId: draftReviewSyncSourceIdRef.current,
        })
      }
    } catch (err) {
      setError('AI下書きの承認送信に失敗しました。再送せず状況を確認してください。')
      throw err
    }
  }

  const handleDiscardInlineDraft = async (draftId: string) => {
    if (!selectedChatId || !chatDetail) throw new Error('チャットが選択されていません')
    const friendId = chatDetail.friendId
    const accountId = selectedAccountId
    try {
      const res = await api.chats.drafts.discard(friendId, draftId)
      if (!res.success) throw new Error(res.error)
      setChatDetail((prev) => (prev && prev.friendId === friendId) ? {
        ...prev,
        pendingDrafts: (prev.pendingDrafts ?? []).filter((draft) => draft.id !== draftId),
      } : prev)
      if (accountId) {
        notifyFaqDraftReviewChanged({
          accountId,
          draftId,
          sourceId: draftReviewSyncSourceIdRef.current,
        })
      }
    } catch (err) {
      setError('AI下書きの破棄に失敗しました。')
      throw err
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { status: newStatus })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('ステータスの更新に失敗しました。')
    }
  }

  const handleSaveNotes = async () => {
    if (!selectedChatId) return
    setSavingNotes(true)
    try {
      await api.chats.update(selectedChatId, { notes })
      loadChatDetail(selectedChatId)
    } catch {
      setError('メモの保存に失敗しました。')
    } finally {
      setSavingNotes(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME変換確定のEnterでは送信しない
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
    if (e.key !== 'Enter') return
    // sendMode 'enter': Enter単体で送信、Shift+Enterは改行
    // sendMode 'shift-enter': Shift+Enterで送信、Enter単体は改行
    const shouldSend = sendMode === 'enter' ? !e.shiftKey : e.shiftKey
    if (shouldSend) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div>
      <Header title="オペレーターチャット" />

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-4 h-[calc(100vh-120px)] lg:h-[calc(100vh-180px)]">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-96 lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* タブ (全て / 未読 / 対応中 / 解決済) は意図的に削除。直近メッセージが見やすい LINE 風一覧を優先。 */}

          {/* Filter row */}
          <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center gap-2">
            {statusFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                disabled={unansweredOnly}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === f.key
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } ${unansweredOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {f.label}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ml-auto cursor-pointer select-none">
              <input
                type="checkbox"
                checked={unansweredOnly}
                onChange={(e) => setUnansweredOnly(e.target.checked)}
                className="rounded"
              />
              🔥 未対応のみ
            </label>
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {chats.map((chat) => {
                  const isSelected = selectedChatId === chat.id
                  // 「真の自発（要対応）」= chat.status='unread'。webhook 側で auto_reply に
                  // マッチしなかった incoming のみ unread に設定される。auto_reply trigger
                  // (キーワード "コスト比較" 等) は matched 扱いで unread 化しない。
                  // bold / 🟥 の表示はこの status を使う。direction だけだと button 押下も
                  // 強調してしまって S/N 比が悪化する。
                  const needsAttention = chat.status === 'unread'
                  // 最新メッセージの本文 preview。flex/image は文字列で見せても意味が薄いので type 表記に置換。
                  const previewRaw = chat.lastMessageContent ?? ''
                  const preview = (() => {
                    if (chat.lastMessageType === 'image') return '📷 画像'
                    if (chat.lastMessageType === 'flex') return '📋 Flexメッセージ'
                    if (chat.lastMessageType === 'sticker') return '🎨 スタンプ'
                    if (chat.lastMessageType === 'video') return '🎥 動画'
                    if (chat.lastMessageType === 'audio') return '🎤 音声'
                    if (chat.lastMessageType === 'file') return '📎 ファイル'
                    if (chat.lastMessageType === 'location') return '📍 位置情報'
                    return previewRaw.replace(/\n+/g, ' ').slice(0, 60)
                  })()
                  return (
                    <button
                      key={chat.id}
                      onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                        isSelected && !selectedFriendId ? 'bg-green-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{chat.friendName.charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              {chat.status === 'unread' && (
                                <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" aria-label="未読" />
                              )}
                              <p className="text-sm font-medium text-gray-900 truncate">{chat.friendName}</p>
                            </div>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">{formatDatetime(chat.lastMessageAt)}</span>
                          </div>
                          <p
                            className={`text-xs mt-0.5 truncate ${
                              needsAttention
                                ? 'text-gray-900 font-medium'
                                : 'text-gray-400'
                            }`}
                            title={preview}
                          >
                            {chat.lastMessageDirection === 'outgoing' && (
                              <span className="text-gray-400 mr-1">↪</span>
                            )}
                            {preview || <span className="italic text-gray-300">(まだメッセージなし)</span>}
                          </p>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">チャットを選択してください</p>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="px-4 py-4 border-b border-gray-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {chatDetail.friendName}
                    </p>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mt-1 ${statusConfig[chatDetail.status].className}`}
                    >
                      {statusConfig[chatDetail.status].label}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    ref={expandHistoryButtonRef}
                    type="button"
                    onClick={() => setIsHistoryExpanded(true)}
                    aria-label="チャット履歴を拡大表示"
                    aria-haspopup="dialog"
                    aria-expanded={isHistoryExpanded}
                    aria-controls="expanded-chat-history"
                    title="クリックしてチャット履歴を大きく表示"
                    className="inline-flex min-h-[44px] lg:min-h-0 cursor-pointer items-center gap-1.5 rounded-md border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 transition-colors hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-1"
                  >
                    <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" />
                    </svg>
                    拡大表示
                  </button>
                  {unansweredOnly && chats.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const idx = chats.findIndex((c) => c.id === selectedChatId)
                        if (idx < 0) return
                        const next = chats[(idx + 1) % chats.length]
                        if (next && next.id !== selectedChatId) {
                          setSelectedChatId(next.id)
                        }
                      }}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 min-h-[44px] lg:min-h-0 text-sm font-medium text-white hover:bg-emerald-700"
                      title="次の未対応 friend に進む"
                    >
                      次の未対応 →
                    </button>
                  )}
                  {chatDetail.status !== 'unread' && (
                    <button
                      onClick={() => handleStatusUpdate('unread')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      未読に戻す
                    </button>
                  )}
                  {chatDetail.status !== 'in_progress' && (
                    <button
                      onClick={() => handleStatusUpdate('in_progress')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded-md transition-colors"
                    >
                      対応中にする
                    </button>
                  )}
                  {chatDetail.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusUpdate('resolved')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors"
                    >
                      解決済にする
                    </button>
                  )}
                </div>
              </div>

              {/* Messages — LINE-style chat bubbles */}
              <ChatMessageHistory
                messages={chatDetail.messages ?? []}
                friendPictureUrl={chatDetail.friendPictureUrl}
                scrollRef={messagesScrollRef}
                pendingDrafts={chatDetail.pendingDrafts}
                onUpdateDraft={handleUpdateInlineDraft}
                onApproveDraft={handleApproveInlineDraft}
                onDiscardDraft={handleDiscardInlineDraft}
              />

              {/* Notes */}
              <div className="px-4 py-2 border-t border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="メモを入力..."
                    className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSaveNotes}
                    disabled={savingNotes}
                    className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50"
                  >
                    {savingNotes ? '保存中...' : 'メモ保存'}
                  </button>
                </div>
              </div>

              {/* Send Message Form */}
              <div className="px-4 py-3 border-t border-gray-200">
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-gray-600">
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showLoadingIndicator}
                      onChange={(e) => setShowLoadingIndicator(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                    />
                    入力中ローディングを表示
                  </label>
                  <select
                    value={loadingSeconds}
                    onChange={(e) => setLoadingSeconds(Number.parseInt(e.target.value, 10))}
                    disabled={!showLoadingIndicator}
                    className="border border-gray-300 rounded-md px-2 py-1 bg-white disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {[5, 10, 15, 20, 30, 45, 60].map((sec) => (
                      <option key={sec} value={sec}>{sec}秒</option>
                    ))}
                  </select>
                  <span className="text-gray-500">送信キー:</span>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      checked={sendMode === 'enter'}
                      onChange={() => setSendMode('enter')}
                      className="accent-green-600"
                    />
                    <span>Enter</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      checked={sendMode === 'shift-enter'}
                      onChange={() => setSendMode('shift-enter')}
                      className="accent-green-600"
                    />
                    <span>Shift+Enter</span>
                  </label>
                </div>
                {/* 定型文ピッカー — 選択で messageContent に挿入するだけ (送信経路には触れない) */}
                <div className="mb-2">
                  <CannedResponsePicker
                    accountId={selectedAccountId}
                    onSelect={(text) => {
                      applyCannedSelection(text, setMessageContent)
                      requestAnimationFrame(() => {
                        const el = textareaRef.current
                        if (!el) return
                        el.focus()
                        const n = el.value.length
                        el.setSelectionRange(n, n)
                      })
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <PersonalizedTextEditor
                    mode="emoji-only"
                    textareaRef={textareaRef}
                    rows={4}
                    value={messageContent}
                    onChange={(value) => {
                      setMessageContent(value)
                      if (selectedChatId && isMessageInputFocused && value.trim()) {
                        void triggerLoadingAnimation(selectedChatId)
                      }
                    }}
                    pickerPlacement="above"
                    textareaProps={{
                      style: { maxHeight: '200px', overflowY: 'auto' },
                      onCompositionStart: () => { isComposingRef.current = true },
                      onCompositionEnd: () => { isComposingRef.current = false },
                      onFocus: () => {
                        setIsMessageInputFocused(true)
                        if (selectedChatId) {
                          void triggerLoadingAnimation(selectedChatId)
                        }
                      },
                      onBlur: () => setIsMessageInputFocused(false),
                      onKeyDown: handleKeyDown,
                    }}
                    placeholder="メッセージを入力..."
                    className="w-full min-h-[112px] text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-500 resize-none overflow-y-auto"
                    containerClassName="w-full space-y-2"
                  />
                  <div className="flex items-end justify-between gap-2">
                    <div className="relative">
                      <button
                        type="button"
                        aria-label="画像を添付"
                        aria-expanded={showImageUploader}
                        onClick={() => setShowImageUploader((shown) => !shown)}
                        className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 ${
                          pendingImage
                            ? 'border-green-500 bg-green-50 text-green-700'
                            : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                        }`}
                        title={pendingImage ? '送信する画像を確認・変更' : '画像を添付'}
                      >
                        <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828L18 9.828a4 4 0 10-5.657-5.657L5.757 10.757a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                      </button>
                      {showImageUploader && (
                        <div className="absolute bottom-full left-0 z-30 mb-2 max-h-[40vh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white p-3 shadow-xl">
                          <ImageUploader
                            mode="line-image"
                            value={pendingImage}
                            onChange={setPendingImage}
                            label="画像を送る (任意)"
                          />
                        </div>
                      )}
                    </div>
                    <button
                      onClick={handleSendMessage}
                      disabled={sending || (!messageContent.trim() && !pendingImage)}
                      className="min-h-[44px] px-5 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ backgroundColor: '#06C755' }}
                    >
                      {sending ? '送信中...' : '送信'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Right-most Panel: 友だち詳細サイドバー — chat detail を開いている時のみ表示 */}
        {/*
          friendId は **現在の selection** を優先する。chatDetail の load 中は前の chat
          のデータが残ったままなので、それを参照するとサイドバーだけ前の友だちを
          表示し続けて pane 間の不整合になる。selection ID 自体が friend_id なので
          直接渡せる (chat list SQL が `id: f.id` で friend_id を返す)。
        */}
        {(selectedChatId || selectedFriendId) && (
          <div className="hidden xl:flex">
            <FriendInfoSidebar
              friendId={selectedFriendId || selectedChatId}
              chatStatus={
                chatDetail && chatDetail.id === (selectedFriendId || selectedChatId)
                  ? { status: chatDetail.status, notes: chatDetail.notes }
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {isHistoryExpanded && chatDetail && (
        <>
          <div
            role="presentation"
            data-testid="chat-history-backdrop"
            className="fixed inset-0 z-[60] bg-black/50"
            onClick={closeExpandedHistory}
          />
          <section
            ref={expandedHistoryDialogRef}
            id="expanded-chat-history"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="expanded-chat-history-title"
            className="fixed inset-0 z-[70] flex min-h-0 flex-col overflow-hidden bg-white shadow-2xl sm:inset-[5vh_5vw] sm:rounded-xl"
          >
            <div className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <h2 id="expanded-chat-history-title" className="truncate text-base font-bold text-gray-900">
                  {chatDetail.friendName}のチャット履歴
                </h2>
                <p className="text-xs text-gray-500">拡大表示 — 大きな画面で履歴を確認できます</p>
              </div>
              <button
                ref={closeExpandedHistoryButtonRef}
                type="button"
                onClick={closeExpandedHistory}
                aria-label="拡大表示を閉じる"
                title="閉じる"
                className="inline-flex h-11 w-11 flex-shrink-0 cursor-pointer items-center justify-center rounded-full text-2xl leading-none text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                ×
              </button>
            </div>
            <ChatMessageHistory
              messages={chatDetail.messages ?? []}
              friendPictureUrl={chatDetail.friendPictureUrl}
              scrollRef={expandedMessagesScrollRef}
              pendingDrafts={chatDetail.pendingDrafts}
              onUpdateDraft={handleUpdateInlineDraft}
              onApproveDraft={handleApproveInlineDraft}
              onDiscardDraft={handleDiscardInlineDraft}
              expanded
            />
          </section>
        </>
      )}

      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
