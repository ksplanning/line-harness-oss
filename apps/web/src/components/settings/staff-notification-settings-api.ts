import { fetchApi } from '@/lib/api'

export type StaffNotificationChannelType = string

export interface StaffNotificationConfigField {
  key: string
  label: string
  inputType: 'text' | 'secret'
  required: boolean
  maxLength: number
  pattern?: string
  placeholder?: string
}

export interface StaffNotificationChannelDefinition {
  channelType: StaffNotificationChannelType
  label: string
  configFields: StaffNotificationConfigField[]
  capabilities: {
    testSend: boolean
    setupKind: 'none' | 'line_one_time'
  }
  notice?: string
}

export interface StaffNotificationDestinationInput {
  lineAccountId: string
  label: string
  channelType: StaffNotificationChannelType
  notifyInquiry: boolean
  notifyFormSubmission: boolean
  enabled: boolean
  config: Record<string, string>
}

export interface StaffNotificationDestinationView {
  id: string
  label: string
  channelType: StaffNotificationChannelType
  notifyInquiry: boolean
  notifyFormSubmission: boolean
  enabled: boolean
  config: Record<string, string>
  unsupported: boolean
  setupState: {
    kind: 'line_one_time'
    linked: boolean
  } | null
}

export interface StaffNotificationLineLinkCode {
  code: string
  expiresAt: string
}

interface ApiEnvelope<T> {
  success: true
  data: T
}

const BASE_PATH = '/api/staff-notification-destinations'

async function requestData<T>(
  path: string,
  init?: { method: string; body?: string },
): Promise<T> {
  const response = await (init ? fetchApi(path, init) : fetchApi(path)) as ApiEnvelope<T>
  return response.data
}

export const staffNotificationSettingsApi = {
  listChannels(): Promise<StaffNotificationChannelDefinition[]> {
    return requestData('/api/staff-notification-channels')
  },

  list(lineAccountId: string): Promise<StaffNotificationDestinationView[]> {
    return requestData(
      `${BASE_PATH}?lineAccountId=${encodeURIComponent(lineAccountId)}`,
    )
  },

  create(
    input: StaffNotificationDestinationInput,
  ): Promise<StaffNotificationDestinationView> {
    return requestData(BASE_PATH, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  update(
    id: string,
    input: StaffNotificationDestinationInput,
  ): Promise<StaffNotificationDestinationView> {
    return requestData(`${BASE_PATH}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },

  async remove(lineAccountId: string, id: string): Promise<void> {
    await requestData<null>(
      `${BASE_PATH}/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'DELETE' },
    )
  },

  async sendTest(lineAccountId: string, id: string): Promise<void> {
    await requestData<null>(`${BASE_PATH}/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: JSON.stringify({ lineAccountId }),
    })
  },

  issueLineLinkCode(
    lineAccountId: string,
    id: string,
  ): Promise<StaffNotificationLineLinkCode> {
    return requestData(`${BASE_PATH}/${encodeURIComponent(id)}/line-link-code`, {
      method: 'POST',
      body: JSON.stringify({ lineAccountId }),
    })
  },

  async unlinkLine(lineAccountId: string, id: string): Promise<void> {
    await requestData<null>(
      `${BASE_PATH}/${encodeURIComponent(id)}/line-link?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'DELETE' },
    )
  },
}
