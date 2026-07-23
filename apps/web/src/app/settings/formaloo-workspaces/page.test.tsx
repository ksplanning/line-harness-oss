// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: {
    selectedAccount: {
      id: 'account-a',
      name: 'account-a',
      displayName: 'アカウントA',
    } as { id: string; name: string; displayName: string } | null,
  },
  lineAccountsList: vi.fn(),
  workspacesList: vi.fn(),
  bindingsList: vi.fn(),
  bindingSet: vi.fn(),
  bindingClear: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => mocks.account,
}))
vi.mock('@/components/layout/header', () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}))
vi.mock('@/components/settings/formaloo-workspaces-panel', () => ({
  default: () => null,
}))
vi.mock('@/components/settings/formaloo-account-bindings-panel', () => ({
  default: ({
    accounts,
    onSet,
  }: {
    accounts: Array<{ id: string; name: string; displayName?: string }>
    onSet: (accountId: string, workspaceId: string) => void
  }) => (
    <div data-testid="formaloo-account-bindings">
      {accounts.map((account) => (
        <div key={account.id} data-testid={`formaloo-binding-${account.id}`}>
          {account.displayName || account.name}
          <button
            type="button"
            onClick={() => onSet(account.id, 'workspace-1')}
          >
            {account.id}へ割当
          </button>
        </div>
      ))}
    </div>
  ),
}))
vi.mock('@/lib/formaloo-workspaces-api', () => ({
  formalooWorkspacesApi: {
    list: (...args: unknown[]) => mocks.workspacesList(...args),
    add: vi.fn(),
    test: vi.fn(),
    setActive: vi.fn(),
    remove: vi.fn(),
  },
}))
vi.mock('@/lib/formaloo-account-bindings-api', () => ({
  formalooAccountBindingsApi: {
    list: (...args: unknown[]) => mocks.bindingsList(...args),
    set: (...args: unknown[]) => mocks.bindingSet(...args),
    clear: (...args: unknown[]) => mocks.bindingClear(...args),
  },
}))
vi.mock('@/lib/api', () => ({
  api: {
    lineAccounts: {
      list: (...args: unknown[]) => mocks.lineAccountsList(...args),
    },
  },
}))

import FormalooWorkspacesPage from './page'

beforeEach(() => {
  mocks.account.selectedAccount = {
    id: 'account-a',
    name: 'account-a',
    displayName: 'アカウントA',
  }
  mocks.lineAccountsList.mockReset().mockResolvedValue({
    success: true,
    data: [
      { id: 'account-a', name: 'account-a', displayName: 'アカウントA' },
      { id: 'account-b', name: 'account-b', displayName: 'アカウントB' },
    ],
  })
  mocks.workspacesList.mockReset().mockResolvedValue([{
    id: 'workspace-1',
    label: '本番',
    isActive: true,
  }])
  mocks.bindingsList.mockReset().mockResolvedValue([])
  mocks.bindingSet.mockReset().mockResolvedValue(undefined)
  mocks.bindingClear.mockReset().mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('Formaloo ワークスペースのアカウント準拠', () => {
  test('全アカウントを独自取得せず、左上で選択中の1件だけを表示・保存する', async () => {
    const view = render(<FormalooWorkspacesPage />)

    expect(await screen.findByTestId('formaloo-binding-account-a')).toBeTruthy()
    expect(screen.queryByTestId('formaloo-binding-account-b')).toBeNull()
    expect(mocks.lineAccountsList).not.toHaveBeenCalled()

    mocks.account.selectedAccount = {
      id: 'account-b',
      name: 'account-b',
      displayName: 'アカウントB',
    }
    view.rerender(<FormalooWorkspacesPage />)

    expect(await screen.findByTestId('formaloo-binding-account-b')).toBeTruthy()
    expect(screen.queryByTestId('formaloo-binding-account-a')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'account-bへ割当' }))
    await waitFor(() => expect(mocks.bindingSet).toHaveBeenCalledWith(
      'account-b',
      'workspace-1',
    ))
  })
})
