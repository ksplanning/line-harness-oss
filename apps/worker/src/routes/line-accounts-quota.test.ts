import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getLineAccounts: vi.fn(),
  getLineAccountById: vi.fn(),
  createLineAccount: vi.fn(),
  updateLineAccount: vi.fn(),
  updateLineAccountFields: vi.fn(),
  updateLineAccountOrder: vi.fn(),
  deleteLineAccount: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({ LineClient: vi.fn() }));

const { lineAccounts } = await import('./line-accounts.js');

type TestEnv = {
  Variables: { staff: { id: string; role: 'owner' } };
  Bindings: { DB: D1Database };
};

function app() {
  const instance = new Hono<TestEnv>();
  instance.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', role: 'owner' });
    c.env = { DB: {} as D1Database };
    await next();
  });
  instance.route('/', lineAccounts);
  return instance;
}

function account(id: string) {
  return { id, channel_access_token: `token-${id}` };
}

function lineResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  dbMocks.getLineAccountById.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/line-accounts/:id/quota', () => {
  test('LINE公式の上限と使用数から推定プラン・最大・残りを返す', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce(account('limited'));
    vi.mocked(fetch)
      .mockResolvedValueOnce(lineResponse({ type: 'limited', value: 5000 }))
      .mockResolvedValueOnce(lineResponse({ totalUsage: 1234 }));

    const res = await app().request('/api/line-accounts/limited/quota');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        plan_label: 'ライトプラン相当（推定）',
        limit: 5000,
        used: 1234,
        remaining: 3766,
        type: 'limited',
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.line.me/v2/bot/message/quota', {
      headers: { Authorization: 'Bearer token-limited' },
    });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.line.me/v2/bot/message/quota/consumption', {
      headers: { Authorization: 'Bearer token-limited' },
    });
  });

  test('type=none は最大と残りを無制限として返す', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce(account('unlimited'));
    vi.mocked(fetch)
      .mockResolvedValueOnce(lineResponse({ type: 'none' }))
      .mockResolvedValueOnce(lineResponse({ totalUsage: 88 }));

    const res = await app().request('/api/line-accounts/unlimited/quota');
    const body = await res.json() as { data: Record<string, unknown> };

    expect(body.data).toEqual({
      plan_label: '無制限（プラン名は推定できません）',
      limit: null,
      used: 88,
      remaining: null,
      type: 'none',
    });
  });

  test('5分以内の再取得は account ごとのキャッシュを返しLINE APIを再度呼ばない', async () => {
    dbMocks.getLineAccountById.mockResolvedValue(account('cached'));
    vi.mocked(fetch)
      .mockResolvedValueOnce(lineResponse({ type: 'limited', value: 200 }))
      .mockResolvedValueOnce(lineResponse({ totalUsage: 10 }));

    const first = await app().request('/api/line-accounts/cached/quota');
    const second = await app().request('/api/line-accounts/cached/quota');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('キャッシュ期限後のLINE API失敗は前回値と日常語の案内を返す', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    dbMocks.getLineAccountById.mockResolvedValue(account('fallback'));
    vi.mocked(fetch)
      .mockResolvedValueOnce(lineResponse({ type: 'limited', value: 200 }))
      .mockResolvedValueOnce(lineResponse({ totalUsage: 50 }));

    await app().request('/api/line-accounts/fallback/quota');
    now += 5 * 60 * 1000 + 1;
    vi.mocked(fetch).mockRejectedValue(new Error('LINE unavailable'));

    const res = await app().request('/api/line-accounts/fallback/quota');
    const body = await res.json() as {
      success: boolean;
      data: { remaining: number; stale: boolean; message: string };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.remaining).toBe(150);
    expect(body.data.stale).toBe(true);
    expect(body.data.message).toBe('LINEの送信数を取得できませんでした。前回の情報を表示しています。');
  });
});
