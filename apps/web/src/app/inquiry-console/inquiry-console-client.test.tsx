// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  openInquiry: vi.fn(),
  send: vi.fn(),
  complete: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    chats: {
      openInquiry: apiMocks.openInquiry,
      send: apiMocks.send,
      complete: apiMocks.complete,
      inquiryPreferences: {
        get: apiMocks.getPreferences,
        update: apiMocks.updatePreferences,
      },
    },
  },
}))

import InquiryConsoleClient from './inquiry-console-client'

const ownDetail = {
  id: 'friend-1',
  friendId: 'friend-1',
  friendName: '佐藤 花子',
  friendPictureUrl: null,
  lineAccountId: 'account-1',
  lineAccountName: '予約窓口',
  operatorId: null,
  assignedStaffId: 'staff-1',
  assignedStaffName: '山田',
  status: 'in_progress' as const,
  isUnanswered: false,
  notes: null,
  readAt: '2026-07-23T10:00:00+09:00',
  lastMessageAt: '2026-07-23T09:59:00+09:00',
  createdAt: '2026-07-23T09:59:00+09:00',
  messages: [
    {
      id: 'message-1',
      direction: 'incoming' as const,
      messageType: 'text',
      content: '予約を変更したいです',
      staffMemberId: null,
      staffMemberName: null,
      createdAt: '2026-07-23T09:59:00+09:00',
    },
  ],
  pendingDrafts: [],
}

const preferences = {
  staffId: 'staff-1',
  staffName: '山田',
  replySignatureEnabled: true,
  canUpdate: true,
}

beforeEach(() => {
  apiMocks.openInquiry.mockResolvedValue({ success: true, data: ownDetail })
  apiMocks.getPreferences.mockResolvedValue({ success: true, data: preferences })
  apiMocks.send.mockResolvedValue({
    success: true,
    data: {
      sent: true,
      messageId: 'message-2',
      message: {
        id: 'message-2',
        direction: 'outgoing',
        messageType: 'text',
        content: '担当: 山田\n承知しました',
        staffMemberId: 'staff-1',
        staffMemberName: '山田',
        createdAt: '2026-07-23T10:01:00+09:00',
      },
    },
  })
  apiMocks.complete.mockResolvedValue({
    success: true,
    data: { ...ownDetail, status: 'resolved' },
  })
  apiMocks.updatePreferences.mockResolvedValue({
    success: true,
    data: { ...preferences, replySignatureEnabled: false },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('問い合わせ対応コンソール', () => {
  it('開いた時に対応開始し、送信先・担当・既存履歴・担当名設定をスマホ画面に出す', async () => {
    render(<InquiryConsoleClient friendId="friend-1" />)

    expect(await screen.findByRole('heading', { name: '佐藤 花子' })).toBeTruthy()
    expect(apiMocks.openInquiry).toHaveBeenCalledWith('friend-1')
    expect(apiMocks.getPreferences).toHaveBeenCalledTimes(1)
    expect(screen.getByText('送信先: 佐藤 花子')).toBeTruthy()
    expect(screen.getByText('LINE公式アカウント: 予約窓口')).toBeTruthy()
    expect(screen.getByText('対応中')).toBeTruthy()
    expect(screen.getByText('担当: 山田')).toBeTruthy()
    expect(within(screen.getByTestId('chat-message-history')).getByText('予約を変更したいです')).toBeTruthy()
    expect((screen.getByRole('checkbox', {
      name: '返信の文頭に担当名を付ける',
    }) as HTMLInputElement).checked).toBe(true)

    const shell = screen.getByTestId('inquiry-console')
    expect(shell.className).toContain('h-[100dvh]')
    expect(screen.getByRole('button', { name: '送信' }).className).toContain('min-h-11')
    expect(screen.getByRole('button', { name: '対応完了' }).className).toContain('min-h-11')
  })

  it('別スタッフが対応中なら明示し、返信と完了操作を無効にする', async () => {
    apiMocks.openInquiry.mockResolvedValue({
      success: true,
      data: {
        ...ownDetail,
        assignedStaffId: 'staff-2',
        assignedStaffName: '田中',
      },
    })

    render(<InquiryConsoleClient friendId="friend-1" />)

    expect(await screen.findByText('田中さんが対応中です')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: '返信内容' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '対応完了' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('既存送信経路で返信し、実際に担当名が付いた本文を履歴へ反映してから完了できる', async () => {
    render(<InquiryConsoleClient friendId="friend-1" />)

    const input = await screen.findByRole('textbox', { name: '返信内容' })
    fireEvent.change(input, { target: { value: '承知しました' } })
    fireEvent.click(screen.getByRole('button', { name: '送信' }))

    await waitFor(() => {
      expect(apiMocks.send).toHaveBeenCalledWith('friend-1', {
        content: '承知しました',
        messageType: 'text',
      })
    })
    await waitFor(() => {
      expect(screen.getAllByTestId('chat-message-bubble').some(
        (bubble) => bubble.textContent === '担当: 山田\n承知しました',
      )).toBe(true)
    })
    expect(screen.getByText('送信済み')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '対応完了' }))
    await waitFor(() => expect(apiMocks.complete).toHaveBeenCalledWith('friend-1'))
    expect(await screen.findByText('完了')).toBeTruthy()
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('担当名の自動付与を本人設定として切り替える', async () => {
    render(<InquiryConsoleClient friendId="friend-1" />)

    const toggle = await screen.findByRole('checkbox', { name: '返信の文頭に担当名を付ける' })
    fireEvent.click(toggle)

    await waitFor(() => expect(apiMocks.updatePreferences).toHaveBeenCalledWith(false))
    expect((toggle as HTMLInputElement).checked).toBe(false)
  })

  it('open・送信・完了の失敗を画面へ出し、操作中表示を解除する', async () => {
    apiMocks.openInquiry.mockRejectedValueOnce(new Error('network down'))
    const firstRender = render(<InquiryConsoleClient friendId="friend-1" />)

    expect((await screen.findByRole('alert')).textContent).toBe(
      '問い合わせを開けませんでした。通信状態を確認して、もう一度お試しください。',
    )
    expect(screen.queryByText('問い合わせを開いています…')).toBeNull()
    firstRender.unmount()

    apiMocks.openInquiry.mockResolvedValue({ success: true, data: ownDetail })
    apiMocks.send.mockRejectedValueOnce(new Error('send failed'))
    render(<InquiryConsoleClient friendId="friend-1" />)

    const input = await screen.findByRole('textbox', { name: '返信内容' })
    fireEvent.change(input, { target: { value: '再送できる本文' } })
    fireEvent.click(screen.getByRole('button', { name: '送信' }))
    expect(await screen.findByText(
      '返信を送信できませんでした。内容を残したまま再度お試しください。',
    )).toBeTruthy()
    expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false)
    expect((input as HTMLTextAreaElement).value).toBe('再送できる本文')

    apiMocks.complete.mockRejectedValueOnce(new Error('complete failed'))
    fireEvent.click(screen.getByRole('button', { name: '対応完了' }))
    expect(await screen.findByText(
      '対応を完了にできませんでした。画面を開き直して状態を確認してください。',
    )).toBeTruthy()
    expect((screen.getByRole('button', { name: '対応完了' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
