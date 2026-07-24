// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  setResendApiKey: vi.fn(),
  registerDomain: vi.fn(),
  checkDomain: vi.fn(),
  testSend: vi.fn(),
}))

vi.mock('@/lib/email-sender-settings-api', () => ({
  emailSenderSettingsApi: {
    get: (...args: unknown[]) => mocks.get(...args),
    save: (...args: unknown[]) => mocks.save(...args),
    setResendApiKey: (...args: unknown[]) => mocks.setResendApiKey(...args),
    registerDomain: (...args: unknown[]) => mocks.registerDomain(...args),
    checkDomain: (...args: unknown[]) => mocks.checkDomain(...args),
    testSend: (...args: unknown[]) => mocks.testSend(...args),
  },
}))

import EmailSenderSettingsPanel from './email-sender-settings-panel'

const pendingView = {
  senderEmail: 'notice@example.com',
  senderName: 'お知らせ係',
  senderDomain: 'example.com',
  resendApiKeyMasked: null,
  resendDomainId: 'domain_pending',
  domainStatus: 'pending',
  dnsRecords: [{
    record: 'SPF',
    type: 'TXT',
    name: 'send.example.com',
    value: 'v=spf1 include:amazonses.com ~all',
    ttl: 'Auto',
    status: 'pending',
    priority: null,
  }, {
    record: 'DKIM',
    type: 'MX',
    name: 'resend._domainkey.example.com',
    value: 'feedback-smtp.ap-northeast-1.amazonses.com',
    ttl: '3600',
    status: 'pending',
    priority: 10,
  }],
  usingFallback: true,
}

const emptyView = {
  senderEmail: null,
  senderName: null,
  senderDomain: null,
  resendApiKeyMasked: null,
  resendDomainId: null,
  domainStatus: 'not_registered',
  dnsRecords: [],
  usingFallback: false,
}

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(pendingView)
  mocks.save.mockReset().mockResolvedValue(pendingView)
  mocks.setResendApiKey.mockReset().mockResolvedValue({
    ...pendingView,
    resendApiKeyMasked: '********',
  })
  mocks.registerDomain.mockReset().mockResolvedValue(pendingView)
  mocks.checkDomain.mockReset().mockResolvedValue(pendingView)
  mocks.testSend.mockReset().mockResolvedValue({
    message: 'テストメールを送信しました。',
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'execCommand')
})

