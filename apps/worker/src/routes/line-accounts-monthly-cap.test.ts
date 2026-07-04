/**
 * T-C6 / A4 (F2 batch4 G2) — line-accounts の monthly-cap GET/PATCH の検証。
 *  - GET は上限 + 今月送信数 + 残りを返す (表示と gate 同一計測)
 *  - PATCH は正整数 or null のみ受理 (0/負/小数は 400 = 誤設定で正常送信を止めない)
 *  - PATCH は owner/admin のみ (staff は 403) / 不存在 account は 404
 */
import { describe, expect, test, vi } from 'vitest';
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

type TestEnv = { Variables: { staff: { id: string; role: 'owner' | 'admin' | 'staff' } }; Bindings: { DB: D1Database } };

function dbStub(cfg: { count?: number; cap?: number | null } = {}): D1Database {
  const updates: unknown[][] = [];
  const stub = {
    prepare: (sql: string) => ({
      bind: (...a: unknown[]) => ({
        async first() {
          if (sql.includes('start of month')) return { count: cfg.count ?? 0 };
          if (sql.includes('monthly_cap FROM line_accounts')) return { monthly_cap: cfg.cap ?? null };
          return null;
        },
        async run() { if (sql.startsWith('UPDATE')) updates.push(a); return { meta: { changes: 1 } }; },
      }),
    }),
    __updates: updates,
  };
  return stub as unknown as D1Database;
}

function app(role: 'owner' | 'admin' | 'staff', db: D1Database) {
  const a = new Hono<TestEnv>();
  a.use('*', async (c, next) => { c.set('staff', { id: 's', role }); c.env = { DB: db }; await next(); });
  a.route('/', lineAccounts);
  return a;
}

describe('GET monthly-cap', () => {
  test('returns cap + this-month count + remaining', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await app('owner', dbStub({ count: 95, cap: 100 })).request('/api/line-accounts/acc-1/monthly-cap');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { monthlyCap: number; messagesThisMonth: number; remaining: number } };
    expect(body.data).toEqual({ monthlyCap: 100, messagesThisMonth: 95, remaining: 5 });
  });

  test('unlimited (cap null) → remaining null', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await app('owner', dbStub({ count: 95, cap: null })).request('/api/line-accounts/acc-1/monthly-cap');
    const body = await res.json() as { data: { monthlyCap: number | null; remaining: number | null } };
    expect(body.data.monthlyCap).toBeNull();
    expect(body.data.remaining).toBeNull();
  });

  test('nonexistent account → 404', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce(null);
    const res = await app('owner', dbStub()).request('/api/line-accounts/x/monthly-cap');
    expect(res.status).toBe(404);
  });
});

describe('PATCH monthly-cap', () => {
  test('sets a positive integer cap (200)', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await app('owner', dbStub()).request('/api/line-accounts/acc-1/monthly-cap', { method: 'PATCH', body: JSON.stringify({ monthlyCap: 200 }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { monthlyCap: number } };
    expect(body.data.monthlyCap).toBe(200);
  });

  test('null clears cap (unlimited)', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce({ id: 'acc-1' });
    const res = await app('owner', dbStub()).request('/api/line-accounts/acc-1/monthly-cap', { method: 'PATCH', body: JSON.stringify({ monthlyCap: null }) });
    const body = await res.json() as { data: { monthlyCap: number | null } };
    expect(body.data.monthlyCap).toBeNull();
  });

  test('rejects 0 / negative / non-integer (400)', async () => {
    for (const bad of [0, -5, 1.5]) {
      dbMocks.getLineAccountById.mockResolvedValueOnce({ id: 'acc-1' });
      const res = await app('owner', dbStub()).request('/api/line-accounts/acc-1/monthly-cap', { method: 'PATCH', body: JSON.stringify({ monthlyCap: bad }) });
      expect(res.status).toBe(400);
    }
  });

  test('staff role is forbidden (403)', async () => {
    const res = await app('staff', dbStub()).request('/api/line-accounts/acc-1/monthly-cap', { method: 'PATCH', body: JSON.stringify({ monthlyCap: 100 }) });
    expect(res.status).toBe(403);
  });
});
