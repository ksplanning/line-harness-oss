// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { FriendListItem } from '@/lib/api'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('./tag-badge', () => ({ default: () => <span>タグ</span> }))

import FriendListRow from './friend-list-row'

afterEach(() => cleanup())

function friend(displayName: null | string, pictureUrl: string | null = null): FriendListItem {
  return {
    id: 'friend-1',
    lineUserId: 'U1',
    displayName: displayName as unknown as string,
    pictureUrl,
    statusMessage: null,
    isFollowing: true,
    createdAt: '2026-07-21T10:00:00.000+09:00',
    updatedAt: '2026-07-21T10:00:00.000+09:00',
    tags: [],
  }
}

describe('FriendListRow follower import profile fallback', () => {
  test.each([null, ''])('表示名 %s は UI 上だけ「名前未取得」と正直に表示する', (displayName) => {
    render(<FriendListRow friend={friend(displayName)} />)

    expect(screen.getByText('名前未取得')).toBeTruthy()
    expect(screen.getByText('?')).toBeTruthy()
  })

  test('画像があっても未取得名を alt に使う', () => {
    render(<FriendListRow friend={friend(null, 'https://example.test/avatar.png')} />)

    expect(screen.getByRole('img', { name: '名前未取得' })).toBeTruthy()
  })
})
