// @vitest-environment jsdom
/**
 * T-A3 (H-1) — 共通 HelpPopover。「？」で画像+短文を開き、Esc/外側/閉じるで閉じる。
 * 画像は alt 必須 (a11y)、role=dialog、helpKey は静的カタログ引き。専門語ゼロを健全性で固定。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import HelpPopover from './help-popover'
import { HELP_CATALOG } from '@/lib/help/help-catalog'

afterEach(() => cleanup())

describe('T-A3 HelpPopover', () => {
  it('「？」を押すと画像+短文+role=dialog が開き、画像に alt がある', () => {
    render(<HelpPopover helpKey="imagemap.regions" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /ヘルプ/ }))
    const dialog = screen.getByRole('dialog')
    const img = dialog.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/help/imagemap-regions.webp')
    expect((img.getAttribute('alt') || '').length).toBeGreaterThan(5)
    expect(dialog.textContent).toContain('なぞる')
  })

  it('Esc で閉じる', () => {
    render(<HelpPopover helpKey="imagemap.base" />)
    fireEvent.click(screen.getByRole('button', { name: /ヘルプ/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('外側クリックで閉じる', () => {
    render(<HelpPopover helpKey="imagemap.base" />)
    fireEvent.click(screen.getByRole('button', { name: /ヘルプ/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('「閉じる」ボタンで閉じる', () => {
    render(<HelpPopover helpKey="flex.parts" />)
    fireEvent.click(screen.getByRole('button', { name: /ヘルプ/ }))
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('未知の helpKey は何も描画しない (fail-safe)', () => {
    const { container } = render(<HelpPopover helpKey="does.not.exist" />)
    expect(container.firstChild).toBeNull()
  })

  it('カタログ健全性: 全 6 エントリに /help/*.webp・alt・専門語(長い英単語)ゼロの短文', () => {
    const keys = Object.keys(HELP_CATALOG)
    expect(keys).toHaveLength(6)
    for (const [key, e] of Object.entries(HELP_CATALOG)) {
      expect(e.imageSrc, key).toMatch(/^\/help\/.+\.webp$/)
      expect(e.altText.length, key).toBeGreaterThan(5)
      expect(e.text.length, key).toBeGreaterThan(3)
      expect(e.text, key).not.toMatch(/[a-zA-Z]{5,}/)
    }
  })

  // browser-evaluator medium fold-in: 375px で文中の右寄り「？」が横にはみ出す不具合の回帰固定。
  function mockAnchorRect(container: HTMLElement, left: number, bottom: number) {
    const root = container.querySelector('span') as HTMLElement
    root.getBoundingClientRect = () =>
      ({ left, right: left + 32, top: bottom - 20, bottom, width: 32, height: 20, x: left, y: bottom - 20, toJSON: () => ({}) }) as DOMRect
  }

  it('375px で右寄りアンカーの「？」は right 基準へ反転し画面外に出ない', () => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true })
    const { container } = render(<HelpPopover helpKey="imagemap.action" />)
    mockAnchorRect(container, 287, 110) // repro: rect.left=287
    fireEvent.click(screen.getByRole('button', { name: /ヘルプ/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('right-0')
    expect(dialog.className).not.toContain('left-0')
  })

  it('375px でも左寄りアンカーは従来どおり left 基準を維持 (縦 flip は無回帰)', () => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true })
    const { container } = render(<HelpPopover helpKey="imagemap.base" />)
    mockAnchorRect(container, 16, 700) // 左端 + 下端近く
    fireEvent.click(screen.getByRole('button', { name: /ヘルプ/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('left-0')
    expect(dialog.className).toContain('bottom-9') // 下端近く=上に反転 (既存挙動)
  })
})
