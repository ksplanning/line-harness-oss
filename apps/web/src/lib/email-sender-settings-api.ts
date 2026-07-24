import { fetchApi } from './api'

export interface EmailSenderDnsRecord {
  record: string | null
  type: string
  name: string
  value: string
  ttl: string | null
  status: string | null
  priority: number | null
}

export interface EmailSenderSettingsView {
  senderEmail: string | null
  senderName: string | null
  senderDomain: string | null
  resendApiKeyMasked: string | null
  resendDomainId: string | null
  domainStatus: string
  dnsRecords: EmailSenderDnsRecord[]
  usingFallback: boolean
}

export interface SaveEmailSenderSettingsInput {
  senderEmail: string | null
  senderName: string | null
}

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

const BASE_PATH = '/api/account-settings/email-sender'

export const emailSenderSettingsApi = {
  async get(accountId: string): Promise<EmailSenderSettingsView> {
    return (
      await fetchApi<Envelope<EmailSenderSettingsView>>(
        `${BASE_PATH}?accountId=${encodeURIComponent(accountId)}`,
      )
    ).data
  },

  async save(
    accountId: string,
    input: SaveEmailSenderSettingsInput,
  ): Promise<EmailSenderSettingsView> {
    return (
      await fetchApi<Envelope<EmailSenderSettingsView>>(BASE_PATH, {
        method: 'PUT',
        body: JSON.stringify({ accountId, ...input }),
      })
    ).data
  },

  async setResendApiKey(
    accountId: string,
    resendApiKey: string | null,
  ): Promise<EmailSenderSettingsView> {
    return (
      await fetchApi<Envelope<EmailSenderSettingsView>>(`${BASE_PATH}/resend-key`, {
        method: 'PUT',
        body: JSON.stringify({ accountId, resendApiKey }),
      })
    ).data
  },

  async registerDomain(accountId: string): Promise<EmailSenderSettingsView> {
    return (
      await fetchApi<Envelope<EmailSenderSettingsView>>(`${BASE_PATH}/domain`, {
        method: 'POST',
        body: JSON.stringify({ accountId }),
      })
    ).data
  },

  async checkDomain(accountId: string): Promise<EmailSenderSettingsView> {
    return (
      await fetchApi<Envelope<EmailSenderSettingsView>>(`${BASE_PATH}/domain/check`, {
        method: 'POST',
        body: JSON.stringify({ accountId }),
      })
    ).data
  },

  async testSend(accountId: string, recipientEmail: string): Promise<{ message: string }> {
    return (
      await fetchApi<Envelope<{ message: string }>>(`${BASE_PATH}/test`, {
        method: 'POST',
        body: JSON.stringify({ accountId, recipientEmail }),
      })
    ).data
  },
}
