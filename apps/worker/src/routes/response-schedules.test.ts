/**
 * GET/PUT /api/response-schedules (G28 C5) — server 検証 + upsert 配線。
 *
 *   - GET が既定 (is_enabled=false) / 保存値を返す
 *   - PUT が upsert し、二度目は同一 account を更新
 *   - 不正 weeklyHours (day=7 / '25:00' / HH:MM 非準拠) / 不正 outsideHoursMode を 400
 *   - away_message モードで文面必須 (空は 400)
 *   - 未認証は 401 (client+server 二重検証の server 側)
 *
 * db helper (getResponseSchedule/upsertResponseSchedule) は in-memory Map で mock
 * (実 SQL round-trip は packages/db の response-schedules.test.ts が担保)。auth は
 * real authMiddleware + mock D1 (staff_members→null → env.API_KEY fallback)。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const hoisted = vi.hoisted(() => ({
  store: new Map<string | null, Record<string, unknown>>(),
}));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getResponseSchedule: vi.fn(async (_db: unknown, accountId: string | null) => hoisted.store.get(accountId ?? null) ?? null),
    upsertResponseSchedule: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      const saved = {
        id: `rs-${(input.lineAccountId as string) ?? 'global'}`,
        lineAccountId: (input.lineAccountId as string) ?? null,
        isEnabled: input.isEnabled,
        timezone: input.timezone ?? 'Asia/Tokyo',
        outsideHoursMode: input.outsideHoursMode,
        awayMessage: input.awayMessage ?? null,
        weeklyHours: input.weeklyHours ?? [],
      };
      hoisted.store.set(((input.lineAccountId as string) ?? null), saved);
      return saved;
    }),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { responseSchedules } from './response-schedules.js';

const mockDb = {
  prepare() {
    return {
      bind() {
        return this;
      },
      async first() {
        return null; // staff_members 検索 → null → env.API_KEY fallback
      },
      async all() {
        return { results: [] };
      },
      async run() {
        return {};
      },
    };
  },
} as unknown as D1Database;

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: mockDb, API_KEY: 'test-key' };
    await next();
  });
  app.use('*', authMiddleware);
  app.route('/', responseSchedules);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' } };
const VALID_WEEKLY = [
  { day: 1, closed: false, open: '09:00', close: '18:00' },
  { day: 0, closed: true, open: '', close: '' },
];

beforeEach(() => {
  hoisted.store.clear();
});

describe('GET /api/response-schedules', () => {
  test('returns default (is_enabled=false) when no row exists', async () => {
    const res = await setupApp().request('/api/response-schedules?accountId=acc-1', AUTH);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { isEnabled: boolean; outsideHoursMode: string } }>();
    expect(body.data.isEnabled).toBe(false);
    expect(body.data.outsideHoursMode).toBe('auto_reply');
  });

  test('returns the saved value after a PUT', async () => {
    const app = setupApp();
    await app.request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({
        accountId: 'acc-1',
        isEnabled: true,
        outsideHoursMode: 'away_message',
        awayMessage: 'ただいま営業時間外です',
        weeklyHours: VALID_WEEKLY,
      }),
    });
    const res = await app.request('/api/response-schedules?accountId=acc-1', AUTH);
    const body = await res.json<{ data: { isEnabled: boolean; awayMessage: string; weeklyHours: unknown } }>();
    expect(body.data.isEnabled).toBe(true);
    expect(body.data.awayMessage).toBe('ただいま営業時間外です');
    expect(body.data.weeklyHours).toEqual(VALID_WEEKLY);
  });
});

describe('PUT /api/response-schedules', () => {
  test('upserts and second PUT updates the same account', async () => {
    const app = setupApp();
    await app.request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', isEnabled: false, outsideHoursMode: 'auto_reply', weeklyHours: [] }),
    });
    await app.request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', isEnabled: true, outsideHoursMode: 'none', weeklyHours: VALID_WEEKLY }),
    });
    const res = await app.request('/api/response-schedules?accountId=acc-1', AUTH);
    const body = await res.json<{ data: { isEnabled: boolean; outsideHoursMode: string } }>();
    expect(body.data.isEnabled).toBe(true);
    expect(body.data.outsideHoursMode).toBe('none');
    expect(hoisted.store.size).toBe(1);
  });

  test('rejects invalid outsideHoursMode with 400', async () => {
    const res = await setupApp().request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', isEnabled: true, outsideHoursMode: 'bogus', weeklyHours: [] }),
    });
    expect(res.status).toBe(400);
  });

  test('rejects weeklyHours with day=7 (out of 0-6) with 400', async () => {
    const res = await setupApp().request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({
        accountId: 'acc-1',
        isEnabled: true,
        outsideHoursMode: 'auto_reply',
        weeklyHours: [{ day: 7, closed: false, open: '09:00', close: '18:00' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects weeklyHours with '25:00' (non HH:MM) with 400", async () => {
    const res = await setupApp().request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({
        accountId: 'acc-1',
        isEnabled: true,
        outsideHoursMode: 'auto_reply',
        weeklyHours: [{ day: 1, closed: false, open: '25:00', close: '18:00' }],
      }),
    });
    expect(res.status).toBe(400);
  });

  test('requires away_message when outsideHoursMode is away_message (empty → 400)', async () => {
    const res = await setupApp().request('/api/response-schedules', {
      method: 'PUT',
      ...AUTH,
      body: JSON.stringify({
        accountId: 'acc-1',
        isEnabled: true,
        outsideHoursMode: 'away_message',
        awayMessage: '   ',
        weeklyHours: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  test('unauthenticated request is 401', async () => {
    const res = await setupApp().request('/api/response-schedules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1', isEnabled: true, outsideHoursMode: 'auto_reply', weeklyHours: [] }),
    });
    expect(res.status).toBe(401);
  });
});
