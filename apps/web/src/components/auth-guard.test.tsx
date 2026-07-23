// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  pathname: '/inquiry-console',
  router: {
    replace: vi.fn(),
  },
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => mocks.router,
}))

import AuthGuard from './auth-guard'

const fetchMock = vi.fn()

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  mocks.pathname = '/inquiry-console'
  mocks.router.replace.mockReset()
  fetchMock.mockReset()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/inquiry-console?friend=friend-1')
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AuthGuard の通知 deep link セッション往復', () => {
  it('未ログインなら問い合わせ URL 全体を returnTo に保持してログインへ送る', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ success: false }),
    })

    render(
      <AuthGuard>
        <div>問い合わせ対応</div>
      </AuthGuard>,
    )

    await waitFor(() => {
      expect(mocks.router.replace).toHaveBeenCalledWith(
        '/login?returnTo=%2Finquiry-console%3Ffriend%3Dfriend-1',
      )
    })
    expect(screen.queryByText('問い合わせ対応')).toBeNull()
  })

  it('有効な staff セッションなら通知先の子画面をそのまま描画する', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { id: 'staff-1', name: '山田', role: 'staff' },
        csrfToken: 'csrf-1',
      }),
    })

    render(
      <AuthGuard>
        <div>問い合わせ対応</div>
      </AuthGuard>,
    )

    expect(await screen.findByText('問い合わせ対応')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/auth/session',
      { credentials: 'include' },
    )
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })
})
