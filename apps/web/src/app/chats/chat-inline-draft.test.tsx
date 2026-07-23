// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
  default: ({
    compact = false,
    compactLabel,
  }: {
    compact?: boolean
    compactLabel?: string
  }) => (
    <button
      type="button"
      aria-label={compact ? '定型文を選ぶ' : undefined}
      data-compact={compact ? 'true' : 'false'}
    >
      {compact ? compactLabel ?? '□' : '定型文を選ぶ'}
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
    compactToolbarLabel,
    toolbarClassName,
    toolbarLeading,
    toolbarTrailing,
    fieldRowClassName,
    fieldTrailing,
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
    compactToolbarLabel?: string
    toolbarClassName?: string
    toolbarLeading?: React.ReactNode
    toolbarTrailing?: React.ReactNode
    fieldRowClassName?: string
    fieldTrailing?: React.ReactNode
  }) => {
    const toolbar = (
      <div role="group" aria-label="テキスト編集ツール" className={toolbarClassName}>
        {toolbarLeading}
        <button
          type="button"
          aria-label={compactToolbar ? '絵文字を選ぶ' : '絵文字'}
          data-compact={compactToolbar ? 'true' : 'false'}
        >
          {compactToolbarLabel ?? '☺'}
        </button>
        {toolbarTrailing}
      </div>
    )
    const textarea = (
      <textarea
        ref={textareaRef}
        aria-label="メッセージを入力"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={className}
        {...textareaProps}
      />
    )

    return (
      <div data-testid="personalized-editor" className={containerClassName}>
        {toolbarPlacement === 'above' && toolbar}
        {fieldTrailing ? (
          <div data-testid="chat-compose-row" className={fieldRowClassName}>
            <div className="min-w-0 flex-1">{textarea}</div>
            {fieldTrailing}
          </div>
        ) : textarea}
        {toolbarPlacement === 'below' && toolbar}
      </div>
    )
  },
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
  isUnanswered: false,
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
  window.localStorage.clear()
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

describe('個別チャット一覧の未対応表示', () => {
  it('keyword自動応答済み・keep_unresponded・人間未対応を正本フラグだけで描き分ける', async () => {
    apiMocks.listChats.mockResolvedValue({
      success: true,
      data: [
        {
          ...chat,
          id: 'auto-replied',
          friendId: 'auto-replied',
          friendName: '自動応答済み',
          status: 'unread',
          isUnanswered: false,
        },
        {
          ...chat,
          id: 'keep-unresponded',
          friendId: 'keep-unresponded',
          friendName: '確認を残す',
          status: 'resolved',
          isUnanswered: true,
        },
        {
          ...chat,
          id: 'human-unanswered',
          friendId: 'human-unanswered',
          friendName: '人間の未対応',
          status: 'in_progress',
          isUnanswered: true,
        },
      ],
    })

    render(<ChatsPage />)

    const autoReplied = await screen.findByRole('button', { name: /自動応答済み/ })
    const keepUnresponded = screen.getByRole('button', { name: /確認を残す/ })
    const humanUnanswered = screen.getByRole('button', { name: /人間の未対応/ })
    expect(autoReplied.querySelector('.bg-red-500')).toBeNull()
    expect(keepUnresponded.querySelector('.bg-red-500')?.getAttribute('aria-label')).toBe('未対応')
    expect(humanUnanswered.querySelector('.bg-red-500')?.getAttribute('aria-label')).toBe('未対応')
  })

  it('focusで一覧を再取得し、自動応答完了後の赤丸を消す', async () => {
    apiMocks.listChats
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...chat, status: 'unread', isUnanswered: true }],
      })
      .mockResolvedValue({
        success: true,
        data: [{ ...chat, status: 'unread', isUnanswered: false }],
      })

    render(<ChatsPage />)

    const row = await screen.findByRole('button', { name: /あやこ/ })
    expect(row.querySelector('.bg-red-500')).toBeTruthy()

    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(apiMocks.listChats).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /あやこ/ }).querySelector('.bg-red-500')).toBeNull()
    })
  })

  it('初回取得中のfocus再取得が先に完了しても一覧のloadingを解除する', async () => {
    const initial = deferred<{ success: true; data: typeof chat[] }>()
    apiMocks.listChats
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce({ success: true, data: [chat] })

    const { container } = render(<ChatsPage />)
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(5)

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(apiMocks.listChats).toHaveBeenCalledTimes(2))
    initial.resolve({ success: true, data: [] })

    expect(await screen.findByRole('button', { name: /あやこ/ })).toBeTruthy()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('background再取得の一時失敗では既存一覧へエラーを重ねない', async () => {
    apiMocks.listChats
      .mockResolvedValueOnce({ success: true, data: [chat] })
      .mockRejectedValueOnce(new Error('temporary polling failure'))

    render(<ChatsPage />)
    expect(await screen.findByRole('button', { name: /あやこ/ })).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(apiMocks.listChats).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('チャットの読み込みに失敗しました。もう一度お試しください。')).toBeNull()
    expect(screen.getByRole('button', { name: /あやこ/ })).toBeTruthy()
  })

  it('deep-linkで一覧外の人間未対応を詳細APIの正本フラグ付きで補完する', async () => {
    window.history.replaceState(null, '', '/chats?friend=friend-1')
    apiMocks.listChats.mockResolvedValue({ success: true, data: [] })
    apiMocks.getChat.mockResolvedValue({
      success: true,
      data: { ...detail([]), status: 'resolved', isUnanswered: true },
    })

    render(<ChatsPage />)

    const row = await screen.findByRole('button', { name: /あやこ/ })
    expect(apiMocks.getChat).toHaveBeenCalledWith('friend-1')
    expect(row.querySelector('.bg-red-500')?.getAttribute('aria-label')).toBe('未対応')
  })
})

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

