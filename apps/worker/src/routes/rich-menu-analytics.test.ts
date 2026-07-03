/**
 * rich-menu-analytics route (F2 G58 C4) — postback系タップ集計 (read-only・account guard・送信ゼロ)。
 *
 *   - GET /api/rich-menu-analytics/taps?accountId=&groupId=&startDate=&endDate= が集計を返す
 *   - accountId / groupId / 期間の必須チェック (400)
 *   - group が別 account に属する場合は 403 (account を跨がない)
 *   - LINE Messaging API への outbound ゼロ
 *   - 未認証は 401
 *
 * 集計正しさ (二重計上/JST/一意帰属/衝突) は packages/db の rich-menu-analytics.test.ts が担保。
 * ここでは route の guard / 必須 / 配線 / 送信ゼロを assert。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const hoisted = vi.hoisted(() => ({
  // groupId → accountId (group が属する account)
  groups: new Map<string, string>(),
  fetchCalls: [] as string[],
  lastAnalyticsArgs: null as null | { groupId: string; accountId: string; startDate: string; endDate: string },
}));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getRichMenuGroupById: vi.fn(async (_db: unknown, groupId: string) => {
      const accountId = hoisted.groups.get(groupId);
      return accountId ? { id: groupId, account_id: accountId, name: 'G', size: 'large', status: 'draft' } : null;
    }),
    getRichMenuTapAnalytics: vi.fn(async (_db: unknown, input: { groupId: string; accountId: string; startDate: string; endDate: string }) => {
      hoisted.lastAnalyticsArgs = input;
      return {
        areas: [{ areaId: 'ar-1', pageId: 'pg', boundsX: 0, boundsY: 0, boundsWidth: 100, boundsHeight: 100, actionType: 'postback', postbackData: 'buy', count: 5, measurable: true, unmeasurableReason: null }],
        byPostbackData: [{ data: 'buy', count: 5 }],
        unattributedCount: 0,
        totalTaps: 5,
      };
    }),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { richMenuAnalytics } from './rich-menu-analytics.js';

const mockDb = { prepare() { return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } }; } } as unknown as D1Database;

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { (c.env as unknown) = { DB: mockDb, API_KEY: 'test-key' }; await next(); });
  app.use('*', authMiddleware);
  app.route('/', richMenuAnalytics);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' } };

beforeEach(() => {
  hoisted.groups.clear();
  hoisted.fetchCalls.length = 0;
  hoisted.lastAnalyticsArgs = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { hoisted.fetchCalls.push(String(url)); return new Response('{}', { status: 200 }); }));
});

async function req(path: string) {
  return setupApp().request(path, AUTH);
}

const P = (q: Record<string, string>) => '/api/rich-menu-analytics/taps?' + new URLSearchParams(q).toString();

describe('rich-menu-analytics taps', () => {
  test('returns tap analytics for a group owned by the account', async () => {
    hoisted.groups.set('g-1', 'acc-1');
    const res = await req(P({ accountId: 'acc-1', groupId: 'g-1', startDate: '2026-03-01', endDate: '2026-03-31' }));
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { totalTaps: number; areas: unknown[] } }>();
    expect(body.data.totalTaps).toBe(5);
    expect(hoisted.lastAnalyticsArgs).toEqual({ groupId: 'g-1', accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-31' });
  });

  test('400 when accountId is missing', async () => {
    expect((await req(P({ groupId: 'g-1', startDate: '2026-03-01', endDate: '2026-03-31' }))).status).toBe(400);
  });

  test('400 when groupId is missing', async () => {
    expect((await req(P({ accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-31' }))).status).toBe(400);
  });

  test('400 when startDate/endDate missing or malformed', async () => {
    hoisted.groups.set('g-1', 'acc-1');
    expect((await req(P({ accountId: 'acc-1', groupId: 'g-1', endDate: '2026-03-31' }))).status).toBe(400);
    expect((await req(P({ accountId: 'acc-1', groupId: 'g-1', startDate: 'bad', endDate: '2026-03-31' }))).status).toBe(400);
  });

  test('404 when the group does not exist', async () => {
    expect((await req(P({ accountId: 'acc-1', groupId: 'nope', startDate: '2026-03-01', endDate: '2026-03-31' }))).status).toBe(404);
  });

  test('403 when the group belongs to another account (no cross-account)', async () => {
    hoisted.groups.set('g-1', 'acc-2'); // group は acc-2 のもの
    const res = await req(P({ accountId: 'acc-1', groupId: 'g-1', startDate: '2026-03-01', endDate: '2026-03-31' }));
    expect(res.status).toBe(403);
    // 集計関数は呼ばれない (guard で止まる)。
    expect(hoisted.lastAnalyticsArgs).toBeNull();
  });

  test('no LINE Messaging API fetch (read-only, send-zero)', async () => {
    hoisted.groups.set('g-1', 'acc-1');
    await req(P({ accountId: 'acc-1', groupId: 'g-1', startDate: '2026-03-01', endDate: '2026-03-31' }));
    expect(hoisted.fetchCalls.filter((u) => /api\.line\.me|api-data\.line\.me/.test(u))).toEqual([]);
  });

  test('unauthenticated request is 401', async () => {
    hoisted.groups.set('g-1', 'acc-1');
    expect((await setupApp().request(P({ accountId: 'acc-1', groupId: 'g-1', startDate: '2026-03-01', endDate: '2026-03-31' }))).status).toBe(401);
  });
});
