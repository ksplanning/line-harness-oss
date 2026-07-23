import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', () => ({
  fetchApi: (...args: unknown[]) => fetchApiMock(...args),
}))

import {
  staffNotificationSettingsApi,
  type StaffNotificationDestinationInput,
  type StaffNotificationDestinationView,
} from './staff-notification-settings-api'

const destination: StaffNotificationDestinationView = {
  id: 'destination/1',
  label: '受付チーム',
  channelType: 'chatwork',
  notifyInquiry: true,
  notifyFormSubmission: false,
  notifyAutoReply: false,
  enabled: true,
  config: {
    roomId: 'room-1',
    apiToken: '********',
  },
  unsupported: false,
  setupState: null,
}

const input: StaffNotificationDestinationInput = {
  lineAccountId: 'account/1',
  label: '受付チーム',
  channelType: 'chatwork',
  notifyInquiry: true,
  notifyFormSubmission: false,
  notifyAutoReply: false,
  enabled: true,
  config: {
    roomId: 'room-1',
    apiToken: 'TOKEN_INPUT_ONLY',
  },
}

beforeEach(() => fetchApiMock.mockReset())

describe('staffNotificationSettingsApi', () => {
  test('schema-driven UI用の安全なchannel catalogを取得する', async () => {
    const channels = [{
      channelType: 'slack',
      label: 'Slack',
      configFields: [{
        key: 'botToken',
        label: 'Bot token',
        inputType: 'secret',
        required: true,
        maxLength: 100,
      }],
      capabilities: { testSend: true, setupKind: 'none' },
    }]
    fetchApiMock.mockResolvedValue({ success: true, data: channels })

    await expect(staffNotificationSettingsApi.listChannels()).resolves
      .toEqual(channels)
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/staff-notification-channels',
    )
  })

  test('LINE アカウント単位で通知先を取得する', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: [destination] })

    await expect(staffNotificationSettingsApi.list('account/1')).resolves.toEqual([
      destination,
    ])
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/staff-notification-destinations?lineAccountId=account%2F1',
    )
  })

  test('通知先の作成・編集・削除を契約どおり送る', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: destination })
      .mockResolvedValueOnce({ success: true, data: destination })
      .mockResolvedValueOnce({ success: true, data: null })

    await expect(staffNotificationSettingsApi.create(input)).resolves.toEqual(destination)
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/staff-notification-destinations',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )

    await expect(
      staffNotificationSettingsApi.update('destination/1', {
        ...input,
        config: { ...input.config, apiToken: '' },
      }),
    ).resolves.toEqual(destination)
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/staff-notification-destinations/destination%2F1',
      {
        method: 'PUT',
        body: JSON.stringify({
          ...input,
          config: { ...input.config, apiToken: '' },
        }),
      },
    )

    await expect(
      staffNotificationSettingsApi.remove('account/1', 'destination/1'),
    ).resolves.toBeUndefined()
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      3,
      '/api/staff-notification-destinations/destination%2F1?lineAccountId=account%2F1',
      { method: 'DELETE' },
    )
  })

  test('テスト送信・LINE コード発行・LINE 解除を契約どおり送る', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({
        success: true,
        data: { code: 'LINK_CODE', expiresAt: '2026-07-23T12:00:00.000Z' },
      })
      .mockResolvedValueOnce({ success: true, data: null })

    await expect(
      staffNotificationSettingsApi.sendTest('account/1', 'destination/1'),
    ).resolves.toBeUndefined()
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/staff-notification-destinations/destination%2F1/test',
      {
        method: 'POST',
        body: JSON.stringify({ lineAccountId: 'account/1' }),
      },
    )

    await expect(
      staffNotificationSettingsApi.issueLineLinkCode('account/1', 'destination/1'),
    ).resolves.toEqual({
      code: 'LINK_CODE',
      expiresAt: '2026-07-23T12:00:00.000Z',
    })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/staff-notification-destinations/destination%2F1/line-link-code',
      {
        method: 'POST',
        body: JSON.stringify({ lineAccountId: 'account/1' }),
      },
    )

    await expect(
      staffNotificationSettingsApi.unlinkLine('account/1', 'destination/1'),
    ).resolves.toBeUndefined()
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      3,
      '/api/staff-notification-destinations/destination%2F1/line-link?lineAccountId=account%2F1',
      { method: 'DELETE' },
    )
  })
})
