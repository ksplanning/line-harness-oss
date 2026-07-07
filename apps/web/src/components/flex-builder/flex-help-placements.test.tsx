// @vitest-environment jsdom
/**
 * T-A4 (H-1) — Flex builder の画像ヘルプ配置。パーツ選択 (flex.parts) とリンク設定 (flex.link)
 * の各設定に HelpPopover が置かれ、押すと該当ガイド画像が開く。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/lib/api', () => ({ api: { trackedLinks: { list: vi.fn(async () => ({ success: true, data: [] })) } } }))

import PartPalette from './part-palette'
import LinkPicker from './link-picker'
import type { LinkSpec } from '@/lib/flex-builder/types'

afterEach(() => cleanup())

describe('T-A4 Flex builder ヘルプ配置', () => {
  it('パーツ選択に flex.parts ヘルプが置かれ、押すと画像が開く', () => {
    render(<PartPalette onAdd={vi.fn()} />)
    const help = screen.getByRole('button', { name: /ヘルプ/ })
    fireEvent.click(help)
    const img = screen.getByRole('dialog').querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/help/flex-parts.webp')
  })

  it('リンク設定に flex.link ヘルプが置かれ、押すと画像が開く', () => {
    render(<LinkPicker value={{ type: 'url', uri: '' } as LinkSpec} onChange={vi.fn()} />)
    const help = screen.getByRole('button', { name: /ヘルプ/ })
    fireEvent.click(help)
    const img = screen.getByRole('dialog').querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/help/flex-link.webp')
  })
})
