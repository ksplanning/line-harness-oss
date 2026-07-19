import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFormalooInstantWebhookRoutes,
  type InstantWebhookRouteDeps,
} from './formaloo-instant-webhook.js';

function form(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fa_safe',
    formaloo_slug: 'remote-safe-form',
    title: '入金フォーム',
    deleted: 0,
    workspace_id: 'fw_tenant_a',
    friend_metadata_mappings_json: '[]',
    formaloo_webhook_enabled: 0,
    formaloo_webhook_id: null,
    formaloo_webhook_secret: null,
    formaloo_webhook_url: null,
    ...overrides,
  } as never;
}

function makeDeps(overrides: Partial<InstantWebhookRouteDeps> = {}) {
  const deps = {
    getForm: vi.fn(async () => form()),
    prepareRegistration: vi.fn(async () => undefined),
    setRegistration: vi.fn(async () => undefined),
    disableRegistration: vi.fn(async () => undefined),
    clearRegistration: vi.fn(async () => undefined),
    resolveClient: vi.fn(async () => ({ marker: 'tenant-client' })),
    ensureRegistration: vi.fn(async () => ({ ok: true as const, webhookId: 'wh_1', created: true })),
    removeRegistration: vi.fn(async () => ({ ok: true })),
    pullInputs: vi.fn(async () => []),
    upsertSubmission: vi.fn(async () => undefined),
    linkSecret: vi.fn(() => 'friend-token-secret'),
    generateSecret: vi.fn(() => 'fixed-callback-secret'),
    now: vi.fn(() => 1_000_000),
    ...overrides,
  };
  return deps as unknown as InstantWebhookRouteDeps & Record<string, ReturnType<typeof vi.fn>>;
}

const env = {
  DB: {} as D1Database,
  WORKER_PUBLIC_URL: 'https://worker.example',
};

describe('管理 API — form 単位 ON/OFF', () => {
  test('GET は既定 OFF を返し、secret/URL は一切返さない', async () => {
    const deps = makeDeps();
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', undefined, env as never);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ success: true, data: { enabled: false, available: true } });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('worker.example');
  });

  test('ON は callback を先に OFF 保存→remote read-back→D1 有効化し、workspace 鍵を使う', async () => {
    const deps = makeDeps();
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }, env as never);

    expect(res.status).toBe(200);
    expect(deps.resolveClient).toHaveBeenCalledWith(expect.objectContaining({ DB: env.DB }), 'fw_tenant_a');
    const callbackUrl = 'https://worker.example/formaloo/instant/fa_safe/fixed-callback-secret';
    expect(deps.prepareRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe', {
      secret: 'fixed-callback-secret',
      url: callbackUrl,
    });
    expect(deps.ensureRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      { formSlug: 'remote-safe-form', callbackUrl },
    );
    expect(deps.setRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe', {
      webhookId: 'wh_1',
      secret: 'fixed-callback-secret',
      url: callbackUrl,
    });
  });

  test('remote soft-201/read-back 失敗では D1 を有効化しない', async () => {
    const deps = makeDeps({
      ensureRegistration: vi.fn(async () => ({ ok: false as const, reason: 'read_back_failed' as const })),
    });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }, env as never);
    expect(res.status).toBe(502);
    expect(deps.setRegistration).not.toHaveBeenCalled();
  });

  test('OFF は受信を先に止め、remote DELETE 成功後に local 情報を消す', async () => {
    const registered = form({
      formaloo_webhook_enabled: 1,
      formaloo_webhook_id: 'wh_delete',
      formaloo_webhook_secret: 'stored-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_safe/stored-secret',
    });
    const deps = makeDeps({ getForm: vi.fn(async () => registered) });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }, env as never);
    expect(res.status).toBe(200);
    expect(deps.disableRegistration).toHaveBeenCalledBefore(deps.removeRegistration as never);
    expect(deps.removeRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      {
        formSlug: 'remote-safe-form',
        webhookId: 'wh_delete',
        callbackUrl: registered.formaloo_webhook_url,
      },
    );
    expect(deps.clearRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe');
  });

  test('Formaloo 接続不能でも OFF は先に成立し、cleanup 情報を保持して再試行可能', async () => {
    const registered = form({
      formaloo_webhook_enabled: 1,
      formaloo_webhook_id: 'wh_retry',
      formaloo_webhook_secret: 'stored-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_safe/stored-secret',
    });
    const deps = makeDeps({
      getForm: vi.fn(async () => registered),
      resolveClient: vi.fn(async () => null),
    });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }, env as never);
    expect(res.status).toBe(503);
    expect(deps.disableRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe');
    expect(deps.clearRegistration).not.toHaveBeenCalled();
    expect(deps.removeRegistration).not.toHaveBeenCalled();
  });
});

describe('公開受信 — payload 非依存 targeted pull', () => {
  const registered = form({
    formaloo_webhook_enabled: 1,
    formaloo_webhook_id: 'wh_registered',
    formaloo_webhook_secret: 'stored-secret',
    formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_safe/stored-secret',
  });

  test.each([
    ['未知 form', null, 'stored-secret'],
    ['既定 OFF', form(), 'stored-secret'],
    ['secret 不一致', registered, 'wrong-secret'],
  ])('%s は同じ 404 で pull しない', async (_label, found, providedSecret) => {
    const deps = makeDeps({ getForm: vi.fn(async () => found as never) });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request(`/formaloo/instant/fa_safe/${providedSecret}`, { method: 'POST' }, env as never);
    expect(res.status).toBe(404);
    expect(deps.pullInputs).not.toHaveBeenCalled();
  });

  test('悪意ある payload の form/answers を無視し、保存済み form を1ページだけ pull→順次 upsert', async () => {
    const first = { id: 'row_1' };
    const second = { id: 'row_2' };
    const deps = makeDeps({
      getForm: vi.fn(async () => registered),
      pullInputs: vi.fn(async () => [first, second] as never),
    });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/formaloo/instant/fa_safe/stored-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ form: 'attacker-form', answers: { paid: 'forged' } }),
    }, env as never);

    expect(res.status).toBe(202);
    expect(deps.resolveClient).toHaveBeenCalledWith(expect.objectContaining({ DB: env.DB }), 'fw_tenant_a');
    expect(deps.pullInputs).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      registered,
      { friendTokenSecret: 'friend-token-secret', maxPages: 1, pageSize: 25 },
    );
    expect(deps.upsertSubmission).toHaveBeenNthCalledWith(1, env.DB, first);
    expect(deps.upsertSubmission).toHaveBeenNthCalledWith(2, env.DB, second);
  });

  test('同じ form の cooldown 内連打は pull 1回、応答はどちらも2xx', async () => {
    const deps = makeDeps({ getForm: vi.fn(async () => registered) });
    const app = createFormalooInstantWebhookRoutes(deps);
    const first = await app.request('/formaloo/instant/fa_safe/stored-secret', { method: 'POST' }, env as never);
    const second = await app.request('/formaloo/instant/fa_safe/stored-secret', { method: 'POST' }, env as never);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ status: 'debounced' });
    expect(deps.pullInputs).toHaveBeenCalledTimes(1);
  });

  test('pull が失敗しても fail-soft で202（次回 reconcile/cron が回収）', async () => {
    const deps = makeDeps({
      getForm: vi.fn(async () => registered),
      pullInputs: vi.fn(async () => { throw new Error('provider unavailable'); }),
    });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/formaloo/instant/fa_safe/stored-secret', { method: 'POST' }, env as never);
    expect(res.status).toBe(202);
  });
});
