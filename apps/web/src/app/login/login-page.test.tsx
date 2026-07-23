// @vitest-environment jsdom
/**
 * T-F6 (batch F) — ログイン画面が ID + パスワード方式で動くことを実レンダリングで assert (M-15)。
 *   - 「ログインID」「パスワード」の2欄 (専門語ゼロ)
 *   - パスワード表示トグル (目アイコン) で type が切り替わる
 *   - 送信で {loginId, password} が /api/auth/login に POST される
 *   - 「APIキーでログイン（従来の方法）」は折りたたみで残る (並行期間) → {apiKey} を POST
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))

import LoginPage from './page'

const fetchMock = vi.fn()

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  pushMock.mockReset()
  fetchMock.mockReset()
  window.history.replaceState(null, '', '/login')
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: { name: 'Owner', role: 'owner' }, csrfToken: 'csrf-1' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('T-F6 login page: ID/PASS', () => {
  async function submitPasswordLogin() {
    render(<LoginPage />)
    fireEvent.change(screen.getByPlaceholderText('ログインIDを入力'), { target: { value: 'owner_ks' } })
    fireEvent.change(screen.getByPlaceholderText('パスワードを入力'), { target: { value: 'MyPassword1' } })
    fireEvent.click(screen.getByRole('button', { name: /ログイン$/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  }

  it('ログインID + パスワードの2欄が日本語ラベルで出る', () => {
    render(<LoginPage />)
    expect(screen.getByText('ログインID')).toBeTruthy()
    expect(screen.getByText('パスワード')).toBeTruthy()
    // 旧 "API Key" ラベルは主フォームから消えている (折りたたみ内のみ)。
    expect(screen.queryByPlaceholderText('APIキーを入力')).toBeNull()
  })

  it('パスワード表示トグルで input type が password ↔ text に切り替わる', () => {
    render(<LoginPage />)
    const pw = screen.getByPlaceholderText('パスワードを入力') as HTMLInputElement
    expect(pw.type).toBe('password')
    fireEvent.click(screen.getByLabelText('パスワードを表示'))
    expect(pw.type).toBe('text')
    fireEvent.click(screen.getByLabelText('パスワードを隠す'))
    expect(pw.type).toBe('password')
  })

  it('送信で {loginId, password} が login endpoint に POST される', async () => {
    await submitPasswordLogin()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/auth/login')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body).toMatchObject({ loginId: 'owner_ks', password: 'MyPassword1' })
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'))
  })

  it('安全な同一サイト内 returnTo があればログイン後に問い合わせ画面へ戻る', async () => {
    window.history.replaceState(
      null,
      '',
      '/login?returnTo=%2Finquiry-console%3Ffriend%3Dfriend-1',
    )

    await submitPasswordLogin()

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/inquiry-console?friend=friend-1')
    })
  })

  it.each([
    'https://evil.example/inquiry-console?friend=friend-1',
    '//evil.example/inquiry-console?friend=friend-1',
  ])('外部へ出る returnTo (%s) は拒否してトップへ戻る', async (returnTo) => {
    window.history.replaceState(
      null,
      '',
      `/login?returnTo=${encodeURIComponent(returnTo)}`,
    )

    await submitPasswordLogin()

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'))
    expect(pushMock).not.toHaveBeenCalledWith(returnTo)
  })

  it('APIキーログインは折りたたみで残り {apiKey} を POST する (並行期間)', async () => {
    render(<LoginPage />)
    // 折りたたみを開く。
    fireEvent.click(screen.getByText(/APIキーでログイン（従来の方法）/))
    fireEvent.change(screen.getByPlaceholderText('APIキーを入力'), { target: { value: 'lh_abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'APIキーでログイン' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ apiKey: 'lh_abc' })
  })

  it('401 は汎用文言を出す (列挙攻撃を助けない)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ success: false }) })
    render(<LoginPage />)
    fireEvent.change(screen.getByPlaceholderText('ログインIDを入力'), { target: { value: 'x' } })
    fireEvent.change(screen.getByPlaceholderText('パスワードを入力'), { target: { value: 'y1234567' } })
    fireEvent.click(screen.getByRole('button', { name: /ログイン$/ }))
    await waitFor(() => expect(screen.getByText('ログインIDまたはパスワードが正しくありません')).toBeTruthy())
  })
})
