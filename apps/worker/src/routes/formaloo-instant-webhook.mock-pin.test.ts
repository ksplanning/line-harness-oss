import { describe, expect, test, vi } from 'vitest';
import {
  createFormalooInstantWebhookRoutes,
  type InstantWebhookRouteDeps,
} from './formaloo-instant-webhook.js';
import {
  ensureFormalooInstantWebhook,
  removeFormalooInstantWebhook,
  type FormalooWebhookApi,
} from '../services/formaloo-instant-webhook.js';

describe('D-5 mock pin — 登録→受信→targeted pull→解除', () => {
  test('使い捨て form の一連の経路を通し、解除後は旧 callback を404にする', async () => {
    const state = {
      id: 'fa_disposable_b5_mock',
      formaloo_slug: 'disposable-b5-mock',
      title: 'B5 disposable mock',
      deleted: 0,
      workspace_id: 'fw_tenant_mock',
      friend_metadata_mappings_json: '[]',
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: null as string | null,
      formaloo_webhook_secret: null as string | null,
      formaloo_webhook_url: null as string | null,
    };
    const remoteWebhooks: Array<Record<string, unknown>> = [];
    const api: FormalooWebhookApi = {
      get: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        data: { webhooks: remoteWebhooks.map((webhook) => ({ ...webhook })) },
      })),
      post: vi.fn(async (_path, body) => {
        const webhook = { slug: 'wh_disposable_b5_mock', ...(body as object) };
        remoteWebhooks.push(webhook);
        return { ok: true as const, status: 201, data: { webhook } };
      }),
      request: vi.fn(async (_method, _path, body) => {
        const target = body as { id?: string; url?: string };
        const index = remoteWebhooks.findIndex((webhook) => (
          webhook.slug === target.id && webhook.url === target.url
        ));
        if (index >= 0) remoteWebhooks.splice(index, 1);
        return { ok: true as const, status: 204, data: null };
      }),
      delete: vi.fn(async () => ({ ok: true as const, status: 204, data: null })),
    };
    const mirrored = new Map<string, unknown>();
    const pullInputs = vi.fn(async () => [{ id: 'row_from_provider_truth' }] as never);
    let clock = 1_000_000;
    let generation = 0;
    let processed = 0;
    let pullLocked = false;
    let notBefore = 0;
    const deps: InstantWebhookRouteDeps = {
      getForm: vi.fn(async () => ({ ...state }) as never),
      acquireOperationLock: vi.fn(async () => true),
      releaseOperationLock: vi.fn(async () => undefined),
      renewOperationLock: vi.fn(async () => true),
      markPullPending: vi.fn(async () => { generation += 1; return true; }),
      claimPull: vi.fn(async (_db, _id, input) => {
        if (!pullLocked && generation > processed && input.nowMs >= notBefore) {
          pullLocked = true;
          notBefore = input.nowMs + input.cooldownMs;
          return { claimed: true as const, generation };
        }
        return {
          claimed: false as const,
          pending: generation > processed,
          retryAt: Math.max(input.nowMs, notBefore),
        };
      }),
      renewPullLock: vi.fn(async () => true),
      completePull: vi.fn(async (_db, _id, input) => {
        if (input.success) processed = Math.max(processed, input.generation);
        pullLocked = false;
        return true;
      }),
      prepareRegistration: vi.fn(async (_db, _id, registration) => {
        state.formaloo_webhook_enabled = 0;
        state.formaloo_webhook_secret = registration.secret;
        state.formaloo_webhook_url = registration.url;
        return registration;
      }),
      setRegistration: vi.fn(async (_db, _id, registration) => {
        state.formaloo_webhook_enabled = 1;
        state.formaloo_webhook_id = registration.webhookId;
        state.formaloo_webhook_secret = registration.secret;
        state.formaloo_webhook_url = registration.url;
        return true;
      }),
      disableRegistration: vi.fn(async () => {
        state.formaloo_webhook_enabled = 0;
        return true;
      }),
      clearRegistration: vi.fn(async () => {
        state.formaloo_webhook_enabled = 0;
        state.formaloo_webhook_id = null;
        state.formaloo_webhook_secret = null;
        state.formaloo_webhook_url = null;
        return true;
      }),
      resolveClient: vi.fn(async () => api as never),
      deadlineClient: vi.fn((client) => client),
      ensureRegistration: ensureFormalooInstantWebhook as never,
      removeRegistration: removeFormalooInstantWebhook as never,
      pullInputs,
      upsertSubmission: vi.fn(async (_db, input) => {
        mirrored.set((input as { id: string }).id, input);
      }),
      linkSecret: vi.fn(() => 'mock-friend-token-secret'),
      generateSecret: vi.fn(() => 'mock-callback-secret'),
      generateOperationToken: vi.fn(() => 'mock-operation-token'),
      now: vi.fn(() => clock),
      sleep: vi.fn(async (ms) => { clock += ms; }),
    };
    const app = createFormalooInstantWebhookRoutes(deps);
    const env = {
      DB: {} as D1Database,
      WORKER_PUBLIC_URL: 'https://worker.example',
    };

    const enabled = await app.request('/api/forms-advanced/fa_disposable_b5_mock/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }, env as never);
    expect(enabled.status).toBe(200);
    expect(remoteWebhooks).toEqual([expect.objectContaining({
      url: 'https://worker.example/formaloo/instant/fa_disposable_b5_mock/mock-callback-secret',
      form_submit_events: true,
    })]);
    expect(state.formaloo_webhook_enabled).toBe(1);

    const callbackPath = '/formaloo/instant/fa_disposable_b5_mock/mock-callback-secret';
    const accepted = await app.request(callbackPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { paid: 'forged payload must be ignored' } }),
    }, env as never);
    const duplicate = await app.request(callbackPath, { method: 'POST' }, env as never);
    expect(accepted.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ status: 'accepted' });
    expect(pullInputs).toHaveBeenCalledTimes(2);
    expect([...mirrored.values()]).toEqual([{ id: 'row_from_provider_truth' }]);

    const disabled = await app.request('/api/forms-advanced/fa_disposable_b5_mock/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }, env as never);
    expect(disabled.status).toBe(200);
    expect(remoteWebhooks).toEqual([]);
    expect(state.formaloo_webhook_secret).toBeNull();

    const afterCleanup = await app.request(callbackPath, { method: 'POST' }, env as never);
    expect(afterCleanup.status).toBe(404);
    expect(pullInputs).toHaveBeenCalledTimes(2);
  });
});
