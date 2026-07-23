import { getLineAccountById } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { StaffNotificationChannelDefinition } from './channel-definition.js';
import type { StaffNotificationAdapter } from './types.js';

export const lineStaffNotificationAdapter: StaffNotificationAdapter = {
  channelType: 'line',
  failureCodes: [
    'line_account_lookup_failed',
    'line_account_unavailable',
    'line_not_linked',
    'line_push_failed',
  ],
  async send({ env, destination, text }) {
    const lineUserId = destination.lineUserId?.trim();
    if (!lineUserId) return { ok: false, errorCode: 'line_not_linked' };

    let account: Awaited<ReturnType<typeof getLineAccountById>>;
    try {
      account = await getLineAccountById(env.DB, destination.lineAccountId);
    } catch {
      return { ok: false, errorCode: 'line_account_lookup_failed' };
    }
    if (
      !account
      || account.is_active !== 1
      || !account.channel_access_token?.trim()
    ) {
      return { ok: false, errorCode: 'line_account_unavailable' };
    }

    try {
      const client = new LineClient(account.channel_access_token);
      await client.pushMessage(lineUserId, [{ type: 'text', text }]);
      return { ok: true };
    } catch {
      return { ok: false, errorCode: 'line_push_failed' };
    }
  },
};

export const lineStaffNotificationChannel: StaffNotificationChannelDefinition = {
  channelType: 'line',
  label: 'LINE',
  configFields: [],
  capabilities: {
    testSend: false,
    setupKind: 'line_one_time',
  },
  notice: 'LINE通知は配信数を消費します。',
  adapter: lineStaffNotificationAdapter,
};
