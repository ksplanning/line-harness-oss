// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  list: vi.fn(),
  templates: vi.fn(),
  editDraft: null as null | Record<string, unknown>,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))
vi.mock('@/components/layout/header', () => ({ default: () => <div data-testid="legacy-page-header" /> }))
vi.mock('@/components/auto-replies/edit-dialog', () => ({
  default: ({ draft }: { draft: Record<string, unknown> }) => {
    m.editDraft = draft
    return <div data-testid="auto-reply-edit-dialog" />
  },
}))
vi.mock('@/lib/api', () => ({
  api: {
    autoReplies: {
      list: (...args: unknown[]) => m.list(...args),
      delete: vi.fn(),
    },
    templates: { list: (...args: unknown[]) => m.templates(...args) },
  },
}))

import AutoRepliesPage from './page'
import { AutoReplyCenterEmbed } from '@/components/auto-reply-center/embed-context'

beforeEach(() => {
  m.editDraft = null
  m.list.mockResolvedValue({ success: true, data: [] })
  m.templates.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('/auto-replies center埋め込み', () => {
  it('例外ルール一覧の列見出しを日本語で表示する', async () => {
    render(<AutoRepliesPage />)

    expect(await screen.findByRole('columnheader', { name: 'キーワード' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '一致方法' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '返信内容' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'テンプレート' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '未対応リスト' })).toBeTruthy()
  })

  it('例外ルールの凡例と返信種別を日常語で表示する', async () => {
    m.list.mockResolvedValue({ success: true, data: [
      {
        id: 'rule-text',
        keyword: '資料',
        matchType: 'contains',
        responseType: 'text',
        responseContent: '資料を送ります',
        responseMessages: null,
        templateId: null,
        lineAccountId: 'acc-1',
        keepInUnresponded: true,
        isActive: true,
        createdAt: '2026-07-21T00:00:00.000Z',
        effectiveAccounts: [{ accountId: 'acc-1', accountName: '本店', status: 'reply', via: 'inline' }],
      },
      {
        id: 'rule-flex',
        keyword: '予約',
        matchType: 'exact',
        responseType: 'flex',
        responseContent: '{}',
        responseMessages: null,
        templateId: null,
        lineAccountId: 'acc-1',
        keepInUnresponded: false,
        isActive: true,
        createdAt: '2026-07-21T00:00:00.000Z',
        effectiveAccounts: [{ accountId: 'acc-1', accountName: '本店', status: 'reply', via: 'automation' }],
      },
      {
        id: 'rule-silent',
        keyword: '休業',
        matchType: 'exact',
        responseType: 'silent',
        responseContent: '',
        responseMessages: null,
        templateId: null,
        lineAccountId: 'acc-1',
        keepInUnresponded: false,
        isActive: true,
        createdAt: '2026-07-21T00:00:00.000Z',
        effectiveAccounts: [{ accountId: 'acc-1', accountName: '本店', status: 'silent', via: null }],
      },
    ] })

    render(<AutoRepliesPage />)

    expect(await screen.findByText(/テキスト$/)).toBeTruthy()
    expect(screen.getByText(/カード（Flex）/)).toBeTruthy()
    expect(screen.getAllByText('返信なし（silent）').length).toBeGreaterThan(0)
    expect(screen.getByText(/直接設定/)).toBeTruthy()
    expect(screen.getByText(/自動処理（オートメーション）/)).toBeTruthy()
    expect(screen.getByText('部分一致')).toBeTruthy()
    expect(screen.getByText('残す')).toBeTruthy()
    expect(screen.getAllByText('残さない')).toHaveLength(2)
  })

  it('旧page headerは重ねず「新規ルール」操作は残す', async () => {
    render(
      <AutoReplyCenterEmbed hideHeader>
        <AutoRepliesPage />
      </AutoReplyCenterEmbed>,
    )

    await waitFor(() => expect(screen.getByText('自動返信ルールがありません')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '+ 新規ルール' }))
    expect(screen.getByTestId('auto-reply-edit-dialog')).toBeTruthy()
    expect(screen.queryByTestId('legacy-page-header')).toBeNull()
  })

  it('一覧APIの複数吹き出しを欠落させず編集画面へ渡す', async () => {
    const responseMessages = [
      { messageType: 'text', messageContent: 'A' },
      { messageType: 'flex', messageContent: '{"type":"bubble"}' },
      { messageType: 'text', messageContent: 'B' },
    ]
    m.list.mockResolvedValue({ success: true, data: [{
      id: 'rule-1',
      keyword: '資料',
      matchType: 'exact',
      responseType: 'text',
      responseContent: 'A',
      responseMessages,
      templateId: null,
      lineAccountId: 'acc-1',
      keepInUnresponded: true,
      isActive: true,
      createdAt: '2026-07-21T00:00:00.000Z',
      effectiveAccounts: [],
    }] })

    render(<AutoRepliesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '編集' }))

    expect(m.editDraft?.responseMessages).toEqual(responseMessages)
    expect(m.editDraft?.keepInUnresponded).toBe(true)
  })
})
