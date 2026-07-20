import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// The notFound handler imports DB query helpers transitively (via the
// /r/:ref routes file isn't reached here, but `buildOgForLiffPath` reads
// from `@line-crm/db`-shaped tables through `c.env.DB.prepare`). The bot UA
// path is not exercised by these tests; everything else stays inside the
// handler so no DB calls happen.
vi.mock('@line-crm/db', () => ({
  // index.ts pulls these eagerly at module load; provide no-op stubs so the
  // import graph resolves under Vitest.
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getLineAccountById: vi.fn(),
  getTrafficPoolBySlug: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getRandomPoolAccount: vi.fn(),
  getPoolAccounts: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  getFormalooForm: vi.fn(),
  acquireFormalooWebhookOperationLock: vi.fn(),
  releaseFormalooWebhookOperationLock: vi.fn(),
  acquireFormalooFormOperationLock: vi.fn(),
  releaseFormalooFormOperationLock: vi.fn(),
  renewFormalooWebhookOperationLock: vi.fn(),
  markFormalooWebhookPullPending: vi.fn(),
  claimFormalooWebhookPull: vi.fn(),
  renewFormalooWebhookPullLock: vi.fn(),
  completeFormalooWebhookPull: vi.fn(),
  prepareFormalooWebhookRegistration: vi.fn(),
  setFormalooWebhookRegistration: vi.fn(),
  disableFormalooWebhookRegistration: vi.fn(),
  clearFormalooWebhookRegistration: vi.fn(),
  upsertFormalooSubmission: vi.fn(),
  listFormalooRecurringSubmissions: vi.fn().mockResolvedValue([]),
  getFormalooRecurringSubmissionByIdempotencyKey: vi.fn(),
  getFormalooRecurringSubmissionByFingerprint: vi.fn(),
  getFormalooRecurringSubmissionBySlug: vi.fn(),
  hasBlockingFormalooRecurringSubmissions: vi.fn(),
  reserveFormalooRecurringSubmission: vi.fn(),
  claimFormalooRecurringSubmission: vi.fn(),
  releaseFormalooRecurringSubmissionClaim: vi.fn(),
  completeFormalooRecurringSubmission: vi.fn(),
  markFormalooRecurringSubmissionFailed: vi.fn(),
  refreshFormalooRecurringSubmission: vi.fn(),
  getFormalooFieldMap: vi.fn().mockResolvedValue([]),
  listFormalooAiAnalysisSubmissions: vi.fn().mockResolvedValue([]),
  listFormalooAiChatHistory: vi.fn().mockResolvedValue([]),
  reserveFormalooAiChatHistory: vi.fn(),
  hasPendingFormalooAiChatHistory: vi.fn().mockResolvedValue(false),
  completeFormalooAiChatHistory: vi.fn(),
  failFormalooAiChatHistory: vi.fn(),
  jstNow: vi.fn().mockReturnValue('2026-07-20T00:00:00.000+09:00'),
}));

import { notFoundHandler, type Env } from './index.js';

function makeApp(env: Partial<Env['Bindings']>) {
  const app = new Hono<Env>();
  app.notFound(notFoundHandler);
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://worker.example.com${path}`, init), env as Env['Bindings']);
}

describe('notFoundHandler — root / request', () => {
  it('returns 404 JSON when ASSETS binding is undefined (no TypeError)', async () => {
    const fetchApp = makeApp({ DB: {} as D1Database });
    const res = await fetchApp('/');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({ success: false, error: 'Not found' });
  });

  it('returns 404 JSON when ASSETS exists but has no fetch method', async () => {
    const fetchApp = makeApp({
      DB: {} as D1Database,
      ASSETS: {} as unknown as Fetcher,
    });
    const res = await fetchApp('/');
    expect(res.status).toBe(404);
  });

  it('delegates to ASSETS.fetch when the binding is present', async () => {
    const assets: Fetcher = {
      fetch: vi.fn().mockResolvedValue(new Response('static', { status: 200 })),
    } as unknown as Fetcher;
    const fetchApp = makeApp({ DB: {} as D1Database, ASSETS: assets });
    const res = await fetchApp('/some-spa-path');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('static');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it('returns JSON 404 (not ASSETS lookup) for /api/* unknown paths', async () => {
    const assets: Fetcher = {
      fetch: vi.fn().mockResolvedValue(new Response('should not be called', { status: 200 })),
    } as unknown as Fetcher;
    const fetchApp = makeApp({ DB: {} as D1Database, ASSETS: assets });
    const res = await fetchApp('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});
