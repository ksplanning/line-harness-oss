/**
 * T-C7 / A9 — scenario step の直接入力 flex 保存前検証 (guardFlexContent 横展開)。
 *  - 直接入力 (非 templateId) の不正 flex は 400 / 正当 flex は 201・200
 *  - content 未変更の更新は再検証しない (partial-update 後方互換)
 */
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
vi.mock('../services/scenario-stats.js', () => ({ computeScenarioStats: vi.fn() }));

const { scenarios } = await import('./scenarios.js');

function dbStub(): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._a: unknown[]) => ({
        async first<T>() {
          if (sql.includes('delivery_mode FROM scenarios')) return { delivery_mode: 'relative' } as T;
          return null as T;
        },
        async all<T>() { return { results: [] as T[] }; },
        async run() { return { meta: { changes: 1 } }; },
      }),
    }),
  } as unknown as D1Database;
}

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { c.env = { DB: dbStub() } as never; await next(); });
  app.route('/', scenarios);
  return app;
}

const okBubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'hi', wrap: true }] } };
const emptyCarousel = { type: 'carousel', contents: [] };
const stepRow = { id: 's1', scenario_id: 'sc1', step_order: 0, delay_minutes: 0, message_type: 'flex', message_content: '{}', condition_type: null, condition_value: null };

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.createScenarioStep.mockResolvedValue(stepRow);
  dbMocks.updateScenarioStep.mockResolvedValue(stepRow);
});

async function postStep(body: unknown) {
  return setupApp().request('/api/scenarios/sc1/steps', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function putStep(body: unknown) {
  return setupApp().request('/api/scenarios/sc1/steps/s1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('T-C7 scenario step flex guard', () => {
  test('POST direct invalid flex → 400, step not created', async () => {
    const res = await postStep({ stepOrder: 0, delayMinutes: 0, messageType: 'flex', messageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
  });
  test('POST direct valid flex → 201', async () => {
    const res = await postStep({ stepOrder: 0, delayMinutes: 0, messageType: 'flex', messageContent: JSON.stringify(okBubble) });
    expect(res.status).toBe(201);
    expect(dbMocks.createScenarioStep).toHaveBeenCalledOnce();
  });
  test('PUT direct invalid flex content → 400', async () => {
    const res = await putStep({ messageType: 'flex', messageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();
  });
  test('PUT without messageContent (schedule-only) is not re-validated → 200', async () => {
    const res = await putStep({ stepOrder: 1 });
    expect(res.status).toBe(200);
    expect(dbMocks.updateScenarioStep).toHaveBeenCalledOnce();
  });
});
