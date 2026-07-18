// @vitest-environment jsdom
/**
 * LP 置き場 管理ページ (harness-lp-hosting / T-E1)。
 * 一覧 (slug/title/status/閲覧数/公開 URL コピー) + 登録フォーム + ファイル upload +
 * 公開停止/再開 + 削除 が描画され、各操作が lpApi (/api/lp/*) を叩くことを固定する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'

const lpApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  setStatus: vi.fn(),
  remove: vi.fn(),
  views: vi.fn(),
  uploadFile: vi.fn(),
}))
vi.mock('@/lib/lp/api', () => ({ lpApi }))
vi.mock('@/components/layout/header', () => ({
  default: ({ title, action }: { title: string; action?: React.ReactNode }) => (
    <div><h1>{title}</h1>{action}</div>
  ),
}))

import LpPage from './page'

function seedList() {
  lpApi.list.mockResolvedValue({
    success: true,
    data: {
      items: [
        { slug: 'summer', title: '夏キャンペーン', status: 'active', entry_key: 'lp/summer/index.html', created_at: '2026-07-18', updated_at: '2026-07-18', url: 'https://w.example.com/lp/summer', views: { total: 12, friendBound: 5 } },
        { slug: 'old', title: '旧LP', status: 'stopped', entry_key: null, created_at: '2026-07-10', updated_at: '2026-07-10', url: 'https://w.example.com/lp/old', views: { total: 3, friendBound: 0 } },
      ],
    },
  })
}

beforeEach(() => {
  seedList()
  lpApi.create.mockResolvedValue({ success: true, data: {} })
  lpApi.setStatus.mockResolvedValue({ success: true, data: {} })
  lpApi.remove.mockResolvedValue({ success: true, data: null })
  lpApi.uploadFile.mockResolvedValue({ success: true, data: { key: 'lp/summer/index.html', size: 10 } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('LP 管理ページ (T-E1)', () => {
  it('一覧に slug/title/status/閲覧数/URL コピーが描画される', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    expect(screen.getByText('旧LP')).toBeTruthy()
    // 閲覧数 (総数/紐付き) が見える
    expect(screen.getByText(/12/)).toBeTruthy()
    expect(screen.getByText(/5/)).toBeTruthy()
    // URL コピーボタン
    expect(screen.getAllByRole('button', { name: /URLをコピー/ }).length).toBeGreaterThan(0)
  })

  it('登録フォームが lpApi.create を叩く', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/slug/i), { target: { value: 'newlp' } })
    fireEvent.change(screen.getByPlaceholderText(/名前|タイトル/), { target: { value: '新LP' } })
    fireEvent.click(screen.getByRole('button', { name: /登録|作成/ }))
    await waitFor(() => expect(lpApi.create).toHaveBeenCalledWith({ slug: 'newlp', title: '新LP' }))
  })

  it('公開停止/再開ボタンが lpApi.setStatus を叩く', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    // active な summer 行に「停止」ボタン
    fireEvent.click(screen.getAllByRole('button', { name: /停止する|公開停止/ })[0])
    await waitFor(() => expect(lpApi.setStatus).toHaveBeenCalledWith('summer', 'stopped'))
  })

  it('削除は確認後 lpApi.remove を叩く', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /^削除$/ })[0])
    // インライン確認 → はい
    fireEvent.click(screen.getByRole('button', { name: /はい/ }))
    await waitFor(() => expect(lpApi.remove).toHaveBeenCalledWith('summer'))
  })

  it('ファイル upload が lpApi.uploadFile を叩く', async () => {
    const { container } = render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    const file = new File(['<html></html>'], 'index.html', { type: 'text/html' })
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(lpApi.uploadFile).toHaveBeenCalled())
    expect(lpApi.uploadFile.mock.calls[0][0]).toBe('summer')
  })

  it('URL コピーボタンが clipboard.writeText を叩く', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /URLをコピー/ })[0])
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://w.example.com/lp/summer'))
  })
})

// harness-lp-hosting-uxfix: visual-qa-council Critical 2 件の回帰固定。
// ① mobile375 で登録フォームが縦積みになり「＋ LPを登録」ボタンが画面外にならない
// ② 非エンジニア owner 向けに「slug」の意味を日本語で説明する
describe('LP 管理ページ UX 修正 (harness-lp-hosting-uxfix)', () => {
  it('slug の意味を説明する日本語ヘルプが登録フォーム近くに表示される (Critical 2)', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    // 「slug＝公開URLの最後の部分」の平易な補足が存在する (placeholder の書式ヒントだけでない)
    expect(screen.getByText(/公開URLの最後の部分/)).toBeTruthy()
  })

  it('slug 入力に aria-describedby でヘルプが紐づく (a11y / Critical 2)', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    const slugInput = screen.getByPlaceholderText(/slug/i)
    const describedby = slugInput.getAttribute('aria-describedby')
    expect(describedby).toBeTruthy()
    expect(document.getElementById(describedby!)?.textContent).toMatch(/公開URLの最後の部分/)
  })

  it('登録フォームが狭幅で縦積みになり登録ボタンが到達可能 (mobile375 overflow / Critical 1)', async () => {
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('夏キャンペーン')).toBeTruthy())
    const form = screen.getByTestId('lp-create-form')
    // モバイルは縦積み (flex-col) → Header の shrink-0 action 内でも max-content が
    // viewport を超えず、＋ LPを登録ボタンが画面外(offRight)にならない。
    // 広い画面 (sm:) では従来どおり横並びに戻る (回帰なし)。
    expect(form.className).toMatch(/flex-col/)
    expect(form.className).toMatch(/sm:flex-row/)
    // 登録ボタンが同フォーム内にあり到達可能で、縦積み時は横あふれを作らない w-full
    const btn = within(form).getByRole('button', { name: /登録/ })
    expect(btn).toBeTruthy()
    expect(btn.className).toMatch(/w-full/)
    // 各入力も縦積み時に固定幅で viewport を超えない (shrink-0+固定幅 一行 overflow の再発防止)
    const slugInput = within(form).getByPlaceholderText(/slug/i)
    expect(slugInput.className).not.toMatch(/\bshrink-0\b/)
  })

  it('空状態にも slug の平易な補足がある (Critical 2)', async () => {
    lpApi.list.mockResolvedValue({ success: true, data: { items: [] } })
    render(<LpPage />)
    await waitFor(() => expect(screen.getByText('まだLPがありません')).toBeTruthy())
    expect(screen.getByText(/公開URLの末尾/)).toBeTruthy()
  })
})
