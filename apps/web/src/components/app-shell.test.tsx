// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  pathname: '/inquiry-console',
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
}))
vi.mock('./auth-guard', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="auth-guard">{children}</div>
  ),
}))
vi.mock('./layout/sidebar', () => ({
  default: () => <div data-testid="sidebar" />,
}))
vi.mock('./update/update-banner', () => ({
  UpdateBanner: () => <div data-testid="update-banner" />,
}))
vi.mock('./staff-help/staff-help-panel', () => ({
  default: () => <div data-testid="staff-help" />,
}))
vi.mock('@/contexts/account-context', () => ({
  AccountProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="account-provider">{children}</div>
  ),
}))

import AppShell from './app-shell'

afterEach(() => cleanup())

describe('AppShell の問い合わせ対応コンソール', () => {
  it('staff 認証は維持し、通常管理画面の chrome は載せない', () => {
    render(
      <AppShell>
        <div data-testid="inquiry-console">問い合わせ対応</div>
      </AppShell>,
    )

    const guard = screen.getByTestId('auth-guard')
    expect(guard.contains(screen.getByTestId('inquiry-console'))).toBe(true)
    expect(screen.queryByTestId('sidebar')).toBeNull()
    expect(screen.queryByTestId('update-banner')).toBeNull()
    expect(screen.queryByTestId('account-provider')).toBeNull()
    expect(screen.queryByTestId('staff-help')).toBeNull()
  })
})
