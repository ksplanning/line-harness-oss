// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

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
      data-account-ids={accountIds.join(',')}
      data-source={source}
      data-messages={JSON.stringify(messages)}
    >
      テスト送信する
    </button>
  ),
}))

import TestSendSection from './test-send-section'

afterEach(() => cleanup())

describe('TestSendSection', () => {
  it('単発配信を共通テスト送信モーダルへ渡す', () => {
    render(
      <TestSendSection
        broadcastId="b1"
        accountIds={['acc-1']}
        disabled={false}
        messages={[{ type: 'text', content: '一通目' }]}
      />,
    )

    const button = screen.getByRole('button', { name: 'テスト送信する' })
    expect(button.getAttribute('data-account-ids')).toBe('acc-1')
    expect(button.getAttribute('data-source')).toBe('broadcast')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: '一通目' },
    ])
  })

  it('組み合わせ配信も全メッセージを順番どおり渡し、利用不可案内に戻さない', () => {
    const messages = [
      { type: 'text', content: '一通目' },
      { type: 'image', content: '{"originalContentUrl":"https://img.example/a.png"}' },
    ]
    render(
      <TestSendSection
        broadcastId="b1"
        accountIds={['acc-1', 'acc-2']}
        disabled={false}
        messages={messages}
      />,
    )

    const button = screen.getByRole('button', { name: 'テスト送信する' })
    expect(button.getAttribute('data-account-ids')).toBe('acc-1,acc-2')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual(messages)
    expect(screen.queryByText(/今後対応/)).toBeNull()
  })
})
