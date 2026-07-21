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
  },
  fetchApi: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1' }),
}))
vi.mock('@/components/layout/header', () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/chats/friend-info-sidebar', () => ({ default: () => null }))
vi.mock('@/components/shared/image-uploader', () => ({
  default: ({ label }: { label: string }) => <div data-testid="chat-image-uploader">{label}</div>,
}))
vi.mock('@/components/chats/canned-response-picker', () => ({
  default: () => <button type="button">定型文を選ぶ</button>,
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
  }: {
    value: string
    onChange: (value: string) => void
    rows?: number
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>
    textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>
    className?: string
    containerClassName?: string
  }) => (
    <div data-testid="personalized-editor" className={containerClassName}>
      <textarea
        ref={textareaRef}
        aria-label="メッセージを入力"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={className}
        {...textareaProps}
      />
      <button type="button" aria-label="絵文字を選ぶ">☺</button>
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

  it('承認送信後は下書きを消し、同じ内容を通常の送信メッセージとして残す', async () => {
    const history = await openChat()
    fireEvent.click(screen.getByRole('button', { name: '承認して送信' }))

    await waitFor(() => expect(apiMocks.approveDraft).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('AI下書き')).toBeNull())
    expect(within(history).getByText('10時からです').closest('[data-testid="chat-message-bubble"]')).toBeTruthy()
  })

  it('承認結果が不明なときはカード内でも再送しないよう案内する', async () => {
    apiMocks.approveDraft.mockRejectedValueOnce(new Error('ambiguous delivery'))
    await openChat()
    const card = screen.getByTestId('inline-ai-draft')
    fireEvent.click(within(card).getByRole('button', { name: '承認して送信' }))

    const alert = await within(card).findByRole('alert')
    expect(alert.textContent).toContain('再送せず')
    expect(apiMocks.approveDraft).toHaveBeenCalledTimes(1)
  })

  it('行内確認後に破棄し、同じ下書きをタイムラインから消す', async () => {
    await openChat()
    fireEvent.click(screen.getByRole('button', { name: '下書きを破棄' }))
    fireEvent.click(screen.getByRole('button', { name: '破棄する' }))

    await waitFor(() => expect(apiMocks.discardDraft).toHaveBeenCalledWith('friend-1', 'draft-1'))
    expect(screen.queryByText('AI下書き')).toBeNull()
  })
})

describe('返信コンポーザの余白', () => {
  it('画像は小さいアイコンから到達でき、本文は4行・全幅になる', async () => {
    await openChat()

    expect(screen.queryByTestId('chat-image-uploader')).toBeNull()
    const attachButton = screen.getByRole('button', { name: '画像を添付' })
    expect(attachButton.className).toContain('h-11')
    expect(attachButton.className).toContain('w-11')
    fireEvent.click(attachButton)
    expect(screen.getByTestId('chat-image-uploader').textContent).toContain('画像を送る (任意)')

    const textarea = screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLTextAreaElement
    expect(textarea.rows).toBeGreaterThanOrEqual(4)
    expect(textarea.className).toContain('min-h-')
    expect(screen.getByTestId('personalized-editor').className).toContain('w-full')
    expect(screen.getByRole('button', { name: '絵文字を選ぶ' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '定型文を選ぶ' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '送信' })).toBeTruthy()
    expect(screen.getByText('送信キー:')).toBeTruthy()
  })
})
