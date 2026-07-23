import type { StaffNotificationAdapter } from './types.js';
import type { StaffNotificationChannelDefinition } from './channel-definition.js';

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface ChatworkConfig {
  roomId: string;
  apiToken: string;
}

function chatworkConfig(value: Record<string, unknown>): ChatworkConfig | null {
  const roomId = typeof value.roomId === 'string' ? value.roomId.trim() : '';
  const apiToken = typeof value.apiToken === 'string' ? value.apiToken.trim() : '';
  if (!/^\d+$/.test(roomId) || !apiToken) return null;
  return { roomId, apiToken };
}

export function createChatworkStaffNotificationAdapter(
  fetcher: Fetcher = fetch,
): StaffNotificationAdapter {
  return {
    channelType: 'chatwork',
    failureCodes: [
      'chatwork_http_error',
      'chatwork_invalid_config',
      'chatwork_network_error',
    ],
    async send({ destination, text }) {
      const config = chatworkConfig(destination.config);
      if (!config) return { ok: false, errorCode: 'chatwork_invalid_config' };

      let response: Response;
      try {
        response = await fetcher(
          `https://api.chatwork.com/v2/rooms/${config.roomId}/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-ChatWorkToken': config.apiToken,
            },
            body: new URLSearchParams({ body: text }).toString(),
          },
        );
      } catch {
        return { ok: false, errorCode: 'chatwork_network_error' };
      }

      return response.ok
        ? { ok: true }
        : { ok: false, errorCode: 'chatwork_http_error' };
    },
  };
}

export const chatworkStaffNotificationAdapter =
  createChatworkStaffNotificationAdapter();

export const chatworkStaffNotificationChannel: StaffNotificationChannelDefinition = {
  channelType: 'chatwork',
  label: 'Chatwork',
  configFields: [
    {
      key: 'roomId',
      label: 'Chatwork ルームID',
      inputType: 'text',
      required: true,
      maxLength: 20,
      pattern: '^\\d+$',
    },
    {
      key: 'apiToken',
      label: 'Chatwork APIトークン',
      inputType: 'secret',
      required: true,
      maxLength: 512,
      placeholder: 'Chatwork で発行した API トークン',
    },
  ],
  capabilities: {
    testSend: true,
    setupKind: 'none',
  },
  adapter: chatworkStaffNotificationAdapter,
};
