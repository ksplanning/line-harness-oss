// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { getTestRecipients, updateTestRecipients, listFriends } = vi.hoisted(() => ({
  getTestRecipients: vi.fn(),
  updateTestRecipients: vi.fn(),
  listFriends: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    accountSettings: {
      getTestRecipients: (...args: unknown[]) => getTestRecipients(...args),
      updateTestRecipients: (...args: unknown[]) => updateTestRecipients(...args),
    },
    friends: {
      list: (...args: unknown[]) => listFriends(...args),
    },
  },
}))

import TestRecipientsSetting from './test-recipients-setting'

beforeEach(() => {
  getTestRecipients.mockReset()
  updateTestRecipients.mockReset()
  listFriends.mockReset()
  getTestRecipients.mockResolvedValue({
    success: true,
    data: [{ id: 'friend-1', displayName: '既存テスター', pictureUrl: null }],
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TestRecipientsSetting', () => {
  it('loads recipients and clears the setting by removing the final friend', async () => {
    updateTestRecipients.mockResolvedValue({ success: true })
    render(<TestRecipientsSetting accountId="acc-1" />)

    await screen.findByText('既存テスター')
    fireEvent.click(screen.getByRole('button', { name: '既存テスターを解除' }))

    await waitFor(() => expect(updateTestRecipients).toHaveBeenCalledWith('acc-1', []))
    expect(screen.getByText('テスト送信先はまだ設定されていません')).toBeTruthy()
  })

  it('rolls back an optimistic removal and shows the API error when saving fails', async () => {
    updateTestRecipients.mockResolvedValue({ success: false, error: '保存できません' })
    render(<TestRecipientsSetting accountId="acc-1" />)

    await screen.findByText('既存テスター')
    fireEvent.click(screen.getByRole('button', { name: '既存テスターを解除' }))

    await waitFor(() => expect(screen.getByText('保存できません')).toBeTruthy())
    expect(screen.getByText('既存テスター')).toBeTruthy()
  })

  it('searches only within the account and saves multiple selected friends', async () => {
    vi.useFakeTimers()
    updateTestRecipients.mockResolvedValue({ success: true })
    listFriends.mockResolvedValue({
      success: true,
      data: {
        items: [{ id: 'friend-2', displayName: '追加テスター', pictureUrl: null }],
        total: 1,
      },
    })
    render(<TestRecipientsSetting accountId="acc-1" />)
    await act(async () => { await Promise.resolve() })

    fireEvent.change(screen.getByRole('textbox', { name: 'テスト送信先を検索' }), {
      target: { value: '追加' },
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(listFriends).toHaveBeenCalledWith({
      search: '追加',
      accountId: 'acc-1',
      limit: 10,
      includeTags: false,
    })
    fireEvent.click(screen.getByRole('button', { name: '追加テスターを追加' }))
    await act(async () => { await Promise.resolve() })
    expect(updateTestRecipients).toHaveBeenCalledWith('acc-1', ['friend-1', 'friend-2'])
  })

  it('shows a visible error when the initial setting cannot be loaded', async () => {
    getTestRecipients.mockRejectedValue(new Error('network'))
    render(<TestRecipientsSetting accountId="acc-1" />)
    await waitFor(() => expect(screen.getByText('テスト送信先を読み込めませんでした')).toBeTruthy())
  })
})
