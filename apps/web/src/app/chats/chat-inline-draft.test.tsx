// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  listChats: vi.fn(),
  getChat: vi.fn(),
  listFriends: vi.fn(),
  sendChat: vi.fn(),
  updateChat: vi.fn(),
  updateDraft: vi.fn(),
  approveDraft: vi.fn(),
  discardDraft: vi.fn(),
  getQuota: vi.fn(),
}))

const reviewSyncMocks = vi.hoisted(() => ({
  notify: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    chats: {
      list: apiMocks.listChats,
      get: apiMocks.getChat,
      send: apiMocks.sendChat,
      update: apiMocks.updateChat,
      drafts: {
        update: apiMocks.updateDraft,
        approve: apiMocks.approveDraft,
        discard: apiMocks.discardDraft,
      },
    },
    friends: { list: apiMocks.listFriends },
    lineAccounts: { getQuota: apiMocks.getQuota },
  },
  fetchApi: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))
vi.mock('@/lib/faq-draft-review-sync', () => ({
  notifyFaqDraftReviewChanged: reviewSyncMocks.notify,
  subscribeFaqDraftReviewChanges: reviewSyncMocks.subscribe,
}))
vi.mock('@/components/layout/header', () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/chats/friend-info-sidebar', () => ({ default: () => null }))
vi.mock('@/components/shared/image-uploader', () => ({
  default: ({ label }: { label: string }) => <div data-testid="chat-image-uploader">{label}</div>,
}))
vi.mock('@/components/chats/canned-response-picker', () => ({
  default: ({ compact = false }: { compact?: boolean }) => (
    <button
      type="button"
      aria-label={compact ? '定型文を選ぶ' : undefined}
      data-compact={compact ? 'true' : 'false'}
    >
      {compact ? '□' : '定型文を選ぶ'}
    </button>
  ),
}))
vi.mock('@/components/shared/personalized-text-editor', () => ({
  default: ({
    value,
    onChange,
    rows,
    textareaRef,
    textareaProps,
    className,
    containerClassName,
    toolbarPlacement = 'above',
    compactToolbar = false,
    toolbarClassName,
    toolbarLeading,
    toolbarTrailing,
  }: {
    value: string
    onChange: (value: string) => void
    rows?: number
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>
    textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>
    className?: string
    containerClassName?: string
    toolbarPlacement?: 'above' | 'below'
    compactToolbar?: boolean
    toolbarClassName?: string
    toolbarLeading?: React.ReactNode
    toolbarTrailing?: React.ReactNode
  }) => (
    <div data-testid="personalized-editor" className={containerClassName}>
      {toolbarPlacement === 'above' && (
        <div role="group" aria-label="テキスト編集ツール" className={toolbarClassName}>
          {toolbarLeading}
          <button
            type="button"
            aria-label={compactToolbar ? '絵文字を選ぶ' : '絵文字'}
            data-compact={compactToolbar ? 'true' : 'false'}
          >☺</button>
          {toolbarTrailing}
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label="メッセージを入力"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={className}
        {...textareaProps}
      />
      {toolbarPlacement === 'below' && (
        <div role="group" aria-label="テキスト編集ツール" className={toolbarClassName}>
          {toolbarLeading}
          <button
            type="button"
            aria-label={compactToolbar ? '絵文字を選ぶ' : '絵文字'}
            data-compact={compactToolbar ? 'true' : 'false'}
          >☺</button>
          {toolbarTrailing}
        </div>
      )}
    </div>
  ),
}))

import ChatsPage from './page'

const chat = {
  // 一覧は chats.id、詳細レスポンスは公開IDとして friend_id を返す。
  id: 'chat-row-1',
  friendId: 'friend-1',
  friendName: 'あやこ',
  friendPictureUrl: null,
  operatorId: null,
  status: 'in_progress' as const,
  notes: null,
  lastMessageAt: '2026-07-21T10:00:00+09:00',
  lastMessageContent: '営業時間は？',
  lastMessageDirection: 'incoming' as const,
  lastMessageType: 'text',
  createdAt: '2026-07-21T09:00:00+09:00',
  updatedAt: '2026-07-21T10:00:00+09:00',
}

const messages = [
  {
    id: 'message-1',
    direction: 'incoming' as const,
    messageType: 'text',
    content: '最初の質問',
    createdAt: '2026-07-21T09:00:00+09:00',
  },
  {
    id: 'message-2',
    direction: 'incoming' as const,
    messageType: 'text',
    content: '営業時間は？',
    createdAt: '2026-07-21T10:00:00+09:00',
  },
]

const pendingDraft = {
  id: 'draft-1',
  question: '営業時間は？',
  draftAnswer: '10時からです',
  createdAt: '2026-07-21T10:01:00.000',
  updatedAt: '2026-07-21T10:01:00.000',
  questionMessageId: 'message-2',
}

function detail(...args: [pendingDrafts?: typeof pendingDraft[]]) {
  const pendingDrafts = args.length === 0 ? [pendingDraft] : args[0]
  return {
    ...chat,
    id: 'friend-1',
    messages,
    ...(pendingDrafts === undefined ? {} : { pendingDrafts }),
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/chats')
  apiMocks.listChats.mockResolvedValue({ success: true, data: [chat] })
  apiMocks.listFriends.mockResolvedValue({ success: true, data: { items: [] } })
  apiMocks.getChat.mockResolvedValue({ success: true, data: detail() })
  apiMocks.sendChat.mockResolvedValue({ success: true })
  apiMocks.updateChat.mockResolvedValue({ success: true })
  apiMocks.updateDraft.mockImplementation(async (_chatId: string, _draftId: string, body: { draftAnswer: string }) => ({
    success: true,
    data: { ...pendingDraft, draftAnswer: body.draftAnswer },
  }))
  apiMocks.approveDraft.mockResolvedValue({
    success: true,
    data: {
      draft: { ...pendingDraft, status: 'approved' },
      message: {
        id: 'approved-message',
        direction: 'outgoing',
        messageType: 'text',
        content: '10時からです',
        createdAt: '2026-07-21T10:02:00+09:00',
      },
    },
  })
  apiMocks.discardDraft.mockResolvedValue({ success: true, data: { id: 'draft-1', status: 'discarded' } })
  apiMocks.getQuota.mockResolvedValue({
    success: true,
    data: { plan_label: 'ライトプラン相当（推定）', limit: 5000, used: 4958, remaining: 42, type: 'limited' },
  })
  reviewSyncMocks.subscribe.mockReturnValue(vi.fn())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openChat() {
  render(<ChatsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /あやこ/ }))
  return await screen.findByTestId('chat-message-history')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('個別チャットのインラインAI下書き', () => {
  it('該当質問の直後へ点線枠とAI下書きバッジで表示する', async () => {
    const history = await openChat()
    const questionBubble = within(history).getByText('営業時間は？').closest('[data-testid="chat-message-bubble"]')
    const messageEntry = questionBubble?.parentElement?.parentElement?.parentElement
    const draftCard = within(history).getByTestId('inline-ai-draft')

    expect(within(draftCard).getByText('AI下書き')).toBeTruthy()
    expect(within(draftCard).getByText('10時からです')).toBeTruthy()
    expect(draftCard.className).toContain('border-dashed')
    expect(messageEntry?.lastElementChild).toBe(draftCard)
    expect(within(history).getByText('最初の質問').compareDocumentPosition(draftCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('pendingDrafts 欠落と空配列では既存タイムラインDOMが同一', async () => {
    apiMocks.getChat.mockResolvedValueOnce({ success: true, data: detail(undefined) })
    const withoutField = await openChat()
    const baseline = withoutField.innerHTML
    cleanup()

    apiMocks.getChat.mockResolvedValueOnce({ success: true, data: detail([]) })
    const emptyList = await openChat()
    expect(emptyList.innerHTML).toBe(baseline)
    expect(screen.queryByText('AI下書き')).toBeNull()
  })

  it('本文をその場で編集して保存する', async () => {
    await openChat()
    fireEvent.click(screen.getByRole('button', { name: '下書きを編集' }))
    const editor = screen.getByRole('textbox', { name: 'AI下書き本文' })
    fireEvent.change(editor, { target: { value: '11時から営業します' } })
    fireEvent.click(screen.getByRole('button', { name: '編集を保存' }))

    await waitFor(() => expect(apiMocks.updateDraft).toHaveBeenCalledWith(
      'friend-1',
      'draft-1',
      { draftAnswer: '11時から営業します' },
    ))
    expect(await screen.findByText('11時から営業します')).toBeTruthy()
    expect(reviewSyncMocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      draftId: 'draft-1',
      sourceId: expect.any(String),
    }))
  })

  it('拡大履歴で保存した本文を通常履歴の編集欄にも同期する', async () => {
    await openChat()
    fireEvent.click(screen.getByRole('button', { name: 'チャット履歴を拡大表示' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '下書きを編集' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'AI下書き本文' }), {
      target: { value: '11時から営業します' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '編集を保存' }))
    await waitFor(() => expect(apiMocks.updateDraft).toHaveBeenCalledTimes(1))
    fireEvent.click(within(dialog).getByRole('button', { name: '拡大表示を閉じる' }))

    fireEvent.click(screen.getByRole('button', { name: '下書きを編集' }))
    expect((screen.getByRole('textbox', { name: 'AI下書き本文' }) as HTMLTextAreaElement).value)
      .toBe('11時から営業します')
  })

  it('片方で編集中でも、もう片方の保存後は古い編集バッファを閉じる', async () => {
    await openChat()
    const normalCard = screen.getByTestId('inline-ai-draft')
    fireEvent.click(within(normalCard).getByRole('button', { name: '下書きを編集' }))
    fireEvent.change(within(normalCard).getByRole('textbox', { name: 'AI下書き本文' }), {
      target: { value: '保存前の古い本文' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'チャット履歴を拡大表示' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '下書きを編集' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'AI下書き本文' }), {
      target: { value: '確定した新しい本文' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '編集を保存' }))
    await waitFor(() => expect(apiMocks.updateDraft).toHaveBeenCalledTimes(1))
    fireEvent.click(within(dialog).getByRole('button', { name: '拡大表示を閉じる' }))

    expect(screen.queryByRole('textbox', { name: 'AI下書き本文' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '下書きを編集' }))
    expect((screen.getByRole('textbox', { name: 'AI下書き本文' }) as HTMLTextAreaElement).value)
      .toBe('確定した新しい本文')
  })

  it('承認送信後は下書きを消し、同じ内容を通常の送信メッセージとして残す', async () => {
    const history = await openChat()
    fireEvent.click(screen.getByRole('button', { name: '承認して送信' }))

    await waitFor(() => expect(apiMocks.approveDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('AI下書き')).toBeNull())
    expect(within(history).getByText('10時からです').closest('[data-testid="chat-message-bubble"]')).toBeTruthy()
    expect(reviewSyncMocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      draftId: 'draft-1',
      sourceId: expect.any(String),
    }))
  })

  it('承認結果が不明なときはカード内でも再送しないよう案内する', async () => {
    apiMocks.approveDraft.mockRejectedValueOnce(new Error('ambiguous delivery'))
    await openChat()
    const card = screen.getByTestId('inline-ai-draft')
    fireEvent.click(within(card).getByRole('button', { name: '承認して送信' }))

    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain('再送せず')
    expect(apiMocks.approveDraft).toHaveBeenCalledTimes(1)
    expect((within(card).getByRole('button', { name: '承認して送信' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('未対応のみ表示で承認した友だちを一覧から即時に外す', async () => {
    await openChat()
    fireEvent.click(screen.getByRole('checkbox', { name: /未対応のみ/ }))
    await waitFor(() => expect(apiMocks.listChats).toHaveBeenLastCalledWith(expect.objectContaining({ unansweredOnly: true })))
    fireEvent.click(screen.getByRole('button', { name: '承認して送信' }))

    await waitFor(() => expect(apiMocks.approveDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /あやこ/ })).toHaveLength(0))
  })

  it('行内確認後に破棄し、同じ下書きをタイムラインから消す', async () => {
    await openChat()
    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }))
    fireEvent.click(screen.getByRole('button', { name: '破棄する' }))

    await waitFor(() => expect(apiMocks.discardDraft).toHaveBeenCalledWith('friend-1', 'draft-1'))
    expect(screen.queryByText('AI下書き')).toBeNull()
    expect(reviewSyncMocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      draftId: 'draft-1',
      sourceId: expect.any(String),
    }))
  })

  it('中央受信箱の別タブで処理した通知を受けると、選択中チャットを再読込する', async () => {
    await openChat()
    await waitFor(() => expect(reviewSyncMocks.subscribe).toHaveBeenCalledTimes(1))
    const listener = reviewSyncMocks.subscribe.mock.calls[0]?.[0] as ((event: {
      accountId: string
      draftId: string
      sourceId: string
    }) => void)

    listener({ accountId: 'account-1', draftId: 'draft-1', sourceId: 'central-other-tab' })

    await waitFor(() => expect(apiMocks.getChat).toHaveBeenCalledTimes(2))
    expect(apiMocks.getChat).toHaveBeenLastCalledWith('chat-row-1')
  })
})

describe('返信コンポーザの余白', () => {
  it('送信欄の近くに控えめな残り送信数バッジを表示する', async () => {
    await openChat()

    const badge = await screen.findByRole('status', { name: 'LINE公式の残り送信数' })
    expect(badge.textContent).toBe('残り 42通')
    expect(badge.className).toContain('text-xs')
  })

  it('添付・定型文・絵文字を下段1行へまとめ、本文を従来より2行以上広げる', async () => {
    await openChat()

    expect(screen.queryByTestId('chat-image-uploader')).toBeNull()
    const toolbar = screen.getByRole('group', { name: 'テキスト編集ツール' })
    const attachButton = within(toolbar).getByRole('button', { name: '画像を添付' })
    expect(attachButton.className).toContain('h-11')
    expect(attachButton.className).toContain('w-11')
    expect(within(toolbar).getByRole('button', { name: '定型文を選ぶ' }).dataset.compact).toBe('true')
    expect(within(toolbar).getByRole('button', { name: '絵文字を選ぶ' }).dataset.compact).toBe('true')
    expect(within(toolbar).getByRole('button', { name: '送信' })).toBeTruthy()
    expect(toolbar.className).toContain('flex-nowrap')
    fireEvent.click(attachButton)
    expect(screen.getByTestId('chat-image-uploader').textContent).toContain('画像を送る (任意)')

    const textarea = screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLTextAreaElement
    const minimumHeight = Number(textarea.className.match(/min-h-\[(\d+)px\]/)?.[1])
    expect(textarea.rows).toBeGreaterThanOrEqual(6)
    expect(minimumHeight - 112).toBeGreaterThanOrEqual(40)
    expect(minimumHeight).toBeLessThanOrEqual(Number.parseInt(textarea.style.maxHeight, 10))
    expect(textarea.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('personalized-editor').className).toContain('w-full')
    expect(screen.getByText('送信キー:')).toBeTruthy()
    expect(screen.getByTestId('inline-ai-draft')).toBeTruthy()
    expect(apiMocks.updateDraft).not.toHaveBeenCalled()
    expect(apiMocks.approveDraft).not.toHaveBeenCalled()
    expect(apiMocks.discardDraft).not.toHaveBeenCalled()
  })
})

describe('チャット詳細の切替競合', () => {
  it('先に選んだ友だちの遅い応答で、後から選んだ友だちを上書きしない', async () => {
    const firstChat = { ...chat, id: 'friend-a', friendId: 'friend-a', friendName: 'Aさん' }
    const secondChat = { ...chat, id: 'friend-b', friendId: 'friend-b', friendName: 'Bさん' }
    const firstResponse = deferred<{ success: true; data: ReturnType<typeof detail> }>()
    const secondResponse = deferred<{ success: true; data: ReturnType<typeof detail> }>()
    apiMocks.listChats.mockResolvedValue({ success: true, data: [firstChat, secondChat] })
    apiMocks.getChat.mockImplementation((id: string) => (
      id === 'friend-a' ? firstResponse.promise : secondResponse.promise
    ))

    render(<ChatsPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Aさん/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bさん/ }))
    secondResponse.resolve({
      success: true,
      data: {
        ...detail([]),
        id: 'friend-b',
        friendId: 'friend-b',
        friendName: 'Bさん',
        messages: [{ ...messages[0], id: 'message-b', content: 'Bの詳細' }],
      },
    })
    const history = await screen.findByTestId('chat-message-history')
    expect(within(history).getByText('Bの詳細')).toBeTruthy()

    firstResponse.resolve({
      success: true,
      data: {
        ...detail([]),
        id: 'friend-a',
        friendId: 'friend-a',
        friendName: 'Aさん',
        messages: [{ ...messages[0], id: 'message-a', content: 'Aの遅い詳細' }],
      },
    })
    await waitFor(() => expect(within(history).queryByText('Aの遅い詳細')).toBeNull())
    expect(within(history).getByText('Bの詳細')).toBeTruthy()
  })
})
