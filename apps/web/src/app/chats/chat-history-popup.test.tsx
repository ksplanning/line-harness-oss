// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  listChats: vi.fn(),
  getChat: vi.fn(),
  listFriends: vi.fn(),
  sendChat: vi.fn(),
  updateChat: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    chats: {
      list: apiMocks.listChats,
      get: apiMocks.getChat,
      send: apiMocks.sendChat,
      update: apiMocks.updateChat,
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
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/chats/canned-response-picker', () => ({ default: () => null }))

import ChatsPage from './page'

const chat = {
  id: 'friend-1',
  friendId: 'friend-1',
  friendName: '佐藤さん',
  friendPictureUrl: null,
  operatorId: null,
  status: 'in_progress' as const,
  isUnanswered: false,
  notes: null,
  lastMessageAt: '2026-07-19T01:02:00.000Z',
  lastMessageContent: '元の履歴メッセージ',
  lastMessageDirection: 'incoming' as const,
  lastMessageType: 'text',
  createdAt: '2026-07-19T01:00:00.000Z',
  updatedAt: '2026-07-19T01:02:00.000Z',
}

beforeEach(() => {
  window.history.replaceState(null, '', '/chats')
  apiMocks.listChats.mockResolvedValue({ success: true, data: [chat] })
  apiMocks.listFriends.mockResolvedValue({ success: true, data: { items: [] } })
  apiMocks.getChat.mockResolvedValue({
    success: true,
    data: {
      ...chat,
      messages: [
        {
          id: 'message-1',
          direction: 'incoming',
          messageType: 'text',
          content: '元の履歴メッセージ',
          createdAt: '2026-07-19T01:02:00.000Z',
        },
        {
          id: 'message-2',
          direction: 'outgoing',
          messageType: 'image',
          content: JSON.stringify({ originalContentUrl: 'https://example.test/image.jpg' }),
          createdAt: '2026-07-19T01:03:00.000Z',
        },
        {
          id: 'message-3',
          direction: 'incoming',
          messageType: 'flex',
          content: JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'Flex本文', wrap: true }] },
          }),
          createdAt: '2026-07-19T01:04:00.000Z',
        },
      ],
    },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.body.style.overflow = ''
})

async function openChatDetail() {
  render(<ChatsPage />)
  fireEvent.click(await screen.findByRole('button', { name: /佐藤さん/ }))
  await screen.findByRole('button', { name: 'チャット履歴を拡大表示' })
}

async function openExpandedHistory() {
  await openChatDetail()
  fireEvent.click(screen.getByRole('button', { name: 'チャット履歴を拡大表示' }))
  return screen.getByRole('dialog', { name: '佐藤さんのチャット履歴' })
}

describe('チャット詳細のモバイル配置', () => {
  it('identity と action を2段に分け、戻る・avatar・長い名前を窮屈にしない', async () => {
    const longFriendName = 'まつもとクリニック予約窓口のご担当者さま'
    apiMocks.getChat.mockResolvedValue({
      success: true,
      data: {
        ...chat,
        friendName: longFriendName,
        friendPictureUrl: 'https://example.test/friend.jpg',
        messages: [],
      },
    })

    await openChatDetail()
    const header = screen.getByTestId('chat-detail-header')
    const identity = within(header).getByTestId('chat-detail-identity')
    const actions = within(header).getByTestId('chat-detail-actions')
    const backButton = within(identity).getByRole('button', { name: '戻る' })
    const avatar = within(identity).getByTestId('chat-detail-avatar')
    const friendName = within(identity).getByText(longFriendName)

    expect(header.className).toContain('flex-col')
    expect(header.className).toContain('sm:flex-row')
    expect(identity.className).toContain('w-full')
    expect(backButton.className).toContain('h-11')
    expect(backButton.className).toContain('w-11')
    expect(avatar).toBeTruthy()
    expect(friendName.className).toContain('break-words')
    expect(friendName.className).toContain('sm:truncate')
    expect(actions.className).toContain('grid')
    expect(actions.className).toContain('grid-cols-2')
    expect(actions.className).toContain('sm:flex')
  })

  it('composer 表示中だけ mobile FAB を右下端の44pxへ退避し、一覧へ戻ると通常位置へ戻す', async () => {
    render(<ChatsPage />)
    const ccButton = screen.getByRole('button', { name: 'CCに依頼' })

    expect(ccButton.className).toContain('bottom-6')
    expect(ccButton.className).toContain('right-6')
    expect(ccButton.className).not.toContain('h-11')

    fireEvent.click(await screen.findByRole('button', { name: /佐藤さん/ }))
    const composer = (await screen.findByRole('textbox', { name: 'メッセージを入力' })).closest('[data-chat-composer]')

    await waitFor(() => {
      expect(composer?.className).toContain('pb-16')
      expect(composer?.className).toContain('sm:pb-3')
      expect(ccButton.className).toContain('bottom-2')
      expect(ccButton.className).toContain('right-2')
      expect(ccButton.className).toContain('h-11')
      expect(ccButton.className).toContain('w-11')
      expect(ccButton.className).toContain('sm:bottom-6')
      expect(ccButton.className).toContain('sm:right-6')
    })

    fireEvent.click(screen.getByRole('button', { name: '戻る' }))
    await waitFor(() => {
      expect(ccButton.className).toContain('bottom-6')
      expect(ccButton.className).toContain('right-6')
      expect(ccButton.className).not.toContain('h-11')
    })
  })
})

