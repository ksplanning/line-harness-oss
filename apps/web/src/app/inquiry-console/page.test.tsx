// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const routeMocks = vi.hoisted(() => ({
  query: '',
  client: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(routeMocks.query),
}))

vi.mock('./inquiry-console-client', () => ({
  default: ({ friendId }: { friendId: string }) => {
    routeMocks.client(friendId)
    return <div>console:{friendId}</div>
  },
}))

import InquiryConsolePage from './page'

afterEach(() => {
  cleanup()
  routeMocks.query = ''
  vi.clearAllMocks()
})

describe('/inquiry-console static route', () => {
  it('friend query が無いリンクは API を呼ばず、明確なエラーを表示する', () => {
    render(<InquiryConsolePage />)

    expect(screen.getByRole('heading', { name: '問い合わせを特定できません' })).toBeTruthy()
    expect(screen.getByText('通知に記載されたリンクから開いてください。')).toBeTruthy()
    expect(routeMocks.client).not.toHaveBeenCalled()
  })

  it('friend query だけをコンソールへ渡す', () => {
    routeMocks.query = 'friend=friend%2F1&token=leaked-value'
    render(<InquiryConsolePage />)

    expect(screen.getByText('console:friend/1')).toBeTruthy()
    expect(routeMocks.client).toHaveBeenCalledWith('friend/1')
  })
})
