// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listChannels: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  sendTest: vi.fn(),
  issueLineLinkCode: vi.fn(),
  unlinkLine: vi.fn(),
}))

vi.mock('./staff-notification-settings-api', () => ({
  staffNotificationSettingsApi: {
    listChannels: (...args: unknown[]) => mocks.listChannels(...args),
    list: (...args: unknown[]) => mocks.list(...args),
    create: (...args: unknown[]) => mocks.create(...args),
    update: (...args: unknown[]) => mocks.update(...args),
    remove: (...args: unknown[]) => mocks.remove(...args),
    sendTest: (...args: unknown[]) => mocks.sendTest(...args),
    issueLineLinkCode: (...args: unknown[]) => mocks.issueLineLinkCode(...args),
    unlinkLine: (...args: unknown[]) => mocks.unlinkLine(...args),
  },
}))

import StaffNotificationSettingsPanel from './staff-notification-settings-panel'

const chatworkChannel = {
  channelType: 'chatwork',
  label: 'Chatwork',
  configFields: [
    {
      key: 'roomId',
      label: 'Chatwork ルームID',
      inputType: 'text' as const,
      required: true,
      maxLength: 20,
      pattern: '^\\d+$',
    },
    {
      key: 'apiToken',
      label: 'Chatwork APIトークン',
      inputType: 'secret' as const,
      required: true,
      maxLength: 512,
    },
  ],
  capabilities: { testSend: true, setupKind: 'none' as const },
}

const lineChannel = {
  channelType: 'line',
  label: 'LINE',
  configFields: [],
  capabilities: { testSend: false, setupKind: 'line_one_time' as const },
  notice: 'LINE通知は配信数を消費します。',
}

const chatworkDestination = {
  id: 'destination-chatwork',
  label: '受付チーム',
  channelType: 'chatwork' as const,
  notifyInquiry: true,
  notifyFormSubmission: false,
  notifyAutoReply: false,
  enabled: true,
  config: {
    roomId: '12345',
    apiToken: '********',
  },
  unsupported: false,
  setupState: null,
}

const lineDestination = {
  id: 'destination-line',
  label: 'LINE担当',
  channelType: 'line' as const,
  notifyInquiry: false,
  notifyFormSubmission: true,
  notifyAutoReply: false,
  enabled: true,
  config: {},
  unsupported: false,
  setupState: { kind: 'line_one_time' as const, linked: false },
}

beforeEach(() => {
  mocks.listChannels.mockReset().mockResolvedValue([
    chatworkChannel,
    lineChannel,
  ])
  mocks.list.mockReset().mockResolvedValue([chatworkDestination, lineDestination])
  mocks.create.mockReset().mockResolvedValue(undefined)
  mocks.update.mockReset().mockResolvedValue(undefined)
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.sendTest.mockReset().mockResolvedValue({ ok: true })
  mocks.issueLineLinkCode.mockReset().mockResolvedValue({
    code: 'LINK_CODE',
    expiresAt: '2026-07-23T12:00:00.000Z',
  })
  mocks.unlinkLine.mockReset().mockResolvedValue(undefined)
})

