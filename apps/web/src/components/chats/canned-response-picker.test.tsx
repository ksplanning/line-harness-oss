// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { cannedResponses: { list: apiMocks.list } },
}))

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

import CannedResponsePicker from './canned-response-picker'

beforeEach(() => {
  apiMocks.list.mockResolvedValue({
    success: true,
    data: [{ id: 'canned-1', title: 'あいさつ', content: 'こんにちは' }],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CannedResponsePicker', () => {
  it('コンパクト表示でも名前付きアイコンから開閉・選択できる', async () => {
    const onSelect = vi.fn()
    render(<CannedResponsePicker accountId="account-1" onSelect={onSelect} compact />)

    const button = screen.getByRole('button', { name: '定型文を選ぶ' })
    expect(button.className).toContain('h-11')
    expect(button.className).toContain('w-11')
    expect(button.className).toContain('shrink-0')
    expect(button.textContent).not.toContain('定型文')
    expect(button.getAttribute('title')).toBe('定型文を選ぶ')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog', { name: '定型文を選ぶ' })).toBeNull()
    expect(screen.queryByText(/選ぶと下の入力欄に入ります/)).toBeNull()

    fireEvent.click(button)
    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledWith('account-1'))
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const dialog = screen.getByRole('dialog', { name: '定型文を選ぶ' })
    expect(dialog).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /あいさつ/ }))
    expect(onSelect).toHaveBeenCalledWith('こんにちは')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog', { name: '定型文を選ぶ' })).toBeNull()

    fireEvent.click(button)
    expect(screen.getByRole('dialog', { name: '定型文を選ぶ' })).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog', { name: '定型文を選ぶ' })).toBeNull()
  })
})
