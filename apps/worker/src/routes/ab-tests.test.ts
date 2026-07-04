/**
 * T-C5 / A2 / A3 / D-1 (F2 batch4 G1) — ab-tests route の 4 verb account guard + 分割プレビュー +
 * 比較 + 勝ち draft が「送信ゼロ」で動くことの検証。
 *  - 4 verb すべて accountId 必須 (欠落 400) / 別 account は 404 (存在も伏せる)
 *  - split-preview は決定論分割の件数を返し送信しない
 *  - compare は insight を読み勝ち/同点/データ待ちを返す
 *  - winner-draft は draft を作るだけ (createBroadcast・実 multicast を叩かない)
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  listAbTests: vi.fn(),
  createAbTest: vi.fn(),
  getAbTestById: vi.fn(),
  updateAbTest: vi.fn(),
  deleteAbTest: vi.fn(),
  createBroadcast: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { abTests } = await import('./ab-tests.js');

type TestEnv = { Bindings: { DB: D1Database } };

/** split-preview の friends 解決 / compare の insight / winner-draft の勝ち案 lookup に応答する stub。 */
function makeDbStub(cfg: {
  friendIds?: string[];
  compareRows?: Array<{ broadcast_id: string; variant: string; open_rate: number | null; click_rate: number | null }>;
  winnerRow?: Record<string, unknown> | null;
} = {}): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        async first<T>() {
          if (sql.includes('FROM broadcasts WHERE ab_test_id')) return (cfg.winnerRow ?? null) as T;
          return null as T;
        },
        async all<T>() {
          if (sql.includes('FROM friends f')) return { results: (cfg.friendIds ?? []).map((id) => ({ id })) as T[] };
          if (sql.includes('broadcast_insights')) return { results: (cfg.compareRows ?? []) as T[] };
          return { results: [] as T[] };
        },
        async run() { return { meta: { changes: 1 } }; },
      }),
    }),
  } as unknown as D1Database;
}

function app(dbCfg: Parameters<typeof makeDbStub>[0] = {}) {
  const a = new Hono<TestEnv>();
  a.use('*', async (c, next) => { c.env = { DB: makeDbStub(dbCfg) } as never; await next(); });
  a.route('/', abTests);
  return a;
}

const T1 = { id: 't1', account_id: 'acc-1', name: '春A/B', metric: 'open_rate', status: 'draft', winner_broadcast_id: null, created_at: 'x', updated_at: 'x' };

beforeEach(() => { for (const m of Object.values(dbMocks)) m.mockReset(); });

describe('4-verb account guard', () => {
  test('GET list requires accountId (400)', async () => {
    const res = await app().request('/api/ab-tests');
    expect(res.status).toBe(400);
  });

  test('GET :id foreign account → 404 (getAbTestById scoped → null)', async () => {
    dbMocks.getAbTestById.mockResolvedValueOnce(null);
    const res = await app().request('/api/ab-tests/t1?accountId=acc-2');
    expect(res.status).toBe(404);
  });

  test('PATCH/DELETE require accountId (400)', async () => {
    expect((await app().request('/api/ab-tests/t1', { method: 'PATCH', body: '{}' })).status).toBe(400);
    expect((await app().request('/api/ab-tests/t1', { method: 'DELETE' })).status).toBe(400);
  });
});

describe('POST create', () => {
  test('rejects unknown metric (400)', async () => {
    const res = await app().request('/api/ab-tests?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'x', metric: 'bogus' }) });
    expect(res.status).toBe(400);
  });

  test('creates with valid metric (201)', async () => {
    dbMocks.createAbTest.mockResolvedValueOnce(T1);
    const res = await app().request('/api/ab-tests?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: '春A/B', metric: 'open_rate' }) });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { metric: string } };
    expect(body.data.metric).toBe('open_rate');
  });
});

describe('split-preview (deterministic, no send)', () => {
  test('returns per-variant counts and a "not sent" note', async () => {
    dbMocks.getAbTestById.mockResolvedValueOnce(T1);
    const res = await app({ friendIds: ['a', 'b', 'c', 'd', 'e'] }).request('/api/ab-tests/t1/split-preview?accountId=acc-1', {
      method: 'POST', body: JSON.stringify({ conditions: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { total: number; counts: Record<string, number> }; note: string };
    expect(body.data.total).toBe(5);
    expect(body.data.counts.A + body.data.counts.B).toBe(5);
    expect(body.note).toContain('送信しません');
  });
});

describe('compare', () => {
  test('winner decided by metric', async () => {
    dbMocks.getAbTestById.mockResolvedValueOnce(T1);
    const res = await app({ compareRows: [
      { broadcast_id: 'bA', variant: 'A', open_rate: 0.4, click_rate: 0.1 },
      { broadcast_id: 'bB', variant: 'B', open_rate: 0.6, click_rate: 0.05 },
    ] }).request('/api/ab-tests/t1/compare?accountId=acc-1');
    const body = await res.json() as { data: { winner: string | null; dataPending: boolean } };
    expect(body.data.winner).toBe('B');
  });

  test('null insight → dataPending (crons=[] dark)', async () => {
    dbMocks.getAbTestById.mockResolvedValueOnce(T1);
    const res = await app({ compareRows: [
      { broadcast_id: 'bA', variant: 'A', open_rate: null, click_rate: null },
      { broadcast_id: 'bB', variant: 'B', open_rate: 0.6, click_rate: 0.05 },
    ] }).request('/api/ab-tests/t1/compare?accountId=acc-1');
    const body = await res.json() as { data: { dataPending: boolean; winner: string | null } };
    expect(body.data.dataPending).toBe(true);
    expect(body.data.winner).toBeNull();
  });
});

describe('winner-draft (draft only, no send)', () => {
  test('creates a draft broadcast and marks the test decided — no multicast', async () => {
    dbMocks.getAbTestById.mockResolvedValueOnce(T1);
    dbMocks.createBroadcast.mockResolvedValueOnce({ id: 'draft-1' });
    dbMocks.updateAbTest.mockResolvedValueOnce({ ...T1, status: 'decided', winner_broadcast_id: 'draft-1' });
    const res = await app({ winnerRow: { message_type: 'text', message_content: 'hi', target_type: 'all', line_account_id: 'acc-1' } })
      .request('/api/ab-tests/t1/winner-draft?accountId=acc-1', { method: 'POST', body: JSON.stringify({ winnerVariant: 'B' }) });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { draftBroadcastId: string }; note: string };
    expect(body.data.draftBroadcastId).toBe('draft-1');
    expect(body.note).toContain('すぐには送りません');
    // createBroadcast は呼ばれ、勝ち案を draft (status は createBroadcast 既定=draft) で複製する。
    expect(dbMocks.createBroadcast).toHaveBeenCalledTimes(1);
    // ab_test を decided + winner_broadcast_id に更新。
    expect(dbMocks.updateAbTest).toHaveBeenCalledWith(expect.anything(), 't1', 'acc-1', { winnerBroadcastId: 'draft-1', status: 'decided' });
  });
});
