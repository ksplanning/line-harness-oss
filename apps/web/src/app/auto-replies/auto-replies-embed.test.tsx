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
      isActive: true,
      createdAt: '2026-07-21T00:00:00.000Z',
      effectiveAccounts: [],
    }] })

    render(<AutoRepliesPage />)
    fireEvent.click(await screen.findByRole('button', { name: '編集' }))

    expect(m.editDraft?.responseMessages).toEqual(responseMessages)
  })
})