describe('個別チャット履歴の拡大表示', () => {
  it('狭い窓と同じ履歴内容をデスクトップ90%・モバイル全画面のダイアログで開く', async () => {
    const dialog = await openExpandedHistory()

    const histories = screen.getAllByTestId('chat-message-history')
    expect(histories).toHaveLength(2)
    expect(histories.every((history) => within(history).getByText('元の履歴メッセージ'))).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.className).toContain('fixed')
    expect(dialog.className).toContain('inset-0')
    expect(dialog.className).toContain('sm:inset-[5vh_5vw]')
    expect(dialog.className).toContain('z-[70]')
    expect(screen.getByTestId('chat-history-backdrop').className).toContain('z-[60]')
    expect(screen.getByRole('button', { name: 'CCに依頼' }).className).toContain('z-50')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '拡大表示を閉じる' }))
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('390px でも画像・Flex・吹き出しを履歴幅以内に収める', async () => {
    const dialog = await openExpandedHistory()
    const expandedHistory = within(dialog).getByTestId('chat-message-history')
    const image = expandedHistory.querySelector('img[src="https://example.test/image.jpg"]') as HTMLImageElement
    const flexMessage = within(expandedHistory).getByTestId('chat-flex-message')
    const flexBubble = within(expandedHistory).getByText('Flex本文').closest('div[style*="width"]') as HTMLDivElement

    expect(image.className).toContain('max-w-full')
    expect(flexMessage.className).toContain('max-w-full')
    expect(flexBubble.style.width).toBe('280px')
    expect(within(expandedHistory).getAllByTestId('chat-message-bubble').every((bubble) => bubble.className.includes('max-w-full'))).toBe(true)
    expect(within(expandedHistory).getByText('Flex本文')).toBeTruthy()
  })

  it('遅いメディア読込で高さが増えても、閲覧者が上へ動くまでは最新位置を保つ', async () => {
    let contentHeight = 1000
    let notifyResize: (() => void) | undefined
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver)
      }

      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return this.getAttribute('data-testid') === 'chat-message-history' ? contentHeight : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return this.getAttribute('data-testid') === 'chat-message-history' ? 300 : 0 },
    })

    try {
      const dialog = await openExpandedHistory()
      const history = within(dialog).getByTestId('chat-message-history') as HTMLDivElement
      expect(history.scrollTop).toBe(1000)
      expect(notifyResize).toBeTypeOf('function')

      contentHeight = 1400
      notifyResize?.()
      expect(history.scrollTop).toBe(1400)

      history.scrollTop = 100
      fireEvent.scroll(history)
      contentHeight = 1600
      notifyResize?.()
      expect(history.scrollTop).toBe(100)
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
      vi.unstubAllGlobals()
    }
  })

  it('× ボタンで閉じ、元の狭い表示を残す', async () => {
    await openExpandedHistory()

    fireEvent.click(screen.getByRole('button', { name: '拡大表示を閉じる' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    const histories = screen.getAllByTestId('chat-message-history')
    expect(histories).toHaveLength(1)
    expect(within(histories[0]).getByText('元の履歴メッセージ')).toBeTruthy()
    await waitFor(() => expect(document.body.style.overflow).toBe(''))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'チャット履歴を拡大表示' })))
  })

  it('背景クリックで閉じる', async () => {
    await openExpandedHistory()

    fireEvent.click(screen.getByTestId('chat-history-backdrop'))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Esc キーで閉じる', async () => {
    await openExpandedHistory()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Tab と Shift+Tab でフォーカスをダイアログ内に留める', async () => {
    await openExpandedHistory()
    const closeButton = screen.getByRole('button', { name: '拡大表示を閉じる' })
    const backgroundButton = screen.getByRole('button', { name: 'CCに依頼' })

    backgroundButton.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton)
    backgroundButton.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(closeButton)
  })

  it('最新位置で開き、直後に過去へスクロールした人を遅延処理で引き戻さない', async () => {
    await openExpandedHistory()
    fireEvent.click(screen.getByRole('button', { name: '拡大表示を閉じる' }))

    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() { return this.getAttribute('data-testid') === 'chat-message-history' ? 1000 : 0 },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() { return this.getAttribute('data-testid') === 'chat-message-history' ? 300 : 0 },
    })

    try {
      fireEvent.click(screen.getByRole('button', { name: 'チャット履歴を拡大表示' }))
      const dialog = screen.getByRole('dialog', { name: '佐藤さんのチャット履歴' })
      const history = within(dialog).getByTestId('chat-message-history') as HTMLDivElement
      expect(history.scrollTop).toBe(1000)

      history.scrollTop = 100
      fireEvent.scroll(history)
      history.scrollTop = 120
      await new Promise((resolve) => window.setTimeout(resolve, 180))
      expect(history.scrollTop).toBe(120)
    } finally {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
  })
})
