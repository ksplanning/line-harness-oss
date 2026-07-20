// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: { pools: { accounts: { list: vi.fn(async () => ({ success: true, data: [] })) } } },
}))
vi.mock('@/components/shared/test-send-dialog', () => ({
  default: ({ accountIds, source, messages }: {
    accountIds: string[]
    source: string
    messages: Array<{ type: string; content: string }>
  }) => (
    <button
      type="button"
      data-testid="entry-welcome-test-send"
      data-account-ids={accountIds.join(',')}
      data-source={source}
      data-messages={JSON.stringify(messages)}
    >
      即時 push をテスト送信
    </button>
  ),
}))

import EditRouteModal from './edit-route-modal'

afterEach(() => cleanup())

describe('流入リンクの友だち追加 welcome テスト送信', () => {
  it('選択した intro template の内容を選択中LINEアカウントへ渡す', () => {
    render(
      <EditRouteModal
        route={null}
        pools={[]}
        scenarios={[]}
        templates={[{ id: 'tpl-1', name: 'ウェルカム', messageType: 'text', messageContent: '登録ありがとう' }]}
        tags={[]}
        accountId="acc-entry"
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    )

    const introSelect = screen.getByRole('option', { name: 'ウェルカム' }).parentElement as HTMLSelectElement
    fireEvent.change(introSelect, { target: { value: 'tpl-1' } })

    const button = screen.getByTestId('entry-welcome-test-send')
    expect(button.getAttribute('data-account-ids')).toBe('acc-entry')
    expect(button.getAttribute('data-source')).toBe('entry_greeting')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: '登録ありがとう' },
    ])
  })
})
