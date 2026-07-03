/**
 * campaigns route (F2 G3 C2) — CRUD + 配信紐付け + 集計 + account-scope guard + 送信ゼロ。
 *
 *   - POST 作成 (201) → GET 一覧に出る (account-scoped)
 *   - POST name 空を 400
 *   - PATCH rename / DELETE
 *   - 存在しない campaign は 404
 *   - 4 verb account-scope guard: 別 account の campaign は GET(list)/PATCH/DELETE で見えない/403
 *   - 配信紐付け (POST /:id/broadcasts) は同 account の配信のみ
 *   - 集計 (GET /:id) が紐付き配信のまとめを返す
 *   - LINE Messaging API への outbound ゼロ (送信ゼロの内部証明)
 *   - 未認証は 401
 *
 * db helper は in-memory Map で mock (実 SQL は packages/db の campaigns.test.ts)。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const hoisted = vi.hoisted(() => ({
  campaigns: new Map<string, Record<string, unknown>>(),
  // broadcastId → { accountId, campaignId }
  broadcasts: new Map<string, { accountId: string; campaignId: string | null }>(),
  fetchCalls: [] as string[],
}));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  let seq = 0;
  return {
    ...actual,
    listCampaigns: vi.fn(async (_db: unknown, accountId: string) =>
      [...hoisted.campaigns.values()].filter((c) => c.account_id === accountId),
    ),
    getCampaignById: vi.fn(async (_db: unknown, id: string) => hoisted.campaigns.get(id) ?? null),
    createCampaign: vi.fn(async (_db: unknown, input: { accountId: string; name: string }) => {
      const id = `c-${++seq}`;
      const row = { id, account_id: input.accountId, name: input.name, created_at: 'now', updated_at: 'now' };
      hoisted.campaigns.set(id, row);
      return row;
    }),
    renameCampaign: vi.fn(async (_db: unknown, id: string, name: string) => {
      const row = hoisted.campaigns.get(id);
      if (!row) return null;
      row.name = name;
      return row;
    }),
    deleteCampaign: vi.fn(async (_db: unknown, id: string) => {
      return hoisted.campaigns.delete(id);
    }),
    linkBroadcastToCampaign: vi.fn(async (_db: unknown, broadcastId: string, campaignId: string | null, accountId: string) => {
      const b = hoisted.broadcasts.get(broadcastId);
      if (!b || b.accountId !== accountId) return false; // 別 account の配信は動かさない
      b.campaignId = campaignId;
      return true;
    }),
    getCampaignAggregate: vi.fn(async (_db: unknown, campaignId: string) => {
      const linked = [...hoisted.broadcasts.entries()].filter(([, b]) => b.campaignId === campaignId);
      return {
        broadcastCount: linked.length,
        totalTarget: linked.length * 100,
        totalOpened: linked.length > 0 ? linked.length * 25 : null,
        totalClicked: linked.length > 0 ? linked.length * 5 : null,
        broadcasts: linked.map(([id]) => ({ broadcastId: id, title: 'B', sentAt: null, targetCount: 100, opened: 25, clicked: 5 })),
      };
    }),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { campaigns } from './campaigns.js';

const mockDb = {
  prepare() {
    return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } };
  },
} as unknown as D1Database;

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: mockDb, API_KEY: 'test-key' };
    await next();
  });
  app.use('*', authMiddleware);
  app.route('/', campaigns);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' } };

beforeEach(() => {
  hoisted.campaigns.clear();
  hoisted.broadcasts.clear();
  hoisted.fetchCalls.length = 0;
  // fetch を監視 (LINE API outbound ゼロを assert)。
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    hoisted.fetchCalls.push(String(url));
    return new Response('{}', { status: 200 });
  }));
});

async function req(path: string, init?: RequestInit) {
  return setupApp().request(path, { ...AUTH, ...init });
}

describe('campaigns CRUD (account-scoped)', () => {
  test('POST creates (201) and GET lists it for that account only', async () => {
    const post = await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: '春の販促' }) });
    expect(post.status).toBe(201);
    const list = await req('/api/campaigns?accountId=acc-1');
    const body = await list.json<{ data: Array<{ name: string }> }>();
    expect(body.data.map((c) => c.name)).toEqual(['春の販促']);
    // 別 account には出ない。
    const other = await req('/api/campaigns?accountId=acc-2');
    expect((await other.json<{ data: unknown[] }>()).data).toEqual([]);
  });

  test('POST with empty name is 400', async () => {
    const res = await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: '  ' }) });
    expect(res.status).toBe(400);
  });

  test('POST without accountId is 400', async () => {
    const res = await req('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(400);
  });

  test('PATCH renames and DELETE removes (same account)', async () => {
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: '旧' }) })).json<{ data: { id: string } }>();
    const patch = await req(`/api/campaigns/${data.id}?accountId=acc-1`, { method: 'PATCH', body: JSON.stringify({ name: '新' }) });
    expect((await patch.json<{ data: { name: string } }>()).data.name).toBe('新');
    const del = await req(`/api/campaigns/${data.id}?accountId=acc-1`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(hoisted.campaigns.size).toBe(0);
  });

  test('nonexistent campaign is 404 on GET/PATCH/DELETE', async () => {
    expect((await req('/api/campaigns/nope?accountId=acc-1')).status).toBe(404);
    expect((await req('/api/campaigns/nope?accountId=acc-1', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })).status).toBe(404);
    expect((await req('/api/campaigns/nope?accountId=acc-1', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('campaigns 4-verb account-scope guard', () => {
  test('GET/PATCH/DELETE of another account campaign is rejected 403', async () => {
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).json<{ data: { id: string } }>();

    expect((await req(`/api/campaigns/${data.id}?accountId=acc-2`)).status).toBe(403);
    expect((await req(`/api/campaigns/${data.id}?accountId=acc-2`, { method: 'PATCH', body: JSON.stringify({ name: 'hijack' }) })).status).toBe(403);
    expect((await req(`/api/campaigns/${data.id}?accountId=acc-2`, { method: 'DELETE' })).status).toBe(403);
    expect(hoisted.campaigns.size).toBe(1); // 拒否されたので残る
  });

  test('missing accountId on a scoped row is rejected 403', async () => {
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).json<{ data: { id: string } }>();
    expect((await req(`/api/campaigns/${data.id}`)).status).toBe(403);
  });
});

describe('campaigns broadcast link + aggregate', () => {
  test('links a same-account broadcast and reflects it in the aggregate', async () => {
    hoisted.broadcasts.set('b-1', { accountId: 'acc-1', campaignId: null });
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'C' }) })).json<{ data: { id: string } }>();

    const link = await req(`/api/campaigns/${data.id}/broadcasts?accountId=acc-1`, { method: 'POST', body: JSON.stringify({ broadcastId: 'b-1', linked: true }) });
    expect(link.status).toBe(200);

    const detail = await req(`/api/campaigns/${data.id}?accountId=acc-1`);
    const body = await detail.json<{ data: { aggregate: { broadcastCount: number; totalTarget: number } } }>();
    expect(body.data.aggregate.broadcastCount).toBe(1);
    expect(body.data.aggregate.totalTarget).toBe(100);
  });

  test('cannot link a broadcast belonging to another account (404/400)', async () => {
    hoisted.broadcasts.set('b-2', { accountId: 'acc-2', campaignId: null });
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'C' }) })).json<{ data: { id: string } }>();
    const link = await req(`/api/campaigns/${data.id}/broadcasts?accountId=acc-1`, { method: 'POST', body: JSON.stringify({ broadcastId: 'b-2', linked: true }) });
    expect(link.status).toBe(404); // 別 account の配信は紐付けられない
  });

  test('linking to a campaign of another account is 403 (scope guard on the campaign)', async () => {
    hoisted.broadcasts.set('b-1', { accountId: 'acc-1', campaignId: null });
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'C' }) })).json<{ data: { id: string } }>();
    const link = await req(`/api/campaigns/${data.id}/broadcasts?accountId=acc-2`, { method: 'POST', body: JSON.stringify({ broadcastId: 'b-1', linked: true }) });
    expect(link.status).toBe(403);
  });
});

describe('campaigns send-zero (worker internal outbound)', () => {
  test('no LINE Messaging API fetch across CRUD + link + aggregate', async () => {
    hoisted.broadcasts.set('b-1', { accountId: 'acc-1', campaignId: null });
    const { data } = await (await req('/api/campaigns?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'C' }) })).json<{ data: { id: string } }>();
    await req(`/api/campaigns/${data.id}/broadcasts?accountId=acc-1`, { method: 'POST', body: JSON.stringify({ broadcastId: 'b-1', linked: true }) });
    await req(`/api/campaigns/${data.id}?accountId=acc-1`);
    await req(`/api/campaigns/${data.id}?accountId=acc-1`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) });
    await req(`/api/campaigns/${data.id}?accountId=acc-1`, { method: 'DELETE' });
    const lineCalls = hoisted.fetchCalls.filter((u) => /api\.line\.me|api-data\.line\.me/.test(u));
    expect(lineCalls).toEqual([]);
  });
});

describe('campaigns auth', () => {
  test('unauthenticated request is 401', async () => {
    const res = await setupApp().request('/api/campaigns?accountId=acc-1');
    expect(res.status).toBe(401);
  });
});
