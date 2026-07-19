import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const BASE = 'https://worker.example.test';
const captured: Array<{ url: string; method: string; body: unknown }> = [];

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
});

beforeEach(() => {
  captured.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: [] }),
    } as unknown as Response;
  }));
});

afterEach(() => vi.unstubAllGlobals());

async function loadApi() {
  return (await import('./api')).api;
}

describe('friendFieldDefinitions API client', () => {
  test('一覧は tenant-global endpoint を query 無しで取得する', async () => {
    const api = await loadApi();
    await api.friendFieldDefinitions.list();
    expect(captured[0]).toMatchObject({ url: `${BASE}/api/friend-field-definitions`, method: 'GET' });
  });

  test('作成・更新・削除は worker CRUD と同じ method/body を送る', async () => {
    const api = await loadApi();
    const create = { name: '入金確認', defaultValue: '未', displayOrder: 1, isActive: true };
    await api.friendFieldDefinitions.create(create);
    await api.friendFieldDefinitions.update('def/1', { defaultValue: '保留', isActive: false });
    await api.friendFieldDefinitions.delete('def/1');

    expect(captured).toEqual([
      { url: `${BASE}/api/friend-field-definitions`, method: 'POST', body: create },
      {
        url: `${BASE}/api/friend-field-definitions/def%2F1`,
        method: 'PATCH',
        body: { defaultValue: '保留', isActive: false },
      },
      { url: `${BASE}/api/friend-field-definitions/def%2F1`, method: 'DELETE', body: undefined },
    ]);
  });
});
