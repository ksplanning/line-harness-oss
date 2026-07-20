// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  listTags: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    tags: {
      list: (...args: unknown[]) => mocks.listTags(...args),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import TagsPage from './page'

beforeEach(() => {
  mocks.listTags.mockReset().mockResolvedValue({ success: true, data: [] })
})

afterEach(() => cleanup())

describe('TagsPage — 全員共通カスタムフィールドへの導線', () => {
  test('タグ設定から友だちリスト上部の設定パネルへ移動できる', async () => {
    render(<TagsPage />)
    await waitFor(() => expect(screen.getByText('まだタグがありません')).toBeTruthy())

    const link = screen.getByRole('link', { name: /全員共通のカスタムフィールドはこちら/ })
    expect(link.getAttribute('href')).toBe('/friends#friend-custom-fields')
  })
})
