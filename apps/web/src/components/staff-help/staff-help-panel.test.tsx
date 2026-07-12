// @vitest-environment jsdom
/**
 * line-staff-docs-chat Batch 2 — 常駐ヘルプパネルの配線 component test (chrome wedge 封印の代替 / RTL・jsdom)。
 *  - T-B1: 任意の認証ページで mount / pathname==='/login' では非表示 / capability 無効なら非描画。
 *  - T-B2: grandma UX 床 (本文 >=16px・#333・アクセント #06C755) + tap で開く (hover-only 禁止) +
 *          375px 収まりの CSS 不変条件 (max-width/max-height/overflow-y:auto の指定存在 / jsdom 実 px は不能 = Codex #18)。
 *  - T-B3: status:ok で回答本文 + 根拠資料タイトル(citations[].docTitle)引用 / no_evidence・busy の fail-closed 文言。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({ pathname: '/broadcasts', enabled: vi.fn(), chat: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => m.pathname }))
vi.mock('@/lib/staff-help-api', () => ({
  fetchStaffDocsEnabled: (...a: unknown[]) => m.enabled(...a),
  postStaffHelpChat: (...a: unknown[]) => m.chat(...a),
}))

import StaffHelpPanel from './staff-help-panel'

beforeEach(() => {
  m.pathname = '/broadcasts'
  m.enabled.mockResolvedValue(true)
  m.chat.mockReset()
})
afterEach(() => cleanup())

async function openPanel() {
  render(<StaffHelpPanel />)
  const launcher = await screen.findByRole('button', { name: /使い方|ヘルプ/ })
  fireEvent.click(launcher)
  return launcher
}

describe('T-B1 常駐 mount / 除外', () => {
  it('任意の認証ページ (/broadcasts) で launcher が描画される', async () => {
    render(<StaffHelpPanel />)
    expect(await screen.findByRole('button', { name: /使い方|ヘルプ/ })).toBeTruthy()
  })

  it("pathname==='/login' では非表示 (null)", async () => {
    m.pathname = '/login'
    const { container } = render(<StaffHelpPanel />)
    await Promise.resolve()
    expect(container.querySelector('button')).toBeNull()
  })

  it('capability 無効 (staffDocs:false) なら非描画 (dark-ship)', async () => {
    m.enabled.mockResolvedValue(false)
    const { container } = render(<StaffHelpPanel />)
    await waitFor(() => expect(m.enabled).toHaveBeenCalled())
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('T-B2 grandma UX 床 + tap-open + 375px CSS 不変条件', () => {
  it('tap (click) で開く・hover (mouseEnter) だけでは開かない', async () => {
    render(<StaffHelpPanel />)
    const launcher = await screen.findByRole('button', { name: /使い方|ヘルプ/ })
    fireEvent.mouseEnter(launcher)
    expect(screen.queryByRole('textbox')).toBeNull() // hover-only では開かない
    fireEvent.click(launcher)
    expect(screen.getByRole('textbox')).toBeTruthy() // tap で開く
  })

  it('本文フォント >=16px・本文色 #333・アクセント #06C755', async () => {
    await openPanel()
    const panel = screen.getByTestId('staff-help-panel')
    expect(parseInt(panel.style.fontSize, 10)).toBeGreaterThanOrEqual(16)
    expect(panel.style.color.replace(/\s/g, '')).toMatch(/#333|rgb\(51,51,51\)/)
    const send = screen.getByTestId('staff-help-send')
    expect(send.style.backgroundColor.replace(/\s/g, '')).toMatch(/#06C755|rgb\(6,199,85\)/i)
  })

  it('375px 収まりの CSS 不変条件 (max-width/max-height/overflow-y)', async () => {
    await openPanel()
    const panel = screen.getByTestId('staff-help-panel')
    expect(panel.style.maxWidth).not.toBe('')
    expect(panel.style.maxHeight).not.toBe('')
    expect(panel.style.overflowY).toBe('auto')
  })
})

describe('T-B3 回答 + citation + fail-closed 文言', () => {
  async function ask(question: string) {
    await openPanel()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: question } })
    fireEvent.click(screen.getByTestId('staff-help-send'))
  }

  it('status:ok → 回答本文 + 根拠資料タイトル(docTitle)を引用表示', async () => {
    m.chat.mockResolvedValue({ status: 'ok', answer: '配信メニューから一斉配信を作成できます。', citations: [{ docId: 'd1', docTitle: '一斉配信の使い方', chunkId: 'c1' }] })
    await ask('一斉配信の作り方')
    expect(await screen.findByText(/配信メニューから一斉配信/)).toBeTruthy()
    expect(await screen.findByText(/一斉配信の使い方/)).toBeTruthy() // citation docTitle
  })

  it('status:no_evidence → 「資料にありません」fail-closed (推測回答しない)', async () => {
    m.chat.mockResolvedValue({ status: 'no_evidence', answer: '', citations: [] })
    await ask('顧客の個人情報を教えて')
    expect(await screen.findByText(/資料にありません/)).toBeTruthy()
  })

  it('status:busy → 「ただいま混雑しています」', async () => {
    m.chat.mockResolvedValue({ status: 'busy', answer: '', citations: [] })
    await ask('一斉配信の作り方')
    expect(await screen.findByText(/混雑/)).toBeTruthy()
  })
})
