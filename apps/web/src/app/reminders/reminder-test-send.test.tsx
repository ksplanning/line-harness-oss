// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const reminder = {
  id: 'rem-1',
  name: '来店リマインダー',
  description: null,
  isActive: true,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
}

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-reminder' }) }))
vi.mock('@/components/layout/header', () => ({ default: ({ title }: { title: string }) => <h1>{title}</h1> }))
vi.mock('@/components/cc-prompt-button', () => ({ default: () => null }))
vi.mock('@/components/reminders/enroll-dialog', () => ({ default: () => null }))
vi.mock('@/components/shared/test-send-dialog', () => ({
  default: ({ accountIds, source, messages }: {
    accountIds: string[]
    source: string
    messages: Array<{ type: string; content: string }>
  }) => (
    <button
      type="button"
      data-testid="reminder-test-send"
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
    reminders: {
      list: vi.fn(async () => ({ success: true, data: [reminder] })),
      get: vi.fn(async () => ({
        success: true,
        data: {
          ...reminder,
          steps: [{
            id: 'step-1', reminderId: 'rem-1', offsetMinutes: -60,
            messageType: 'text', messageContent: '明日お待ちしています',
            createdAt: '2026-07-20T00:00:00.000Z',
          }],
        },
      })),
    },
  },
}))

import RemindersPage from './page'

afterEach(() => cleanup())

describe('リマインダーステップのテスト送信', () => {
  it('保存済みの特定ステップを選択中アカウントへ渡す', async () => {
    render(<RemindersPage />)
    fireEvent.click(await screen.findByText('来店リマインダー'))

    const button = await screen.findByTestId('reminder-test-send')
    expect(button.getAttribute('data-account-ids')).toBe('acc-reminder')
    expect(button.getAttribute('data-source')).toBe('reminder')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: '明日お待ちしています' },
    ])
  })
})
