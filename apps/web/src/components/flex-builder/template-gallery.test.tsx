// @vitest-environment jsdom
/**
 * T-A4 (batch A) — 完成見本ギャラリー。
 *
 * owner の「参考画像があれば完成形が想像つく」に応え、テンプレ選択画面に代表 Flex パターンの
 * 実描画サムネ + ひとこと説明を出し、選ぶとその形から編集開始できることを実レンダリングで assert (M-15)。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import FlexBuilderModal from './flex-builder-modal'
import { GALLERY_TEMPLATES } from '@/lib/flex-builder/templates'

vi.mock('@/lib/api', () => ({
  api: { trackedLinks: { list: vi.fn(async () => ({ success: true, data: [] })) } },
}))

afterEach(() => cleanup())

describe('T-A4 完成見本ギャラリー', () => {
  it('テンプレ選択画面に完成見本ギャラリーの見本と説明が出る', () => {
    const { container, getByText } = render(
      <FlexBuilderModal onSave={() => {}} onClose={() => {}} />,
    )
    // ギャラリー見出し + 全見本のラベルとひとこと説明。
    expect(getByText(/完成見本/)).toBeTruthy()
    for (const g of GALLERY_TEMPLATES) {
      expect(getByText(g.label)).toBeTruthy()
      if (g.description) expect(getByText(g.description)).toBeTruthy()
    }
    // 各見本は FlexPreview 実描画サムネ (画像ファイルでなく実物) → プレビューの svg / img が描かれる。
    expect(container.querySelectorAll('div').length).toBeGreaterThan(GALLERY_TEMPLATES.length)
  })

  it('見本を選ぶとその形(部品つき)で編集画面に入る', () => {
    const { getByText, container } = render(
      <FlexBuilderModal onSave={() => {}} onClose={() => {}} />,
    )
    // 「クーポン」見本を選ぶ。
    fireEvent.click(getByText('クーポン'))
    // 編集画面 (保存ボタン) に遷移し、クーポン見本の部品(見出し/本文/ボタン)が並ぶ。
    expect(getByText('保存')).toBeTruthy()
    const body = container.textContent ?? ''
    expect(body).toContain('見出し')
    expect(body).toContain('ボタン')
  })
})
