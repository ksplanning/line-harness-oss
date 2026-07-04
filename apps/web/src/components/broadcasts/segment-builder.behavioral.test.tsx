// @vitest-environment jsdom
/**
 * T-C8 (F2 batch4 G11) — segment-builder の行動 rule UI を実レンダリングで検証。
 *  - 「リンクをクリックした人 / メニューをタップした人 / フォームを開いた人」が選べる
 *  - 「メッセージを開封した人」は出さない (LINE 非提供) / フォーム開封で代替する amber 注記
 *  - tapped_menu は対象メニュー選択 + 期間、行動 rule は payload に新 type + sinceDays が入る (送信しない)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { countMock, linksMock, menusMock } = vi.hoisted(() => ({
  countMock: vi.fn(),
  linksMock: vi.fn(),
  menusMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    segments: { count: (...a: unknown[]) => countMock(...a) },
    trackedLinks: { list: (...a: unknown[]) => linksMock(...a) },
    richMenuGroups: { list: (...a: unknown[]) => menusMock(...a) },
  },
}))

import SegmentBuilder from './segment-builder'

beforeEach(() => {
  countMock.mockResolvedValue({ success: true, count: 3 })
  linksMock.mockResolvedValue({ success: true, data: [{ id: 'tl-1', name: '春リンク' }] })
  menusMock.mockResolvedValue({ success: true, data: [{ id: 'g-1', name: '春メニュー' }] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

function setup(onApply = vi.fn()) {
  render(<SegmentBuilder tags={[]} accountId="acc-1" onApply={onApply} onCancel={vi.fn()} />)
  return onApply
}

describe('segment-builder behavioral rules (G11)', () => {
  it('offers the 3 behavioral rule labels and NOT "メッセージを開封した人"', () => {
    setup()
    const select = screen.getAllByRole('combobox')[1]
    const optionText = Array.from(select.querySelectorAll('option')).map(o => o.textContent)
    expect(optionText).toContain('リンクをクリックした人')
    expect(optionText).toContain('メニューをタップした人')
    expect(optionText).toContain('フォームを開いた人')
    expect(optionText).not.toContain('メッセージを開封した人')
  })

  it('shows the amber note + menu selector + period when tapped_menu is chosen', async () => {
    setup()
    const typeSelect = screen.getAllByRole('combobox')[1]
    fireEvent.change(typeSelect, { target: { value: 'tapped_menu' } })
    // amber 注記
    expect(screen.getByText(/フォームを開いた人.*で代替/)).toBeTruthy()
    // 対象メニュー選択が出る (fetch 済みの菜单)
    await waitFor(() => expect(screen.getByText('春メニュー')).toBeTruthy())
    // 期間入力 (過去◯日)
    expect(screen.getByText(/過去/)).toBeTruthy()
  })

  it('applies clicked_link with sinceDays in the payload (does not send)', () => {
    const onApply = setup()
    const typeSelect = screen.getAllByRole('combobox')[1]
    fireEvent.change(typeSelect, { target: { value: 'clicked_link' } })
    fireEvent.click(screen.getByText('適用'))
    expect(onApply).toHaveBeenCalledTimes(1)
    const arg = onApply.mock.calls[0][0] as { rules: Array<{ type: string; value: { sinceDays: number } }> }
    const rule = arg.rules.find(r => r.type === 'clicked_link')!
    expect(rule).toBeTruthy()
    expect(rule.value.sinceDays).toBe(30)
  })
})
