// @vitest-environment jsdom
/**
 * T-A4 (H-1) — シナリオ設定の分岐条件 (トリガー) に scenario.condition ヘルプが置かれ、
 * 編集モードで開くと該当ガイド画像が出る。重い子/依存は stub 化して配置のみを検証する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const scenario = {
  id: 's1', name: 'テスト', description: '', triggerType: 'tag_added', isActive: true,
  createdAt: '2026-07-07T00:00:00.000', updatedAt: '2026-07-07T00:00:00.000', steps: [],
}

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({ default: () => null }))
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({
  api: {
    scenarios: {
      get: vi.fn(async () => ({ success: true, data: scenario })),
      stats: vi.fn(async () => ({ success: true, data: null })),
    },
    templates: { list: vi.fn(async () => ({ success: true, data: [] })) },
    tags: { list: vi.fn(async () => ({ success: true, data: [] })) },
  },
}))

import ScenarioDetailClient from './scenario-detail-client'

afterEach(() => cleanup())

describe('T-A4 シナリオ分岐条件ヘルプ', () => {
  it('編集モードのトリガーに scenario.condition ヘルプが置かれ、押すと画像が開く', async () => {
    render(<ScenarioDetailClient scenarioId="s1" />)
    // 読み込み後、編集ボタンが出る
    const editBtn = await screen.findByRole('button', { name: '編集' })
    fireEvent.click(editBtn)
    // トリガー行のヘルプを開く
    const help = await screen.findByRole('button', { name: /ヘルプ/ })
    fireEvent.click(help)
    await waitFor(() => {
      const img = screen.getByRole('dialog').querySelector('img') as HTMLImageElement
      expect(img.getAttribute('src')).toBe('/help/scenario-condition.webp')
    })
  })
})
