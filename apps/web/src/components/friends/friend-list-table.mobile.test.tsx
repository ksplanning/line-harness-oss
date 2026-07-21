// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { FriendListItem } from '@/lib/api'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/api', () => ({
  api: { friends: { addTag: vi.fn(), removeTag: vi.fn() } },
}))
vi.mock('./custom-metadata-editor', () => ({ default: () => null }))

import FriendListTable from './friend-list-table'

afterEach(() => cleanup())

const friend: FriendListItem = {
  id: 'friend-stopped',
  lineUserId: 'U-stopped',
  displayName: '停止確認さん',
  pictureUrl: null,
  statusMessage: null,
  isFollowing: true,
  createdAt: '2026-07-22T10:00:00.000+09:00',
  updatedAt: '2026-07-22T10:00:00.000+09:00',
  tags: [],
}

describe('FriendListTable 390px layout', () => {
  test('「停止中」をモバイル2列内へ折り返し、PCでは従来の5列を保つ', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    render(<FriendListTable friends={[friend]} allTags={[]} onRefresh={vi.fn()} />)

    const stopped = screen.getByText('停止中')
    const row = stopped.closest('[role="link"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.classList.contains('grid-cols-[80px_minmax(0,1fr)]')).toBe(true)
    expect(row.classList.contains('lg:grid-cols-[80px_220px_120px_1fr_280px]')).toBe(true)

    const scrollBody = row.parentElement?.parentElement as HTMLElement
    expect(scrollBody.classList.contains('min-w-[900px]')).toBe(false)
    expect(scrollBody.classList.contains('lg:min-w-[900px]')).toBe(true)

    const details = row.lastElementChild as HTMLElement
    expect(details.classList.contains('col-span-2')).toBe(true)
    expect(details.classList.contains('lg:col-span-1')).toBe(true)
  })
})