describe('履歴を主役にする返信コンポーザ', () => {
  it('残り送信数をメモ行へ収め、履歴を flex の主領域にする', async () => {
    await openChat()

    const badge = await screen.findByRole('status', { name: 'LINE公式の残り送信数' })
    expect(badge.textContent).toBe('残り 42通')
    expect(badge.className).toContain('text-xs')
    expect(badge.closest('[data-testid="chat-notes-row"]')).toBeTruthy()

    const detailPanel = screen.getByTestId('chat-detail-panel')
    const history = screen.getByTestId('chat-message-history')
    const bubble = within(history).getAllByTestId('chat-message-bubble')[0]
    const composer = screen.getByTestId('chat-composer')

    expect(detailPanel.className).toContain('min-h-0')
    expect(history.className).toContain('basis-0')
    expect(history.className).toContain('min-h-0')
    expect(history.className).toContain('flex-1')
    expect(bubble.className).toContain('text-base')
    expect(composer.className).toContain('shrink-0')
    expect(composer.className).not.toContain('flex-1')
  })

  it('48pxから約5行まで伸びる入力欄の横へ送信を置き、mobile下端へ固定する', async () => {
    await openChat()

    expect(screen.queryByTestId('chat-image-uploader')).toBeNull()
    const toolbar = screen.getByRole('group', { name: 'テキスト編集ツール' })
    const attachButton = within(toolbar).getByRole('button', { name: '画像を添付' })
    const cannedButton = within(toolbar).getByRole('button', { name: '定型文を選ぶ' })
    const emojiButton = within(toolbar).getByRole('button', { name: '絵文字を選ぶ' })
    const composer = screen.getByTestId('chat-composer')
    const composeRow = screen.getByTestId('chat-compose-row')
    const sendButton = within(composeRow).getByRole('button', { name: '送信' })

    expect(composer.className).toContain('sticky')
    expect(composer.className).toContain('bottom-0')
    expect(composer.className).toContain('shrink-0')
    expect(composer.className).not.toContain('pb-16')
    expect(attachButton.className).toContain('h-11')
    expect(attachButton.textContent).toContain('添付')
    expect(cannedButton.dataset.compact).toBe('true')
    expect(cannedButton.textContent).toContain('定型文')
    expect(emojiButton.dataset.compact).toBe('true')
    expect(emojiButton.textContent).toContain('絵文字')
    expect(within(toolbar).queryByRole('button', { name: '送信' })).toBeNull()
    expect(sendButton).toBeTruthy()
    expect(toolbar.className).toContain('flex-nowrap')
    expect(toolbar.className).toContain('pr-14')
    fireEvent.click(attachButton)
    expect(screen.getByTestId('chat-image-uploader').textContent).toContain('画像を送る (任意)')

    const textarea = screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLTextAreaElement
    expect(textarea.rows).toBe(2)
    expect(textarea.className).toContain('min-h-[48px]')
    expect(textarea.className).toContain('text-base')
    expect(textarea.className).toContain('py-1')
    expect(textarea.className).toContain('leading-5')
    expect(textarea.style.height).toBe('48px')
    expect(textarea.style.maxHeight).toBe('120px')
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 180 })
    fireEvent.change(textarea, { target: { value: '5行を超える長い返信文' } })
    await waitFor(() => expect(textarea.style.height).toBe('120px'))
    expect(textarea.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('personalized-editor').className).toContain('w-full')
    expect(screen.queryByText('送信キー:')).toBeNull()
    expect(screen.getByTestId('inline-ai-draft')).toBeTruthy()
    expect(apiMocks.updateDraft).not.toHaveBeenCalled()
    expect(apiMocks.approveDraft).not.toHaveBeenCalled()
    expect(apiMocks.discardDraft).not.toHaveBeenCalled()
  })

  it('設定は既定で畳み、変更した3値を再表示後も復元する', async () => {
    await openChat()

    const settingsButton = screen.getByRole('button', { name: '送信設定' })
    expect(settingsButton.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('group', { name: '送信設定項目' })).toBeNull()

    fireEvent.click(settingsButton)
    const settings = screen.getByRole('group', { name: '送信設定項目' })
    const loadingToggle = within(settings).getByRole('checkbox', { name: '入力中ローディングを表示' })
    const seconds = within(settings).getByRole('combobox', { name: '入力中ローディング秒数' })
    const shiftEnter = within(settings).getByRole('radio', { name: 'Shift+Enter' })
    fireEvent.click(loadingToggle)
    fireEvent.change(seconds, { target: { value: '30' } })
    fireEvent.click(shiftEnter)

    await waitFor(() => {
      expect(window.localStorage.getItem('lh_chat_show_loading_indicator')).toBe('1')
      expect(window.localStorage.getItem('lh_chat_loading_seconds')).toBe('30')
      expect(window.localStorage.getItem('chat.sendMode')).toBe('shift-enter')
    })

    cleanup()
    await openChat()
    const restoredButton = screen.getByRole('button', { name: '送信設定' })
    expect(restoredButton.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(restoredButton)
    const restored = screen.getByRole('group', { name: '送信設定項目' })
    await waitFor(() => {
      expect((within(restored).getByRole('checkbox', { name: '入力中ローディングを表示' }) as HTMLInputElement).checked).toBe(true)
      expect((within(restored).getByRole('combobox', { name: '入力中ローディング秒数' }) as HTMLSelectElement).value).toBe('30')
      expect((within(restored).getByRole('radio', { name: 'Shift+Enter' }) as HTMLInputElement).checked).toBe(true)
    })
  })

  it('通常送信・メモ保存・対応状態変更の既存API導線を保つ', async () => {
    await openChat()

    fireEvent.change(screen.getByRole('textbox', { name: 'メッセージを入力' }), {
      target: { value: '確認しました' },
    })
    fireEvent.click(screen.getByRole('button', { name: '送信' }))
    await waitFor(() => expect(apiMocks.sendChat).toHaveBeenCalledWith('chat-row-1', { content: '確認しました' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'メモを入力' }), {
      target: { value: '折り返し連絡' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'メモ保存' }))
    await waitFor(() => expect(apiMocks.updateChat).toHaveBeenCalledWith('chat-row-1', { notes: '折り返し連絡' }))

    fireEvent.click(screen.getByRole('button', { name: '対応操作' }))
    fireEvent.click(screen.getByRole('button', { name: '解決済にする' }))
    await waitFor(() => expect(apiMocks.updateChat).toHaveBeenCalledWith('chat-row-1', { status: 'resolved' }))
  })

  it('mobile全画面の詳細内で送信失敗を見せ、本文を再送判断のため残す', async () => {
    apiMocks.sendChat.mockRejectedValueOnce(new Error('send failed'))
    await openChat()

    const textarea = screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '失敗する返信' } })
    fireEvent.click(screen.getByRole('button', { name: '送信' }))

    const detailPanel = screen.getByTestId('chat-detail-panel')
    const alert = await within(detailPanel).findByRole('alert')
    expect(alert.textContent).toContain('メッセージの送信に失敗しました。')
    expect(textarea.value).toBe('失敗する返信')
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
