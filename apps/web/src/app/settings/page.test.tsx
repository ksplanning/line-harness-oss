// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: {
    accounts: [
      {
        id: 'account-1',
        channelId: 'channel-1',
        name: 'main',
        displayName: 'メインアカウント',
        isActive: true,
        country: 'JP',
        role: null,
        displayOrder: 0,
      },
      {
        id: 'account-2',
        channelId: 'channel-2',
        name: 'sub',
        displayName: 'サブアカウント',
        isActive: true,
        country: 'JP',
        role: null,
        displayOrder: 1,
      },
    ],
    selectedAccountId: 'account-1' as string | null,
    loading: false,
    setSelectedAccountId: vi.fn(),
    refreshAccounts: vi.fn(),
  },
  emailGet: vi.fn(),
  emailSave: vi.fn(),
  emailSetResendApiKey: vi.fn(),
  emailRegisterDomain: vi.fn(),
  emailCheckDomain: vi.fn(),
  emailTestSend: vi.fn(),
  staffListChannels: vi.fn(),
  staffList: vi.fn(),
  staffCreate: vi.fn(),
  staffUpdate: vi.fn(),
  staffRemove: vi.fn(),
  staffSendTest: vi.fn(),
  staffIssueLineLinkCode: vi.fn(),
  staffUnlinkLine: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => mocks.account,
}))
vi.mock('@/components/layout/header', () => ({
  default: ({ title, description }: { title: string; description: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  ),
}))
vi.mock('@/lib/email-sender-settings-api', () => ({
  emailSenderSettingsApi: {
    get: (...args: unknown[]) => mocks.emailGet(...args),
    save: (...args: unknown[]) => mocks.emailSave(...args),
    setResendApiKey: (...args: unknown[]) => mocks.emailSetResendApiKey(...args),
    registerDomain: (...args: unknown[]) => mocks.emailRegisterDomain(...args),
    checkDomain: (...args: unknown[]) => mocks.emailCheckDomain(...args),
    testSend: (...args: unknown[]) => mocks.emailTestSend(...args),
  },
}))
vi.mock('@/components/settings/staff-notification-settings-api', () => ({
  staffNotificationSettingsApi: {
    listChannels: (...args: unknown[]) => mocks.staffListChannels(...args),
    list: (...args: unknown[]) => mocks.staffList(...args),
    create: (...args: unknown[]) => mocks.staffCreate(...args),
    update: (...args: unknown[]) => mocks.staffUpdate(...args),
    remove: (...args: unknown[]) => mocks.staffRemove(...args),
    sendTest: (...args: unknown[]) => mocks.staffSendTest(...args),
    issueLineLinkCode: (...args: unknown[]) => mocks.staffIssueLineLinkCode(...args),
    unlinkLine: (...args: unknown[]) => mocks.staffUnlinkLine(...args),
  },
}))

import SettingsPage from './page'

const emptyEmailSettings = {
  senderEmail: 'before@example.com',
  senderName: '変更前',
  senderDomain: 'example.com',
  resendApiKeyMasked: null as string | null,
  resendDomainId: null,
  domainStatus: 'pending',
  dnsRecords: [],
  usingFallback: false,
}

const channels = [
  {
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
  },
  {
    channelType: 'line',
    label: 'LINE',
    configFields: [],
    capabilities: { testSend: false, setupKind: 'line_one_time' as const },
    notice: 'LINE通知は配信数を消費します。',
  },
]

let emailSettingsByAccount: Record<string, typeof emptyEmailSettings>
let destinationsByAccount: Record<string, Array<{
  id: string
  label: string
  channelType: string
  notifyInquiry: boolean
  notifyFormSubmission: boolean
  notifyAutoReply: boolean
  enabled: boolean
  config: Record<string, string>
  unsupported: boolean
  setupState: null
}>>

beforeEach(() => {
  mocks.account.selectedAccountId = 'account-1'
  mocks.account.loading = false
  mocks.account.setSelectedAccountId.mockReset()
  emailSettingsByAccount = {
    'account-1': { ...emptyEmailSettings },
    'account-2': {
      ...emptyEmailSettings,
      senderEmail: 'sub@example.net',
      senderName: 'サブ担当',
      senderDomain: 'example.net',
    },
  }
  destinationsByAccount = {
    'account-1': [],
    'account-2': [],
  }

  mocks.emailGet.mockReset().mockImplementation(async (accountId: string) => ({
    ...emailSettingsByAccount[accountId],
    dnsRecords: [...emailSettingsByAccount[accountId].dnsRecords],
  }))
  mocks.emailSave.mockReset().mockImplementation(async (
    accountId: string,
    input: { senderEmail: string | null; senderName: string | null },
  ) => {
    emailSettingsByAccount[accountId] = {
      ...emailSettingsByAccount[accountId],
      ...input,
    } as typeof emptyEmailSettings
    return { ...emailSettingsByAccount[accountId] }
  })
  mocks.emailSetResendApiKey.mockReset().mockImplementation(async (
    accountId: string,
    resendApiKey: string | null,
  ) => {
    emailSettingsByAccount[accountId] = {
      ...emailSettingsByAccount[accountId],
      resendApiKeyMasked: resendApiKey ? '********' : null,
    }
    return { ...emailSettingsByAccount[accountId] }
  })
  mocks.emailRegisterDomain.mockReset().mockImplementation(async (accountId: string) => ({
    ...emailSettingsByAccount[accountId],
  }))
  mocks.emailCheckDomain.mockReset().mockImplementation(async (accountId: string) => ({
    ...emailSettingsByAccount[accountId],
  }))
  mocks.emailTestSend.mockReset().mockResolvedValue({
    message: 'テストメールを送信しました。',
  })

  mocks.staffListChannels.mockReset().mockResolvedValue(channels)
  mocks.staffList.mockReset().mockImplementation(async (accountId: string) => (
    destinationsByAccount[accountId].map((destination) => ({
      ...destination,
      config: { ...destination.config },
    }))
  ))
  mocks.staffCreate.mockReset().mockImplementation(async (input: {
    lineAccountId: string
    label: string
    channelType: string
    notifyInquiry: boolean
    notifyFormSubmission: boolean
    notifyAutoReply: boolean
    enabled: boolean
    config: Record<string, string>
  }) => {
    const destination = {
      id: 'destination-created',
      label: input.label,
      channelType: input.channelType,
      notifyInquiry: input.notifyInquiry,
      notifyFormSubmission: input.notifyFormSubmission,
      notifyAutoReply: input.notifyAutoReply,
      enabled: input.enabled,
      config: {
        ...input.config,
        ...(input.config.apiToken ? { apiToken: '********' } : {}),
      },
      unsupported: false,
      setupState: null,
    }
    destinationsByAccount[input.lineAccountId] = [destination]
    return destination
  })
  mocks.staffUpdate.mockReset().mockResolvedValue(undefined)
  mocks.staffRemove.mockReset().mockResolvedValue(undefined)
  mocks.staffSendTest.mockReset().mockResolvedValue(undefined)
  mocks.staffIssueLineLinkCode.mockReset().mockResolvedValue({
    code: 'CODE',
    expiresAt: '2026-07-23T12:00:00.000Z',
  })
  mocks.staffUnlinkLine.mockReset().mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('設定ページ', () => {
  test('ページ見出しを「通知設定」と表示する', () => {
    render(<SettingsPage />)

    expect(screen.getByRole('heading', { level: 1, name: '通知設定' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: '設定' })).toBeNull()
  })

  test('独自のアカウント選択を出さず、左上の選択中アカウントに両設定が追随する', async () => {
    const view = render(<SettingsPage />)

    expect(screen.queryByLabelText('設定する LINE アカウント')).toBeNull()
    expect(screen.queryByText('複数ある場合は、先に設定したいアカウントを選んでください。'))
      .toBeNull()
    expect(mocks.account.setSelectedAccountId).not.toHaveBeenCalled()

    expect(await screen.findByTestId('email-sender-dns-guide')).toBeTruthy()
    await waitFor(() => expect(mocks.emailGet).toHaveBeenCalledWith('account-1'))
    expect(screen.getByTestId('email-sender-settings-panel')).toBeTruthy()
    expect(screen.queryByTestId('staff-notification-settings-panel')).toBeNull()

    mocks.account.selectedAccountId = 'account-2'
    view.rerender(<SettingsPage />)
    await waitFor(() => expect(mocks.emailGet).toHaveBeenCalledWith('account-2'))
    await waitFor(() => {
      expect((screen.getByLabelText('差出人メールアドレス') as HTMLInputElement).value)
        .toBe('sub@example.net')
    })

    fireEvent.click(screen.getByRole('button', { name: 'スタッフ通知を開く' }))

    expect(await screen.findByTestId('staff-notification-settings-panel')).toBeTruthy()
    await waitFor(() => expect(mocks.staffList).toHaveBeenCalledWith('account-2'))
    expect(screen.getByRole('option', { name: 'Chatwork' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'LINE' })).toBeTruthy()
    expect(screen.queryByTestId('email-sender-settings-panel')).toBeNull()
    expect(screen.queryByTestId('email-sender-dns-guide')).toBeNull()
  })

  test('左上切替で保存先と再取得先が分かれ、A→B→Aを往復しても混線しない', async () => {
    const view = render(<SettingsPage />)

    const accountOneEmail = await screen.findByLabelText('差出人メールアドレス')
    fireEvent.change(accountOneEmail, { target: { value: 'saved-one@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '差出人を保存' }))
    await waitFor(() => expect(mocks.emailSave).toHaveBeenCalledWith('account-1', {
      senderEmail: 'saved-one@example.com',
      senderName: '変更前',
    }))

    mocks.account.selectedAccountId = 'account-2'
    view.rerender(<SettingsPage />)
    await waitFor(() => {
      expect((screen.getByLabelText('差出人メールアドレス') as HTMLInputElement).value)
        .toBe('sub@example.net')
    })
    const accountTwoEmail = screen.getByLabelText('差出人メールアドレス')
    fireEvent.change(accountTwoEmail, { target: { value: 'saved-two@example.net' } })
    fireEvent.click(screen.getByRole('button', { name: '差出人を保存' }))
    await waitFor(() => expect(mocks.emailSave).toHaveBeenCalledWith('account-2', {
      senderEmail: 'saved-two@example.net',
      senderName: 'サブ担当',
    }))

    mocks.account.selectedAccountId = 'account-1'
    view.rerender(<SettingsPage />)
    await waitFor(() => {
      expect((screen.getByLabelText('差出人メールアドレス') as HTMLInputElement).value)
        .toBe('saved-one@example.com')
    })
    expect((screen.getByLabelText('宛先メールアドレス') as HTMLInputElement).value)
      .toBe('saved-one@example.com')

    mocks.account.selectedAccountId = 'account-2'
    view.rerender(<SettingsPage />)
    await waitFor(() => {
      expect((screen.getByLabelText('差出人メールアドレス') as HTMLInputElement).value)
        .toBe('saved-two@example.net')
    })
    expect((screen.getByLabelText('宛先メールアドレス') as HTMLInputElement).value)
      .toBe('saved-two@example.net')
  })

  test('Resend APIキーのマスク表示も左上のA/B切替で混線しない', async () => {
    const view = render(<SettingsPage />)
    const keyInput = await screen.findByLabelText('Resend APIキー')
    fireEvent.change(keyInput, { target: { value: 're_account_one' } })
    fireEvent.click(screen.getByRole('button', { name: 'APIキーを保存' }))
    await waitFor(() => expect(mocks.emailSetResendApiKey).toHaveBeenCalledWith(
      'account-1',
      're_account_one',
    ))
    expect(screen.getByText('********')).toBeTruthy()

    mocks.account.selectedAccountId = 'account-2'
    view.rerender(<SettingsPage />)
    await waitFor(() => expect(mocks.emailGet).toHaveBeenCalledWith('account-2'))
    expect(await screen.findByText(/未設定.*共通キー/)).toBeTruthy()
    expect(screen.queryByText('********')).toBeNull()

    mocks.account.selectedAccountId = 'account-1'
    view.rerender(<SettingsPage />)
    await waitFor(() => expect(mocks.emailGet).toHaveBeenCalledWith('account-1'))
    expect(await screen.findByText('********')).toBeTruthy()
  })

  test('両設定を保存し、自動応答通知ONを含む再取得値と一致する', async () => {
    render(<SettingsPage />)

    const email = await screen.findByLabelText('差出人メールアドレス')
    fireEvent.change(email, { target: { value: 'saved@example.com' } })
    fireEvent.change(screen.getByLabelText('差出人名（任意）'), {
      target: { value: '保存後担当' },
    })
    fireEvent.click(screen.getByRole('button', { name: '差出人を保存' }))
    await waitFor(() => expect(mocks.emailSave).toHaveBeenCalledWith('account-1', {
      senderEmail: 'saved@example.com',
      senderName: '保存後担当',
    }))

    fireEvent.click(screen.getByRole('button', { name: 'スタッフ通知を開く' }))
    await screen.findByTestId('staff-notification-empty')
    fireEvent.change(screen.getByLabelText('通知先名'), {
      target: { value: '受付チーム' },
    })
    fireEvent.change(screen.getByLabelText('Chatwork ルームID'), {
      target: { value: '12345' },
    })
    fireEvent.change(screen.getByLabelText('Chatwork APIトークン'), {
      target: { value: 'INPUT_ONLY_TOKEN' },
    })
    const notifyAutoReply = screen.getByLabelText(
      '自動応答で処理されたものも通知する',
    ) as HTMLInputElement
    expect(notifyAutoReply.checked).toBe(false)
    fireEvent.click(notifyAutoReply)
    fireEvent.click(screen.getByRole('button', { name: '通知先を追加' }))

    await waitFor(() => expect(mocks.staffCreate).toHaveBeenCalledWith({
      lineAccountId: 'account-1',
      label: '受付チーム',
      channelType: 'chatwork',
      notifyInquiry: true,
      notifyFormSubmission: true,
      notifyAutoReply: true,
      enabled: true,
      config: {
        roomId: '12345',
        apiToken: 'INPUT_ONLY_TOKEN',
      },
    }))
    expect(await screen.findByText('受付チーム')).toBeTruthy()
    expect(document.body.textContent).not.toContain('INPUT_ONLY_TOKEN')

    fireEvent.click(screen.getByRole('button', { name: 'メール差出人を開く' }))
    await waitFor(() => expect(mocks.emailGet).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect((screen.getByLabelText('差出人メールアドレス') as HTMLInputElement).value)
        .toBe('saved@example.com')
    })
    expect(screen.getByDisplayValue('保存後担当')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'スタッフ通知を開く' }))
    await waitFor(() => expect(mocks.staffList).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('受付チーム')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '受付チームを編集' }))
    expect((screen.getByLabelText(
      '自動応答で処理されたものも通知する',
    ) as HTMLInputElement).checked).toBe(true)
  })
})
