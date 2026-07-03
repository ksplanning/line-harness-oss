import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getScenarios: vi.fn(),
  getScenarioById: vi.fn(),
  createScenario: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  duplicateScenario: vi.fn(),
  createScenarioStep: vi.fn(),
  updateScenarioStep: vi.fn(),
  deleteScenarioStep: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendById: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../services/scenario-stats.js', () => ({
  computeScenarioStats: vi.fn(),
}));

const { scenarios: scenariosModule } = await import('./scenarios.js');

interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_tag_id: string | null;
  is_active: number;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  step_count: number;
}

function makeScenarioDb(rows: ScenarioRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<_T>() {
          calls.push({ sql, binds: bound });
          if (/FROM scenarios s\b/i.test(sql) && /line_account_id IS NULL/i.test(sql)) {
            const [lineAccountId] = bound as [string];
            const filtered = rows.filter(
              (r) => r.line_account_id == null || r.line_account_id === lineAccountId,
            );
            return { results: filtered };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    await next();
  });
  app.route('/', scenariosModule);
  return app;
}

const rowBase = {
  description: null,
  trigger_type: 'friend_add',
  trigger_tag_id: null,
  is_active: 1,
  delivery_mode: 'relative',
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
  step_count: 0,
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/scenarios?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) scenarios', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 's-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; lineAccountId: string | null }[] };
    expect(body.success).toBe(true);
    // webhook.ts:211 / liff.ts:878 trigger scenarios where line_account_id is
    // NULL (global) OR matches the active account. The list endpoint must
    // mirror that so the UI does not hide records the engine will fire.
    const ids = body.data.map((d) => d.id).sort();
    expect(ids).toEqual(['s-acc1', 's-global']);
    // Serializer surfaces the binding so the UI can distinguish 全アカ共通 from
    // an account-specific scenario.
    const globalRow = body.data.find((d) => d.id === 's-global');
    expect(globalRow?.lineAccountId).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(calls[0].sql).toMatch(/s\.line_account_id = \?/);
    expect(calls[0].binds).toEqual(['acc-1']);
  });

  test('falls back to getScenarios helper when no lineAccountId is provided', async () => {
    dbMocks.getScenarios.mockResolvedValue([
      { id: 's-x', name: 'x', line_account_id: null, ...rowBase },
    ]);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string }[] };
    expect(body.data.map((d) => d.id)).toEqual(['s-x']);
    expect(dbMocks.getScenarios).toHaveBeenCalledTimes(1);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });
});

describe('POST /api/scenarios/:id/duplicate (T-W1 / HIGH-3)', () => {
  const dupResult = {
    id: 'new-1',
    name: '(コピー) ようこそ',
    description: null,
    trigger_type: 'friend_add' as const,
    trigger_tag_id: null,
    line_account_id: 'acc-1',
    is_active: 0,
    delivery_mode: 'relative' as const,
    created_at: '2026-07-03T00:00:00.000+09:00',
    updated_at: '2026-07-03T00:00:00.000+09:00',
    steps: [
      {
        id: 'ns-1', scenario_id: 'new-1', step_order: 0, delay_minutes: 0,
        message_type: 'text' as const, message_content: 'こんにちは',
        condition_type: null, condition_value: null, next_step_on_false: null,
        offset_days: null, offset_minutes: null, delivery_time: null,
        template_id: null, on_reach_tag_id: null, created_at: '2026-07-03T00:00:00.000+09:00',
      },
    ],
  };

  test('201 with the duplicated scenario (is_active=false) + copied steps', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', name: 'ようこそ', line_account_id: 'acc-1', steps: dupResult.steps });
    dbMocks.duplicateScenario.mockResolvedValue(dupResult);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios/s-1/duplicate', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; name: string; isActive: boolean; steps: { messageContent: string }[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('new-1');
    expect(body.data.name).toBe('(コピー) ようこそ');
    expect(body.data.isActive).toBe(false); // 配信 OFF で複製
    expect(body.data.steps).toHaveLength(1);
    expect(body.data.steps[0].messageContent).toBe('こんにちは'); // 複製後 steps 一致
    expect(dbMocks.duplicateScenario).toHaveBeenCalledWith(expect.anything(), 's-1');
  });

  test('404 when the source scenario does not exist', async () => {
    dbMocks.getScenarioById.mockResolvedValue(null);
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios/nope/duplicate', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(dbMocks.duplicateScenario).not.toHaveBeenCalled();
  });

  test('404 when scoping to an account that does not own the source (HIGH-3 guard)', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', name: 'x', line_account_id: 'acc-A', steps: [] });
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios/s-1/duplicate?lineAccountId=acc-B', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(dbMocks.duplicateScenario).not.toHaveBeenCalled();
  });

  test('allows duplicating a global (NULL account) scenario even when scoped', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-g', name: 'global', line_account_id: null, steps: [] });
    dbMocks.duplicateScenario.mockResolvedValue({ ...dupResult, id: 'new-g', line_account_id: null });
    const { db } = makeScenarioDb([]);

    const res = await setupApp(db).request('/api/scenarios/s-g/duplicate?lineAccountId=acc-B', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(dbMocks.duplicateScenario).toHaveBeenCalledWith(expect.anything(), 's-g');
  });
});
