// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type PendingList = {
  accountId: string | undefined
  resolve: (value: unknown) => void
}

const m = vi.hoisted(() => ({
  account: { selectedAccountId: 'account-a' },
  pending: [] as PendingList[],
  list: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: m.account.selectedAccountId }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    friends: { list: (...args: unknown[]) => m.list(...args) },
    tags: { list: vi.fn(async () => ({ success: true, data: [] })) },
    friendFieldDefinitions: { list: vi.fn(async () => ({ success: true, data: [] })) },
  },
  downloadCsv: vi.fn(),
}))
vi.mock('@/components/layout/header', () => ({ default: () => <h1>友だちリスト</h1> }))
vi.mock('@/components/friends/friend-list-table', () => ({
  default: ({ friends }: { friends: Array<{ displayName: string }> }) => (
    <div data-testid="friend-list">{friends.map((friend) => <p key={friend.displayName}>{friend.displayName}</p>)}</div>
  ),
}))
vi.mock('@/components/friends/saved-search-panel', () => ({ default: () => null }))
vi.mock('@/components/shared/export-csv-button', () => ({ default: () => null }))
vi.mock('@/components/cc-prompt-button', () => ({ default: () => null }))
vi.mock('@/components/friends/friend-field-definitions-panel', () => ({
  default: () => <div data-testid="friend-field-definitions-panel" />,
}))
vi.mock('@/components/friends/followers-import-panel', () => ({
  default: ({ onCompleted }: { onCompleted: () => void | Promise<void> }) => (
    <div data-testid="followers-import-panel">
      <button type="button" onClick={() => { void onCompleted() }}>import-complete</button>
    </div>
  ),
}))

import FriendsPage from './page'

function response(name: string) {
  return {
    success: true,
    data: {
      items: [{ displayName: name }],
      total: 1,
      hasNextPage: false,
    },
  }
}

beforeEach(() => {
  m.account.selectedAccountId = 'account-a'
  m.pending.length = 0
  m.list.mockReset().mockImplementation((params: { accountId?: string }) => new Promise((resolve) => {
    m.pending.push({ accountId: params.accountId, resolve })
  }))
})

afterEach(() => cleanup())

describe('FriendsPage follower-import completion reload', () => {
  test('ignores a late completion reload from the previously selected account', async () => {
    const view = render(<FriendsPage />)
    await waitFor(() => expect(m.pending).toHaveLength(1))
    await act(async () => { m.pending[0].resolve(response('A initial')) })
    expect(await screen.findByText('A initial')).toBeTruthy()

    fireEvent.click(screen.getByText('取り込み設定'))
    fireEvent.click(screen.getByRole('button', { name: 'import-complete' }))
    await waitFor(() => expect(m.pending).toHaveLength(2))

    m.account.selectedAccountId = 'account-b'
    view.rerender(<FriendsPage />)
    await waitFor(() => expect(m.pending).toHaveLength(3))
    expect(m.pending[2].accountId).toBe('account-b')
    await act(async () => { m.pending[2].resolve(response('B current')) })
    expect(await screen.findByText('B current')).toBeTruthy()

    await act(async () => { m.pending[1].resolve(response('A late')) })
    expect(screen.queryByText('A late')).toBeNull()
    expect(screen.getByText('B current')).toBeTruthy()
  })
})

describe('FriendsPage first-view layout', () => {
  test('友だち一覧を先に見せ、取り込みとカスタムフィールド設定は初期状態で閉じる', async () => {
    render(<FriendsPage />)
    await waitFor(() => expect(m.pending).toHaveLength(1))
    await act(async () => { m.pending[0].resolve(response('一覧の先頭')) })

    const friendList = await screen.findByTestId('friend-list')
    const importPanel = screen.getByTestId('followers-import-panel')
    const fieldPanel = screen.getByTestId('friend-field-definitions-panel')
    const importDetails = screen.getByText('取り込み設定').closest('details') as HTMLDetailsElement | null
    const fieldDetails = screen.getByText('カスタムフィールド設定').closest('details') as HTMLDetailsElement | null

    expect(importDetails?.open).toBe(false)
    expect(fieldDetails?.open).toBe(false)
    expect(friendList.compareDocumentPosition(importPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(friendList.compareDocumentPosition(fieldPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
