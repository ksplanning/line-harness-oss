import { afterEach, describe, expect, test, vi } from 'vitest';
import { LineClient } from '@line-crm/line-sdk';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LineClient rich-menu bulk contract', () => {
  test('posts the official link and unlink payloads and accepts LINE 202 responses', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new LineClient('secret-token');

    await client.linkRichMenuToMultipleUsers(['U1', 'U2'], 'menu-1');
    await client.unlinkRichMenusFromMultipleUsers(['U1', 'U2']);

    expect(requests.map(({ url, init }) => ({
      url,
      method: init.method,
      body: JSON.parse(String(init.body)),
      authorization: (init.headers as Record<string, string>).Authorization,
    }))).toEqual([
      {
        url: 'https://api.line.me/v2/bot/richmenu/bulk/link',
        method: 'POST',
        body: { richMenuId: 'menu-1', userIds: ['U1', 'U2'] },
        authorization: 'Bearer secret-token',
      },
      {
        url: 'https://api.line.me/v2/bot/richmenu/bulk/unlink',
        method: 'POST',
        body: { userIds: ['U1', 'U2'] },
        authorization: 'Bearer secret-token',
      },
    ]);
  });

  test('rejects an oversized batch before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LineClient('secret-token');

    await expect(client.linkRichMenuToMultipleUsers(
      Array.from({ length: 501 }, (_, index) => `U${index}`),
      'menu-1',
    )).rejects.toThrow('between 1 and 500');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