describe('EmailSenderSettingsPanel', () => {
  test('保存した差出人メールと差出人名を応答値で再表示する', async () => {
    const saved = {
      ...pendingView,
      senderEmail: 'support@example.com',
      senderName: '受付係',
    }
    mocks.save.mockResolvedValueOnce(saved)
    render(<EmailSenderSettingsPanel accountId="account-1" />)

    const email = await screen.findByLabelText('差出人メールアドレス')
    expect((email as HTMLInputElement).value).toBe('notice@example.com')
    fireEvent.change(email, { target: { value: ' support@example.com ' } })
    fireEvent.change(screen.getByLabelText('差出人名（任意）'), {
      target: { value: ' 受付係 ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '差出人を保存' }))

    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('account-1', {
      senderEmail: 'support@example.com',
      senderName: '受付係',
    }))
    await waitFor(() => {
      expect((screen.getByLabelText('差出人メールアドレス') as HTMLInputElement).value)
        .toBe('support@example.com')
      expect((screen.getByLabelText('差出人名（任意）') as HTMLInputElement).value)
        .toBe('受付係')
    })
    expect(screen.getByRole('status').textContent).toContain('保存しました')
  })

  test('空欄は既定差出人へ戻す null として保存でき、不正なメール形式は保存しない', async () => {
    mocks.get.mockResolvedValueOnce(emptyView)
    mocks.save.mockResolvedValueOnce(emptyView)
    render(<EmailSenderSettingsPanel accountId="account-1" />)

    const email = await screen.findByLabelText('差出人メールアドレス')
    fireEvent.change(email, { target: { value: 'not-an-email' } })
    expect((screen.getByRole('button', { name: '差出人を保存' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect(screen.getByText('メールアドレスの形で入力してください。')).toBeTruthy()
    expect(mocks.save).not.toHaveBeenCalled()

    fireEvent.change(email, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '差出人を保存' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('account-1', {
      senderEmail: null,
      senderName: null,
    }))
  })

  test('未認証 fallback を黙らせず、指定された文言で警告する', async () => {
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('未認証のため既定の差出人で送っています')
  })

  test('ドメイン登録後に公開 DNS レコードを表示し、名前と値をコピーできる', async () => {
    mocks.get.mockResolvedValueOnce({
      ...pendingView,
      domainStatus: 'not_registered',
      dnsRecords: [],
      usingFallback: false,
    })
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    await screen.findByDisplayValue('notice@example.com')

    fireEvent.click(screen.getByRole('button', {
      name: 'ドメインを登録してDNS設定を表示',
    }))
    await waitFor(() => expect(mocks.registerDomain).toHaveBeenCalledWith('account-1'))

    expect(await screen.findByDisplayValue('send.example.com')).toBeTruthy()
    expect(screen.getByDisplayValue('v=spf1 include:amazonses.com ~all')).toBeTruthy()
    expect(screen.getByText('MX')).toBeTruthy()
    expect(screen.getByText('優先度: 10')).toBeTruthy()
    expect(document.body.textContent).not.toContain('re_account_secret')

    fireEvent.click(screen.getByRole('button', { name: 'SPF の名前をコピー' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'send.example.com',
    ))
    fireEvent.click(screen.getByRole('button', { name: 'SPF の値をコピー' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'v=spf1 include:amazonses.com ~all',
    ))
  })

  test('Clipboard APIが無い環境でもfallbackでDNS値を実コピーする', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    await screen.findByDisplayValue('send.example.com')

    fireEvent.click(screen.getByRole('button', { name: 'SPF の名前をコピー' }))

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(screen.getByRole('status').textContent).toContain('名前をコピーしました')
    expect(document.querySelector('textarea[aria-hidden="true"]')).toBeNull()
  })

  test('Resend APIキーを保存すると入力平文を消し、マスクだけを表示する', async () => {
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    const input = await screen.findByLabelText('Resend APIキー')
    expect((input as HTMLInputElement).type).toBe('password')

    fireEvent.change(input, { target: { value: 're_account_secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'APIキーを保存' }))

    await waitFor(() => expect(mocks.setResendApiKey).toHaveBeenCalledWith(
      'account-1',
      're_account_secret',
    ))
    expect((input as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).toContain('********')
    expect(document.body.textContent).not.toContain('re_account_secret')
  })

  test('保存済みResend APIキーを選択中アカウントから削除する', async () => {
    mocks.get.mockResolvedValueOnce({
      ...pendingView,
      resendApiKeyMasked: '********',
    })
    mocks.setResendApiKey.mockResolvedValueOnce({
      ...pendingView,
      resendApiKeyMasked: null,
    })
    render(<EmailSenderSettingsPanel accountId="account-2" />)
    await screen.findByText('********')

    fireEvent.click(screen.getByRole('button', { name: '保存済みAPIキーを削除' }))

    await waitFor(() => expect(mocks.setResendApiKey).toHaveBeenCalledWith(
      'account-2',
      null,
    ))
    expect(screen.getByText(/未設定.*共通キー/)).toBeTruthy()
  })

  test('Resend作成手順をポップアップで無料登録から貼付まで説明する', async () => {
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    await screen.findByDisplayValue('notice@example.com')

    fireEvent.click(screen.getByRole('button', {
      name: 'Resendアカウント作成手順を開く',
    }))
    const dialog = screen.getByRole('dialog', { name: 'Resendアカウント作成手順' })
    expect(dialog.textContent).toContain('無料登録')
    expect(dialog.textContent).toContain('APIキーを発行')
    expect(dialog.textContent).toContain('Full access')
    expect(dialog.textContent).toContain('貼り付け')

    fireEvent.click(screen.getByRole('button', { name: '手順を閉じる' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('保存済み差出人へのテスト送信結果を成功・失敗理由で表示する', async () => {
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    await screen.findByDisplayValue('notice@example.com')

    fireEvent.click(screen.getByRole('button', { name: '自分宛にテスト送信' }))
    await waitFor(() => expect(mocks.testSend).toHaveBeenCalledWith('account-1'))
    expect(screen.getByRole('status').textContent).toContain('テストメールを送信しました')

    mocks.testSend.mockRejectedValueOnce({
      body: { error: 'テストメールを送信できませんでした（理由: resend_http_422）' },
    })
    fireEvent.click(screen.getByRole('button', { name: '自分宛にテスト送信' }))
    const failure = await screen.findByText(/resend_http_422/)
    expect(failure.getAttribute('role')).toBe('alert')
  })

  test('番号つき日本語手順に貼り付け先と反映待ちを説明する', async () => {
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    await screen.findByDisplayValue('notice@example.com')

    const guide = screen.getByTestId('email-sender-dns-guide')
    expect(guide.textContent).toContain('1.')
    expect(guide.textContent).toContain('ドメインを管理しているサービス')
    expect(guide.textContent).toContain('名前')
    expect(guide.textContent).toContain('値')
    expect(guide.textContent).toContain('反映には時間がかかる')
    expect(guide.textContent).toContain('認証状態を確認')
  })

  test('確認ボタンで pending から verified に更新する', async () => {
    mocks.checkDomain.mockResolvedValueOnce({
      ...pendingView,
      domainStatus: 'verified',
      usingFallback: false,
    })
    render(<EmailSenderSettingsPanel accountId="account-1" />)
    expect((await screen.findByTestId('email-sender-domain-status')).textContent)
      .toContain('認証待ち')

    fireEvent.click(screen.getByRole('button', { name: '認証状態を確認' }))
    await waitFor(() => expect(mocks.checkDomain).toHaveBeenCalledWith('account-1'))
    expect(screen.getByTestId('email-sender-domain-status').textContent).toContain('認証済み')
    expect(screen.queryByText('未認証のため既定の差出人で送っています')).toBeNull()
  })

  test('登録直後の not_started でも resendDomainId があれば認証確認できる', async () => {
    mocks.get.mockResolvedValueOnce({
      ...pendingView,
      domainStatus: 'not_started',
      dnsRecords: [],
    })
    mocks.checkDomain.mockResolvedValueOnce({
      ...pendingView,
      domainStatus: 'pending',
    })
    render(<EmailSenderSettingsPanel accountId="account-1" />)

    expect((await screen.findByTestId('email-sender-domain-status')).textContent)
      .toContain('認証待ち')
    const checkButton = screen.getByRole('button', { name: '認証状態を確認' })
    expect((checkButton as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(checkButton)
    await waitFor(() => expect(mocks.checkDomain).toHaveBeenCalledWith('account-1'))
  })

  test('アカウント変更時に入力をリセットし、古いアカウントの遅い応答を捨てる', async () => {
    let resolveOld!: (value: typeof pendingView) => void
    mocks.get.mockImplementation((accountId: string) => {
      if (accountId === 'account-old') {
        return new Promise((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve({
        ...pendingView,
        senderEmail: 'new@example.net',
        senderDomain: 'example.net',
      })
    })
    const view = render(<EmailSenderSettingsPanel accountId="account-old" />)
    view.rerender(<EmailSenderSettingsPanel accountId="account-new" />)

    expect(await screen.findByDisplayValue('new@example.net')).toBeTruthy()
    resolveOld(pendingView)
    await Promise.resolve()
    expect(screen.queryByDisplayValue('notice@example.com')).toBeNull()
    expect(screen.getByDisplayValue('new@example.net')).toBeTruthy()
  })

  test('A→B→A切替後に返った古いAの保存応答を現在のAへ適用しない', async () => {
    let resolveOldSave!: (value: typeof pendingView) => void
    mocks.get.mockImplementation((accountId: string) => Promise.resolve({
      ...pendingView,
      senderEmail: accountId === 'account-b' ? 'b@example.net' : 'current-a@example.com',
      senderDomain: accountId === 'account-b' ? 'example.net' : 'example.com',
    }))
    const oldSave = new Promise<typeof pendingView>((resolve) => {
      resolveOldSave = resolve
    })
    mocks.save.mockImplementationOnce(() => oldSave)

    const view = render(<EmailSenderSettingsPanel accountId="account-a" />)
    const email = await screen.findByDisplayValue('current-a@example.com')
    fireEvent.change(email, { target: { value: 'stale-a@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '差出人を保存' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())

    view.rerender(<EmailSenderSettingsPanel accountId="account-b" />)
    expect(await screen.findByDisplayValue('b@example.net')).toBeTruthy()
    view.rerender(<EmailSenderSettingsPanel accountId="account-a" />)
    expect(await screen.findByDisplayValue('current-a@example.com')).toBeTruthy()

    await act(async () => {
      resolveOldSave({ ...pendingView, senderEmail: 'stale-a@example.com' })
      await oldSave
    })
    expect(screen.queryByDisplayValue('stale-a@example.com')).toBeNull()
    expect(screen.getByDisplayValue('current-a@example.com')).toBeTruthy()
  })
})
