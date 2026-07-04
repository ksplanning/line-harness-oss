/**
 * T-C1 (F2 batch4 G1) — serializeBroadcast の whitelist に abTestId/abVariant が入り、
 * ADD COLUMN しただけの ab_test_id/ab_variant が API 応答 (UI 型) に round-trip することの検証
 * (Codex MEDIUM: serializeBroadcast は whitelist ゆえ列を足すだけでは UI に出ない)。
 */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
  getSenderPresetById: vi.fn(),
  resolveSenderForBroadcast: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({ LineClient: class { constructor(public t: string) {} } }));

const { broadcasts } = await import('./broadcasts.js');

type TestEnv = { Bindings: { DB: D1Database; WORKER_URL: string } };

function setupApp() {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database, WORKER_URL: 'https://w.example.com' } as never;
    await next();
  });
  app.route('/', broadcasts);
  return app;
}

const rowWithAb = {
  id: 'b1', title: 'A案', message_type: 'text', message_content: 'hi',
  target_type: 'all', target_tag_id: null, status: 'draft', scheduled_at: null,
  sent_at: null, total_count: 0, success_count: 0, created_at: '2026-07-04T00:00:00.000+09:00',
  sender_preset_id: null, ab_test_id: 'ab-1', ab_variant: 'A',
};

describe('serializeBroadcast ab round-trip (GET /api/broadcasts/:id)', () => {
  test('abTestId / abVariant appear in serialized response', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(rowWithAb);
    const res = await setupApp().request('/api/broadcasts/b1');
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.abTestId).toBe('ab-1');
    expect(body.data.abVariant).toBe('A');
  });

  test('non-A/B row serializes ab fields as null (whitelist coalesces undefined → null)', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({ ...rowWithAb, ab_test_id: null, ab_variant: null });
    const res = await setupApp().request('/api/broadcasts/b1');
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.abTestId).toBeNull();
    expect(body.data.abVariant).toBeNull();
  });
});
