import { describe, expect, test, vi } from 'vitest';
import {
  normalizeStaffNotificationChannelConfig,
  publicStaffNotificationChannelConfig,
  publicStaffNotificationChannelDefinition,
  type StaffNotificationChannelDefinition,
} from './channel-definition.js';

const slackDefinition: StaffNotificationChannelDefinition = {
  channelType: 'slack',
  label: 'Slack',
  configFields: [
    {
      key: 'channelId',
      label: 'Channel ID',
      inputType: 'text',
      required: true,
      maxLength: 30,
      pattern: '^C[A-Z0-9]+$',
    },
    {
      key: 'botToken',
      label: 'Bot token',
      inputType: 'secret',
      required: true,
      maxLength: 100,
    },
  ],
  capabilities: {
    testSend: true,
    setupKind: 'none',
  },
  adapter: {
    channelType: 'slack',
    failureCodes: [],
    send: vi.fn(async () => ({ ok: true as const })),
  },
};

describe('staff notification channel definition', () => {
  test('a new channel gets generic validation, secret preservation, and masked public metadata', () => {
    expect(normalizeStaffNotificationChannelConfig(
      slackDefinition,
      { channelId: ' C012ABC ', botToken: ' secret-token ' },
    )).toEqual({
      channelId: 'C012ABC',
      botToken: 'secret-token',
    });

    expect(normalizeStaffNotificationChannelConfig(
      slackDefinition,
      { channelId: 'C999XYZ', botToken: '' },
      { channelId: 'C012ABC', botToken: 'stored-token' },
    )).toEqual({
      channelId: 'C999XYZ',
      botToken: 'stored-token',
    });

    expect(normalizeStaffNotificationChannelConfig(
      slackDefinition,
      { channelId: 'not-a-channel', botToken: 'token' },
    )).toBeNull();
    expect(normalizeStaffNotificationChannelConfig(
      slackDefinition,
      { channelId: 'C012ABC', botToken: 'token', unexpected: 'value' },
    )).toBeNull();

    expect(publicStaffNotificationChannelConfig(
      slackDefinition,
      { channelId: 'C012ABC', botToken: 'stored-token' },
    )).toEqual({
      channelId: 'C012ABC',
      botToken: '********',
    });

    expect(publicStaffNotificationChannelDefinition(slackDefinition)).toEqual({
      channelType: 'slack',
      label: 'Slack',
      configFields: slackDefinition.configFields,
      capabilities: slackDefinition.capabilities,
    });
    expect(JSON.stringify(publicStaffNotificationChannelDefinition(slackDefinition)))
      .not.toContain('stored-token');
  });
});
