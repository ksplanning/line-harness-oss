import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFormalooInstantWebhookRoutes,
  type InstantWebhookRouteDeps,
} from './formaloo-instant-webhook.js';
import { pullFriendReconcileInputs } from '../services/formaloo-row-edit.js';

function form(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fa_safe',
    formaloo_slug: 'remote-safe-form',
    title: '入金フォーム',
    deleted: 0,
    render_backend: 'formaloo',
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
  let clock = 1_000_000;
  let generation = 0;
  let processed = 0;
  let pullLocked = false;
  let notBefore = 0;
  const deps = {
    getForm: vi.fn(async () => form()),
    acquireOperationLock: vi.fn(async () => true),
    releaseOperationLock: vi.fn(async () => undefined),
    renewOperationLock: vi.fn(async () => true),
    markPullPending: vi.fn(async () => { generation += 1; return true; }),
    claimPull: vi.fn(async (_db, _id, input: { token: string; nowMs: number; leaseMs: number; cooldownMs: number }) => {
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
    completePull: vi.fn(async (_db, _id, input: { generation: number; success: boolean }) => {
      if (input.success) processed = Math.max(processed, input.generation);
      pullLocked = false;
      return true;
    }),
    prepareRegistration: vi.fn(async (_db, _id, registration) => registration),
    setRegistration: vi.fn(async () => true),
    disableRegistration: vi.fn(async () => true),
    clearRegistration: vi.fn(async () => true),
    resolveClient: vi.fn(async () => ({ marker: 'tenant-client' })),
    deadlineClient: vi.fn((client) => client),
    ensureRegistration: vi.fn(async () => ({ ok: true as const, webhookId: 'wh_1', created: true })),
    removeRegistration: vi.fn(async () => ({ ok: true })),
    pullInputs: vi.fn(async () => []),
    upsertSubmission: vi.fn(async () => undefined),
    linkSecret: vi.fn(() => 'friend-token-secret'),
    generateSecret: vi.fn(() => 'fixed-callback-secret'),
    generateOperationToken: vi.fn(() => 'fixed-operation-token'),
    now: vi.fn(() => clock),
    sleep: vi.fn(async (ms: number) => { clock += ms; }),
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
    }, 'fixed-operation-token');
    expect(deps.ensureRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      { formSlug: 'remote-safe-form', callbackUrl },
    );
    expect(deps.setRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe', {
      webhookId: 'wh_1',
      secret: 'fixed-callback-secret',
      url: callbackUrl,
    }, 'fixed-operation-token');
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

  test('lock ownership 喪失後は新 owner の remote 操作を妨げない', async () => {
    const deps = makeDeps({ setRegistration: vi.fn(async () => false) });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }, env as never);

    expect(res.status).toBe(409);
    expect(deps.removeRegistration).not.toHaveBeenCalled();
  });

  test('同じ form の操作 lock が使用中なら remote 登録を重複実行しない', async () => {
    const deps = makeDeps({ acquireOperationLock: vi.fn(async () => false) });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }, env as never);
    expect(res.status).toBe(409);
    expect(deps.ensureRegistration).not.toHaveBeenCalled();
    expect(deps.releaseOperationLock).not.toHaveBeenCalled();
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
    expect(deps.clearRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe', 'fixed-operation-token');
  });

  test('POST 成否不明で remote id が無くても、OFF は保存済み URL を照合してから local を消す', async () => {
    const uncertain = form({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: null,
      formaloo_webhook_secret: 'stored-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_safe/stored-secret',
    });
    const deps = makeDeps({ getForm: vi.fn(async () => uncertain) });
    const app = createFormalooInstantWebhookRoutes(deps);
    const res = await app.request('/api/forms-advanced/fa_safe/instant-webhook', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }, env as never);

    expect(res.status).toBe(200);
    expect(deps.removeRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      {
        formSlug: 'remote-safe-form',
        webhookId: null,
        callbackUrl: uncertain.formaloo_webhook_url,
      },
    );
    expect(deps.clearRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe', 'fixed-operation-token');
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
    expect(deps.disableRegistration).toHaveBeenCalledWith(env.DB, 'fa_safe', 'fixed-operation-token');
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
    ['自前配信へ切替済み', { ...registered, render_backend: 'internal' }, 'stored-secret'],
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
    expect(deps.deadlineClient).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      5_000,
      expect.any(AbortSignal),
    );
    expect(deps.pullInputs).toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'tenant-client' }),
      registered,
      { friendTokenSecret: 'friend-token-secret', maxPages: 1, pageSize: 10 },
    );
    expect(deps.upsertSubmission).toHaveBeenNthCalledWith(1, env.DB, first);
    expect(deps.upsertSubmission).toHaveBeenNthCalledWith(2, env.DB, second);
  });

  test('D-3: callback 後の実 mapper pull が matrix/repeating を answersJson のまま upsert へ渡す', async () => {
    const matrixValue = {
      row_a: { option_1: true, option_2: false },
      row_b: { option_1: false, option_2: true },
    };
    const repeatingValue = [
      { order: 'A', count: 1 },
      { order: 'B', count: 2 },
    ];
    const rowsClient = {
      get: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        data: {
          data: {
            rows: [{
              slug: 'instant_structural_row',
              created_at: '2026-07-20T11:00:00Z',
              data: {
                matrix_field_slug: matrixValue,
                repeating_field_slug: repeatingValue,
                legacy_text_slug: '既存値',
              },
            }],
          },
        },
      })),
    };
    const pullInputs = vi.fn(async (
      _client: Parameters<InstantWebhookRouteDeps['pullInputs']>[0],
      currentForm: Parameters<InstantWebhookRouteDeps['pullInputs']>[1],
      opts: Parameters<InstantWebhookRouteDeps['pullInputs']>[2],
    ) => pullFriendReconcileInputs(rowsClient, currentForm, opts));
    const deps = makeDeps({
      getForm: vi.fn(async () => registered),
      pullInputs: pullInputs as InstantWebhookRouteDeps['pullInputs'],
    });
    const app = createFormalooInstantWebhookRoutes(deps);

    const res = await app.request('/formaloo/instant/fa_safe/stored-secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { matrix_field_slug: 'forged callback value' } }),
    }, env as never);

    expect(res.status).toBe(202);
    expect(rowsClient.get).toHaveBeenCalledWith('/v3.0/forms/remote-safe-form/rows/?page=1&page_size=10');
    expect(deps.upsertSubmission).toHaveBeenCalledTimes(1);
    const input = deps.upsertSubmission.mock.calls[0][1] as { answersJson: string };
    expect(JSON.parse(input.answersJson)).toEqual({
      matrix_field_slug: matrixValue,
      repeating_field_slug: repeatingValue,
      legacy_text_slug: '既存値',
    });
  });

  test('同じ form の in-flight 連打は爆発させず、末尾1回の pull へ繰り越す', async () => {
    let finishFirst!: (value: never[]) => void;
    let releaseCooldown!: () => void;
    let clock = 1_000_000;
    const firstPull = new Promise<never[]>((resolve) => { finishFirst = resolve; });
    const sleep = vi.fn(async (ms: number) => {
      await new Promise<void>((resolve) => {
        releaseCooldown = () => {
          clock += ms;
          resolve();
        };
      });
    });
    const pullInputs = vi.fn()
      .mockImplementationOnce(async () => firstPull)
      .mockResolvedValueOnce([] as never);
    const deps = makeDeps({
      getForm: vi.fn(async () => registered),
      pullInputs,
      now: vi.fn(() => clock),
      sleep,
    });
    const app = createFormalooInstantWebhookRoutes(deps);
    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const first = await app.request(
      '/formaloo/instant/fa_safe/stored-secret',
      { method: 'POST' },
      env as never,
      executionCtx,
    );
    await vi.waitFor(() => expect(pullInputs).toHaveBeenCalledTimes(1));
    const second = await app.request(
      '/formaloo/instant/fa_safe/stored-secret',
      { method: 'POST' },
      env as never,
      executionCtx,
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ status: 'debounced' });
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(15_000));
    finishFirst([]);
    await (waitUntil.mock.calls[0]?.[0] as Promise<unknown>);
    releaseCooldown();
    await (waitUntil.mock.calls[1]?.[0] as Promise<unknown>);
    expect(pullInputs).toHaveBeenCalledTimes(2);
  });

  test('別 Worker isolate 相当の route instance でも D1 claim を共有し、同時 pull を1件にする', async () => {
    let finishFirst!: (value: never[]) => void;
    let releaseCooldown!: () => void;
    let clock = 1_000_000;
    const firstPull = new Promise<never[]>((resolve) => { finishFirst = resolve; });
    const sleep = vi.fn(async (ms: number) => {
      await new Promise<void>((resolve) => {
        releaseCooldown = () => {
          clock += ms;
          resolve();
        };
      });
    });
    const pullInputs = vi.fn()
      .mockImplementationOnce(async () => firstPull)
      .mockResolvedValueOnce([] as never);
    const deps = makeDeps({
      getForm: vi.fn(async () => registered),
      pullInputs,
      now: vi.fn(() => clock),
      sleep,
    });
    const isolateA = createFormalooInstantWebhookRoutes(deps);
    const isolateB = createFormalooInstantWebhookRoutes(deps);
    const waitA = vi.fn();
    const waitB = vi.fn();
    const ctxA = { waitUntil: waitA, passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const ctxB = { waitUntil: waitB, passThroughOnException: vi.fn() } as unknown as ExecutionContext;

    const first = await isolateA.request(
      '/formaloo/instant/fa_safe/stored-secret', { method: 'POST' }, env as never, ctxA,
    );
    await vi.waitFor(() => expect(pullInputs).toHaveBeenCalledTimes(1));
    const second = await isolateB.request(
      '/formaloo/instant/fa_safe/stored-secret', { method: 'POST' }, env as never, ctxB,
    );
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ status: 'accepted' });
    expect(pullInputs).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(15_000));
    finishFirst([]);
    await (waitA.mock.calls[0]?.[0] as Promise<unknown>);
    releaseCooldown();
    await (waitB.mock.calls[0]?.[0] as Promise<unknown>);
    expect(pullInputs).toHaveBeenCalledTimes(2);
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

  test('attempt deadline 後に遅く D1 read が戻っても provider pull を開始しない', async () => {
    vi.useFakeTimers();
    try {
      let finishCurrentForm!: (value: typeof registered) => void;
      const currentForm = new Promise<typeof registered>((resolve) => { finishCurrentForm = resolve; });
      const getForm = vi.fn()
        .mockResolvedValueOnce(registered)
        .mockImplementationOnce(async () => currentForm);
      const deps = makeDeps({ getForm });
      const app = createFormalooInstantWebhookRoutes(deps);
      const waitUntil = vi.fn();
      const executionCtx = { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext;

      const res = await app.request(
        '/formaloo/instant/fa_safe/stored-secret', { method: 'POST' }, env as never, executionCtx,
      );
      expect(res.status).toBe(202);
      const job = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
      await vi.advanceTimersByTimeAsync(8_000);
      await job;

      finishCurrentForm(registered);
      await Promise.resolve();
      await Promise.resolve();
      expect(deps.resolveClient).not.toHaveBeenCalled();
      expect(deps.pullInputs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