afterEach(() => cleanup())

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('StaffNotificationSettingsPanel', () => {
  test('通知先一覧を日常語で表示し、Chatwork token の平文を再表示しない', async () => {
    render(<StaffNotificationSettingsPanel accountId="account-1" />)

    const item = await screen.findByTestId('staff-notification-destination-destination-chatwork')
    expect(item.textContent).toContain('受付チーム')
    expect(item.textContent).toContain('問い合わせ受信: 通知する')
    expect(item.textContent).toContain('フォーム申込み: 通知しない')
    expect(item.textContent).toContain('********')
    expect(document.body.textContent).not.toContain('TOKEN_INPUT_ONLY')

    const token = screen.getByLabelText('Chatwork APIトークン') as HTMLInputElement
    expect(token.type).toBe('password')
    expect(token.autocomplete).toBe('off')
    expect(token.value).toBe('')
  })

  test('自動応答通知は既定OFFで、ONのChatwork通知先を作成後にGET再取得値を表示する', async () => {
    const created = {
      ...chatworkDestination,
      id: 'destination-created',
      label: '夜間受付',
      notifyInquiry: true,
      notifyFormSubmission: false,
      notifyAutoReply: true,
      config: {
        roomId: '67890',
        apiToken: '********',
      },
    }
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created])

    render(<StaffNotificationSettingsPanel accountId="account-1" />)
    await screen.findByTestId('staff-notification-empty')

    const notifyAutoReply = screen.getByLabelText(
      '自動応答で処理されたものも通知する',
    ) as HTMLInputElement
    expect(notifyAutoReply.checked).toBe(false)
    change('通知先名', ' 夜間受付 ')
    change('Chatwork ルームID', ' 67890 ')
    change('Chatwork APIトークン', 'TOKEN_INPUT_ONLY')
    fireEvent.click(screen.getByLabelText('フォーム申込みを通知'))
    fireEvent.click(notifyAutoReply)
    fireEvent.click(screen.getByRole('button', { name: '通知先を追加' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      lineAccountId: 'account-1',
      label: '夜間受付',
      channelType: 'chatwork',
      notifyInquiry: true,
      notifyFormSubmission: false,
      notifyAutoReply: true,
      enabled: true,
      config: {
        roomId: '67890',
        apiToken: 'TOKEN_INPUT_ONLY',
      },
    }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('夜間受付')).toBeTruthy()
    expect(document.body.textContent).not.toContain('TOKEN_INPUT_ONLY')
    expect((screen.getByLabelText('Chatwork APIトークン') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '夜間受付を編集' }))
    expect((screen.getByLabelText(
      '自動応答で処理されたものも通知する',
    ) as HTMLInputElement).checked).toBe(true)
  })

  test('編集で自動応答通知をOFFに戻し、空tokenを維持してGET再取得値を表示する', async () => {
    const editable = {
      ...chatworkDestination,
      notifyAutoReply: true,
    }
    const updated = {
      ...editable,
      label: '更新後チーム',
      notifyInquiry: false,
      notifyFormSubmission: true,
      notifyAutoReply: false,
      enabled: false,
      config: { ...chatworkDestination.config, roomId: '98765' },
    }
    mocks.list
      .mockResolvedValueOnce([editable])
      .mockResolvedValueOnce([updated])

    render(<StaffNotificationSettingsPanel accountId="account-1" />)
    fireEvent.click(await screen.findByRole('button', { name: '受付チームを編集' }))

    const notifyAutoReply = screen.getByLabelText(
      '自動応答で処理されたものも通知する',
    ) as HTMLInputElement
    expect(notifyAutoReply.checked).toBe(true)
    change('通知先名', '更新後チーム')
    change('Chatwork ルームID', '98765')
    fireEvent.click(screen.getByLabelText('問い合わせ受信を通知'))
    fireEvent.click(screen.getByLabelText('フォーム申込みを通知'))
    fireEvent.click(notifyAutoReply)
    fireEvent.click(screen.getByLabelText('この通知先を有効にする'))
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(
      'destination-chatwork',
      {
        lineAccountId: 'account-1',
        label: '更新後チーム',
        channelType: 'chatwork',
        notifyInquiry: false,
        notifyFormSubmission: true,
        notifyAutoReply: false,
        enabled: false,
        config: {
          roomId: '98765',
          apiToken: '',
        },
      },
    ))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    const item = await screen.findByTestId('staff-notification-destination-destination-chatwork')
    expect(item.textContent).toContain('更新後チーム')
    expect(item.textContent).toContain('無効')
    expect(item.textContent).toContain('フォーム申込み: 通知する')
    fireEvent.click(await screen.findByRole('button', { name: '更新後チームを編集' }))
    expect((screen.getByLabelText(
      '自動応答で処理されたものも通知する',
    ) as HTMLInputElement).checked).toBe(false)
  })

  test('削除後に GET し直して一覧から消す', async () => {
    mocks.list
      .mockResolvedValueOnce([lineDestination])
      .mockResolvedValueOnce([])

    render(<StaffNotificationSettingsPanel accountId="account-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'LINE担当を削除' }))

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(
      'account-1',
      'destination-line',
    ))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('staff-notification-empty')).toBeTruthy()
    expect(screen.queryByText('LINE担当')).toBeNull()
  })

  test('Chatwork テスト送信の成功と失敗を status/alert で表示する', async () => {
    mocks.list.mockResolvedValue([chatworkDestination])
    render(<StaffNotificationSettingsPanel accountId="account-1" />)

    fireEvent.click(await screen.findByRole('button', { name: '受付チームへテスト送信' }))
    await waitFor(() => expect(mocks.sendTest).toHaveBeenCalledWith(
      'account-1',
      'destination-chatwork',
    ))
    expect((await screen.findByRole('status')).textContent)
      .toContain('テスト通知を送信しました')

    mocks.sendTest.mockRejectedValueOnce(new Error('failure'))
    fireEvent.click(screen.getByRole('button', { name: '受付チームへテスト送信' }))
    expect((await screen.findByRole('alert')).textContent)
      .toContain('テスト通知を送信できませんでした')
  })

  test('テスト成功後に設定編集を始めたら古い成功表示を消す', async () => {
    mocks.list.mockResolvedValue([chatworkDestination])
    render(<StaffNotificationSettingsPanel accountId="account-1" />)

    fireEvent.click(await screen.findByRole('button', { name: '受付チームへテスト送信' }))
    expect((await screen.findByRole('status')).textContent)
      .toContain('テスト通知を送信しました')

    fireEvent.click(screen.getByRole('button', { name: '受付チームを編集' }))
    expect(screen.queryByText('テスト通知を送信しました。')).toBeNull()
  })

  test('LINE 配信数の注意、コード発行、連携解除を表示・実行する', async () => {
    mocks.list
      .mockResolvedValueOnce([lineDestination])
      .mockResolvedValueOnce([{
        ...lineDestination,
        setupState: { kind: 'line_one_time', linked: true },
      }])
      .mockResolvedValueOnce([{
        ...lineDestination,
        setupState: { kind: 'line_one_time', linked: false },
      }])

    render(<StaffNotificationSettingsPanel accountId="account-1" />)
    expect(await screen.findByText('LINE通知は配信数を消費します。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'LINE担当の連携コードを発行' }))
    await waitFor(() => expect(mocks.issueLineLinkCode).toHaveBeenCalledWith(
      'account-1',
      'destination-line',
    ))
    expect(await screen.findByText('通知連携 LINK_CODE')).toBeTruthy()
    expect(screen.getByText(/有効期限:/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'LINE担当の連携状態を更新' }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: 'LINE担当のLINE連携を解除' }))
    await waitFor(() => expect(mocks.unlinkLine).toHaveBeenCalledWith(
      'account-1',
      'destination-line',
    ))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('LINE連携: 未連携')).toBeTruthy()
  })

  test('LINE 通知先を追加する時は Chatwork 設定を送らない', async () => {
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lineDestination])
    render(<StaffNotificationSettingsPanel accountId="account-1" />)
    await screen.findByTestId('staff-notification-empty')

    change('通知チャネル', 'line')
    change('通知先名', 'LINE担当')
    fireEvent.click(screen.getByLabelText('問い合わせ受信を通知'))
    fireEvent.click(screen.getByRole('button', { name: '通知先を追加' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      lineAccountId: 'account-1',
      label: 'LINE担当',
      channelType: 'line',
      notifyInquiry: false,
      notifyFormSubmission: true,
      notifyAutoReply: false,
      enabled: true,
      config: {},
    }))
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  })

  test('catalogへ定義を足すだけで新channelの項目を描画して保存する', async () => {
    mocks.listChannels.mockResolvedValue([
      chatworkChannel,
      lineChannel,
      {
        channelType: 'slack',
        label: 'Slack',
        configFields: [
          {
            key: 'channelId',
            label: 'Slack Channel ID',
            inputType: 'text',
            required: true,
            maxLength: 30,
          },
          {
            key: 'botToken',
            label: 'Slack Bot Token',
            inputType: 'secret',
            required: true,
            maxLength: 100,
          },
        ],
        capabilities: { testSend: true, setupKind: 'none' },
      },
    ])
    mocks.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'destination-slack',
        label: 'Slack受付',
        channelType: 'slack',
        notifyInquiry: true,
        notifyFormSubmission: true,
        notifyAutoReply: false,
        enabled: true,
        config: { channelId: 'C012ABC', botToken: '********' },
        unsupported: false,
        setupState: null,
      }])

    render(<StaffNotificationSettingsPanel accountId="account-1" />)
    await screen.findByTestId('staff-notification-empty')
    change('通知チャネル', 'slack')
    change('通知先名', 'Slack受付')
    change('Slack Channel ID', 'C012ABC')
    change('Slack Bot Token', 'SECRET_INPUT_ONLY')
    fireEvent.click(screen.getByRole('button', { name: '通知先を追加' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      lineAccountId: 'account-1',
      label: 'Slack受付',
      channelType: 'slack',
      notifyInquiry: true,
      notifyFormSubmission: true,
      notifyAutoReply: false,
      enabled: true,
      config: {
        channelId: 'C012ABC',
        botToken: 'SECRET_INPUT_ONLY',
      },
    }))
    expect(await screen.findByText('Slack受付')).toBeTruthy()
    expect(document.body.textContent).not.toContain('SECRET_INPUT_ONLY')
  })

  test('アカウント切替後に古い GET 応答を反映しない', async () => {
    let resolveOld!: (value: (typeof chatworkDestination)[]) => void
    mocks.list.mockImplementation((accountId: string) => {
      if (accountId === 'account-old') {
        return new Promise((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve([{ ...lineDestination, label: '新アカウント担当' }])
    })

    const view = render(<StaffNotificationSettingsPanel accountId="account-old" />)
    view.rerender(<StaffNotificationSettingsPanel accountId="account-new" />)
    expect(await screen.findByText('新アカウント担当')).toBeTruthy()

    await act(async () => {
      resolveOld([chatworkDestination])
      await Promise.resolve()
    })
    expect(screen.queryByText('受付チーム')).toBeNull()
  })
})
