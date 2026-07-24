import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import {
  emailSenderSettingsApi,
  type EmailSenderSettingsView,
} from './email-sender-settings-api'

const view: EmailSenderSettingsView = {
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
  }],
  usingFallback: true,
}

beforeEach(() => fetchApiMock.mockReset())

describe('emailSenderSettingsApi', () => {
  test('GET/PUT は LINE アカウント単位で設定を往復する', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: view })
      .mockResolvedValueOnce({ success: true, data: { ...view, senderName: '受付係' } })

    await expect(emailSenderSettingsApi.get('account/1')).resolves.toEqual(view)
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/account-settings/email-sender?accountId=account%2F1',
    )

    await expect(emailSenderSettingsApi.save('account/1', {
      senderEmail: 'notice@example.com',
      senderName: '受付係',
    })).resolves.toEqual({ ...view, senderName: '受付係' })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/account-settings/email-sender',
      {
        method: 'PUT',
        body: JSON.stringify({
          accountId: 'account/1',
          senderEmail: 'notice@example.com',
          senderName: '受付係',
        }),
      },
    )
  })

  test('ドメイン登録と認証確認は accountId だけを POST する', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: view })
      .mockResolvedValueOnce({ success: true, data: { ...view, domainStatus: 'verified' } })

    await expect(emailSenderSettingsApi.registerDomain('account/1')).resolves.toEqual(view)
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/account-settings/email-sender/domain',
      {
        method: 'POST',
        body: JSON.stringify({ accountId: 'account/1' }),
      },
    )

    await expect(emailSenderSettingsApi.checkDomain('account/1')).resolves.toMatchObject({
      domainStatus: 'verified',
    })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/account-settings/email-sender/domain/check',
      {
        method: 'POST',
        body: JSON.stringify({ accountId: 'account/1' }),
      },
    )
  })

  test('Resend APIキーの保存・削除とテスト送信は選択中accountIdだけを送る', async () => {
    fetchApiMock
      .mockResolvedValueOnce({
        success: true,
        data: { ...view, resendApiKeyMasked: '********' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { ...view, resendApiKeyMasked: null },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { message: 'テストメールを送信しました。' },
      })

    await expect(
      emailSenderSettingsApi.setResendApiKey('account/1', 're_account_secret'),
    ).resolves.toMatchObject({ resendApiKeyMasked: '********' })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/account-settings/email-sender/resend-key',
      {
        method: 'PUT',
        body: JSON.stringify({
          accountId: 'account/1',
          resendApiKey: 're_account_secret',
        }),
      },
    )

    await expect(
      emailSenderSettingsApi.setResendApiKey('account/1', null),
    ).resolves.toMatchObject({ resendApiKeyMasked: null })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/account-settings/email-sender/resend-key',
      {
        method: 'PUT',
        body: JSON.stringify({ accountId: 'account/1', resendApiKey: null }),
      },
    )

    await expect(emailSenderSettingsApi.testSend('account/1')).resolves.toEqual({
      message: 'テストメールを送信しました。',
    })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      3,
      '/api/account-settings/email-sender/test',
      {
        method: 'POST',
        body: JSON.stringify({ accountId: 'account/1' }),
      },
    )
  })
})
