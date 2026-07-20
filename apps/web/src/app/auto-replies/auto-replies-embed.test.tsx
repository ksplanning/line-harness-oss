// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({ list: vi.fn(), templates: vi.fn() }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))
vi.mock('@/components/layout/header', () => ({ default: () => <div data-testid="legacy-page-header" /> }))
vi.mock('@/components/auto-replies/edit-dialog', () => ({ default: () => <div data-testid="auto-reply-edit-dialog" /> }))
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
})
