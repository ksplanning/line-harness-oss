// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-pack' }) }))
vi.mock('@/components/layout/header', () => ({
  default: ({ title, action }: { title: string; action?: React.ReactNode }) => <header><h1>{title}</h1>{action}</header>,
}))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({ default: () => null }))
vi.mock('@/components/shared/test-send-dialog', () => ({
  default: ({ accountIds, source, messages, disabled }: {
    accountIds: string[]
    source: string
    messages: Array<{ type: string; content: string }>
    disabled?: boolean
  }) => (
    <button
      type="button"
      disabled={disabled}
      data-testid="pack-test-send"
      data-account-ids={accountIds.join(',')}
      data-source={source}
      data-messages={JSON.stringify(messages)}
    >
      テスト送信
    </button>
  ),
}))
vi.mock('@/lib/api', () => ({
  api: {
    templatePacks: {
      list: vi.fn(async () => ({ success: true, data: [] })),
      get: vi.fn(),
      create: vi.fn(async () => ({ success: true, data: {} })),
      update: vi.fn(async () => ({ success: true, data: {} })),
      remove: vi.fn(),
    },
  },
}))

import TemplatePacksPage from './page'

afterEach(() => cleanup())

describe('テンプレパックのテスト送信', () => {
  it('保存前の吹き出し列を選択中アカウントへ渡す', async () => {
    render(<TemplatePacksPage />)
    fireEvent.click(await screen.findByRole('button', { name: /最初のパックを作る/ }))
    fireEvent.click(screen.getByRole('button', { name: /テキスト吹き出しを追加/ }))
    fireEvent.click(screen.getByRole('button', { name: /テキスト吹き出しを追加/ }))
    const editors = screen.getAllByPlaceholderText('こんにちは！初めまして…')
    fireEvent.change(editors[0], { target: { value: 'パック1通目' } })
    fireEvent.change(editors[1], { target: { value: 'パック2通目' } })

    const button = screen.getByTestId('pack-test-send')
    expect(button.getAttribute('data-account-ids')).toBe('acc-pack')
    expect(button.getAttribute('data-source')).toBe('template_pack')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: 'パック1通目' },
      { type: 'text', content: 'パック2通目' },
    ])
  })
})
