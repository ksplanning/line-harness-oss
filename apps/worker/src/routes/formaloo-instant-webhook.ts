import { Hono } from 'hono';
import {
  acquireFormalooWebhookOperationLock,
  claimFormalooWebhookPull,
  clearFormalooWebhookRegistration,
  completeFormalooWebhookPull,
  disableFormalooWebhookRegistration,
  getFormalooForm,
  markFormalooWebhookPullPending,
  prepareFormalooWebhookRegistration,
  releaseFormalooWebhookOperationLock,
  renewFormalooWebhookOperationLock,
  renewFormalooWebhookPullLock,
  setFormalooWebhookRegistration,
  upsertFormalooSubmission,
} from '@line-crm/db';
import { resolveFormalooClient, type FormalooClient } from '../services/formaloo-client.js';
import {
  ensureFormalooInstantWebhook,
  removeFormalooInstantWebhook,
} from '../services/formaloo-instant-webhook.js';
import {
  friendLinkSecret,
  pullFriendReconcileInputs,
} from '../services/formaloo-row-edit.js';
import { verifyWebhookToken } from '../services/formaloo-webhook.js';
import type { Env } from '../index.js';

const CALLBACK_PREFIX = '/formaloo/instant';
export const INSTANT_WEBHOOK_COOLDOWN_MS = 15_000;
export const INSTANT_WEBHOOK_OPERATION_LEASE_MS = 120_000;
export const INSTANT_WEBHOOK_OPERATION_IO_TIMEOUT_MS = 30_000;
export const INSTANT_WEBHOOK_PULL_LEASE_MS = 12_000;
export const INSTANT_WEBHOOK_PULL_IO_TIMEOUT_MS = 5_000;
export const INSTANT_WEBHOOK_PULL_ATTEMPT_TIMEOUT_MS = 8_000;
export const INSTANT_WEBHOOK_JOB_MAX_WAIT_MS = 20_000;
const INSTANT_WEBHOOK_JOB_MAX_PULLS = 1;
const INSTANT_WEBHOOK_JOB_MAX_ATTEMPTS = 3;
const MAX_GATE_ENTRIES = 1_000;

export interface InstantWebhookRouteDeps {
  getForm: typeof getFormalooForm;
  acquireOperationLock: typeof acquireFormalooWebhookOperationLock;
  releaseOperationLock: typeof releaseFormalooWebhookOperationLock;
  renewOperationLock: typeof renewFormalooWebhookOperationLock;
  markPullPending: typeof markFormalooWebhookPullPending;
  claimPull: typeof claimFormalooWebhookPull;
  renewPullLock: typeof renewFormalooWebhookPullLock;
  completePull: typeof completeFormalooWebhookPull;
  prepareRegistration: typeof prepareFormalooWebhookRegistration;
  setRegistration: typeof setFormalooWebhookRegistration;
  disableRegistration: typeof disableFormalooWebhookRegistration;
  clearRegistration: typeof clearFormalooWebhookRegistration;
  resolveClient: typeof resolveFormalooClient;
  deadlineClient: (client: FormalooClient, timeoutMs: number, parentSignal?: AbortSignal) => FormalooClient;
  ensureRegistration: typeof ensureFormalooInstantWebhook;
  removeRegistration: typeof removeFormalooInstantWebhook;
  pullInputs: typeof pullFriendReconcileInputs;
  upsertSubmission: typeof upsertFormalooSubmission;
  linkSecret: typeof friendLinkSecret;
  generateSecret: () => string;
  generateOperationToken: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function randomHexSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function withHardDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('operation deadline exceeded');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const defaultDeps: InstantWebhookRouteDeps = {
  getForm: getFormalooForm,
  acquireOperationLock: acquireFormalooWebhookOperationLock,
  releaseOperationLock: releaseFormalooWebhookOperationLock,
  renewOperationLock: renewFormalooWebhookOperationLock,
  markPullPending: markFormalooWebhookPullPending,
  claimPull: claimFormalooWebhookPull,
  renewPullLock: renewFormalooWebhookPullLock,
  completePull: completeFormalooWebhookPull,
  prepareRegistration: prepareFormalooWebhookRegistration,
  setRegistration: setFormalooWebhookRegistration,
  disableRegistration: disableFormalooWebhookRegistration,
  clearRegistration: clearFormalooWebhookRegistration,
  resolveClient: resolveFormalooClient,
  deadlineClient: (client, timeoutMs, parentSignal) => client.withDeadline(timeoutMs, parentSignal),
  ensureRegistration: ensureFormalooInstantWebhook,
  removeRegistration: removeFormalooInstantWebhook,
  pullInputs: pullFriendReconcileInputs,
  upsertSubmission: upsertFormalooSubmission,
  linkSecret: friendLinkSecret,
  generateSecret: randomHexSecret,
  generateOperationToken: randomHexSecret,
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

function callbackOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function callbackPath(formId: string, secret: string): string {
  return `${CALLBACK_PREFIX}/${encodeURIComponent(formId)}/${encodeURIComponent(secret)}`;
}

function storedCallbackMatches(url: string, path: string): boolean {
  try {
    return new URL(url).pathname === path;
  } catch {
    return false;
  }
}

interface GateEntry {
  activeJobs: number;
  touchedAt: number;
}

export function createFormalooInstantWebhookRoutes(
  deps: InstantWebhookRouteDeps = defaultDeps,
) {
  const routes = new Hono<Env>();
  const gate = new Map<string, GateEntry>();

  const pruneGate = (now: number) => {
    if (gate.size <= MAX_GATE_ENTRIES) return;
    for (const [formId, entry] of gate) {
      if (entry.activeJobs === 0 && now - entry.touchedAt >= INSTANT_WEBHOOK_COOLDOWN_MS) {
        gate.delete(formId);
      }
      if (gate.size <= MAX_GATE_ENTRIES) break;
    }
  };

  routes.get('/api/forms-advanced/:id/instant-webhook', async (c) => {
    const form = await deps.getForm(c.env.DB, c.req.param('id'));
    if (!form || form.deleted === 1) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        enabled: form.formaloo_webhook_enabled === 1,
        available: Boolean(form.formaloo_slug),
      },
    });
  });

  routes.put('/api/forms-advanced/:id/instant-webhook', async (c) => {
    const formId = c.req.param('id');
    const body = await c.req.json<{ enabled?: unknown }>().catch(() => ({ enabled: undefined }));
    if (typeof body.enabled !== 'boolean') {
      return c.json({ success: false, error: 'enabled は boolean で指定してください' }, 400);
    }
    const initialForm = await deps.getForm(c.env.DB, formId);
    if (!initialForm || initialForm.deleted === 1) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const operationToken = deps.generateOperationToken();
    const acquired = await deps.acquireOperationLock(c.env.DB, formId, {
      token: operationToken,
      nowMs: deps.now(),
      leaseMs: INSTANT_WEBHOOK_OPERATION_LEASE_MS,
    });
    if (!acquired) {
      return c.json({ success: false, error: 'Webhook 設定を処理中です。少し待って再試行してください' }, 409);
    }
    const renewOperation = () => deps.renewOperationLock(c.env.DB, formId, {
      token: operationToken,
      nowMs: deps.now(),
      leaseMs: INSTANT_WEBHOOK_OPERATION_LEASE_MS,
    });

    try {
      // lock 待ちの間に変わり得るため、操作対象は取得し直した D1 行だけを使う。
      const form = await deps.getForm(c.env.DB, formId);
      if (!form || form.deleted === 1) return c.json({ success: false, error: 'Not found' }, 404);
      if (!form.formaloo_slug) {
        return c.json({ success: false, error: '先にフォームを Formaloo へ保存してください' }, 409);
      }

      if (!body.enabled) {
        // remote 障害中でも受信を先に止める。cleanup 情報は成功まで保持する。
        const disabled = await deps.disableRegistration(c.env.DB, formId, operationToken);
        if (!disabled) {
          return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
        }
        if (!form.formaloo_webhook_url) {
          const cleared = await deps.clearRegistration(c.env.DB, formId, operationToken);
          if (!cleared) {
            return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
          }
          return c.json({ success: true, data: { enabled: false, available: true } });
        }
        const client = await deps.resolveClient(c.env, form.workspace_id);
        if (!client) {
          return c.json({ success: false, error: '即時反映は停止しました。Formaloo 接続後に解除を再試行してください' }, 503);
        }
        if (!await renewOperation()) {
          return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
        }
        const boundedClient = deps.deadlineClient(client, INSTANT_WEBHOOK_OPERATION_IO_TIMEOUT_MS);
        const removed = await deps.removeRegistration(boundedClient, {
          formSlug: form.formaloo_slug,
          webhookId: form.formaloo_webhook_id ?? null,
          callbackUrl: form.formaloo_webhook_url,
        });
        if (!await renewOperation()) {
          return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
        }
        if (!removed.ok) {
          return c.json({ success: false, error: 'Webhook の解除に失敗しました。再試行してください' }, 502);
        }
        const cleared = await deps.clearRegistration(c.env.DB, formId, operationToken);
        if (!cleared) {
          return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
        }
        return c.json({ success: true, data: { enabled: false, available: true } });
      }

      const client = await deps.resolveClient(c.env, form.workspace_id);
      if (!client) {
        return c.json({ success: false, error: 'Formaloo 接続を確認してください' }, 503);
      }
      const origin = callbackOrigin(c.env.WORKER_PUBLIC_URL);
      if (!origin) {
        return c.json({ success: false, error: 'Worker 公開 URL が未設定です' }, 503);
      }
      let secret = form.formaloo_webhook_secret || deps.generateSecret();
      let callbackUrl = form.formaloo_webhook_url || `${origin}${callbackPath(formId, secret)}`;

      // remote POST 前に OFF 状態で callback を first-writer-wins 固定。lease takeover も必ず同じ組を使う。
      if (!form.formaloo_webhook_secret || !form.formaloo_webhook_url || form.formaloo_webhook_enabled !== 1) {
        const prepared = await deps.prepareRegistration(c.env.DB, formId, {
          secret,
          url: callbackUrl,
        }, operationToken);
        if (!prepared) {
          return c.json({ success: false, error: 'Webhook callback の保存に失敗しました' }, 500);
        }
        secret = prepared.secret;
        callbackUrl = prepared.url;
      }
      if (!storedCallbackMatches(callbackUrl, callbackPath(formId, secret))) {
        return c.json({ success: false, error: 'Webhook callback の保存値が不正です' }, 500);
      }

      if (!await renewOperation()) {
        return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
      }
      const boundedClient = deps.deadlineClient(client, INSTANT_WEBHOOK_OPERATION_IO_TIMEOUT_MS);
      const ensured = await deps.ensureRegistration(boundedClient, {
        formSlug: form.formaloo_slug,
        callbackUrl,
      });
      if (!await renewOperation()) {
        return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
      }
      if (!ensured.ok) {
        return c.json({ success: false, error: 'Webhook の登録確認に失敗しました' }, 502);
      }
      const committed = await deps.setRegistration(c.env.DB, formId, {
        webhookId: ensured.webhookId,
        secret,
        url: callbackUrl,
      }, operationToken);
      if (!committed) {
        // ownership 喪失後は remote に触れない。次 owner の ensure が同 URL 重複を収束させる。
        return c.json({ success: false, error: 'Webhook 設定が更新されました。再読込してください' }, 409);
      }
      return c.json({ success: true, data: { enabled: true, available: true } });
    } finally {
      await deps.releaseOperationLock(c.env.DB, formId, operationToken).catch(() => {
        // lease で回収できる。token/secret はログへ出さない。
        console.error('Formaloo instant webhook operation lock release failed');
      });
    }
  });

  routes.post(`${CALLBACK_PREFIX}/:formId/:secret`, async (c) => {
    const formId = c.req.param('formId');
    const form = await deps.getForm(c.env.DB, formId);
    const requestPath = new URL(c.req.url).pathname;
    const registered = form
      && form.deleted === 0
      && form.formaloo_webhook_enabled === 1
      && Boolean(form.formaloo_slug)
      && Boolean(form.formaloo_webhook_id)
      && Boolean(form.formaloo_webhook_secret)
      && Boolean(form.formaloo_webhook_url)
      && verifyWebhookToken(c.req.param('secret'), form.formaloo_webhook_secret)
      && storedCallbackMatches(form.formaloo_webhook_url!, requestPath);
    if (!registered || !form) {
      // 未知 form / OFF / 未登録 / secret 不一致を区別しない（登録有無の oracle にしない）。
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    // payload は読まず、認証済み callback の到着だけを durable generation として残す。
    // worker が途中終了しても processed_generation 未到達の dirty は D1 に残る。
    const marked = await deps.markPullPending(c.env.DB, formId);
    if (!marked) return c.json({ success: false, error: 'Not found' }, 404);

    const now = deps.now();
    pruneGate(now);
    const prior = gate.get(formId);
    const status = prior && prior.activeJobs > 0 ? 'debounced' : 'accepted';
    const entry = prior ?? { activeJobs: 0, touchedAt: now };
    entry.activeJobs += 1;
    entry.touchedAt = now;
    gate.set(formId, entry);

    const job = (async () => {
      try {
        let attempts = 0;
        let pulls = 0;
        let waitedMs = 0;
        // 1 job は有限（最大1 pull / 3 claim / sleep合計20s）。世代と lock は D1 なので isolate をまたいでも1 form 1 pull。
        while (attempts < INSTANT_WEBHOOK_JOB_MAX_ATTEMPTS && pulls < INSTANT_WEBHOOK_JOB_MAX_PULLS) {
          attempts += 1;
          const claimToken = deps.generateOperationToken();
          const claimNow = deps.now();
          const claim = await deps.claimPull(c.env.DB, formId, {
            token: claimToken,
            nowMs: claimNow,
            leaseMs: INSTANT_WEBHOOK_PULL_LEASE_MS,
            cooldownMs: INSTANT_WEBHOOK_COOLDOWN_MS,
          });
          if (!claim.claimed) {
            if (!claim.pending) break;
            const waitMs = Math.max(25, claim.retryAt - claimNow);
            if (waitedMs + waitMs > INSTANT_WEBHOOK_JOB_MAX_WAIT_MS) break;
            waitedMs += waitMs;
            await deps.sleep(waitMs);
            continue;
          }

          pulls += 1;
          let success = false;
          try {
            const inputs = await withHardDeadline(async (attemptSignal) => {
              const currentForm = await deps.getForm(c.env.DB, formId);
              if (attemptSignal.aborted) throw attemptSignal.reason;
              if (
                !currentForm
                || currentForm.deleted === 1
                || currentForm.formaloo_webhook_enabled !== 1
                || !currentForm.formaloo_slug
                || currentForm.formaloo_webhook_id !== form.formaloo_webhook_id
              ) throw new Error('registration changed');
              const client = await deps.resolveClient(c.env, currentForm.workspace_id);
              if (attemptSignal.aborted) throw attemptSignal.reason;
              if (!client) throw new Error('provider unavailable');
              const renewed = await deps.renewPullLock(c.env.DB, formId, {
                token: claimToken,
                nowMs: deps.now(),
                leaseMs: INSTANT_WEBHOOK_PULL_LEASE_MS,
              });
              if (!renewed || attemptSignal.aborted) throw new Error('pull claim expired');
              const boundedClient = deps.deadlineClient(
                client,
                INSTANT_WEBHOOK_PULL_IO_TIMEOUT_MS,
                attemptSignal,
              );
              // request payload は form 特定にも回答値にも使わない。D1 form をキーに真値を bounded pull する。
              const pulled = await deps.pullInputs(boundedClient, currentForm, {
                friendTokenSecret: deps.linkSecret(c.env),
                maxPages: 1,
                pageSize: 10,
              });
              if (attemptSignal.aborted) throw attemptSignal.reason;
              return pulled;
            }, INSTANT_WEBHOOK_PULL_ATTEMPT_TIMEOUT_MS);
            // newest-first / same timestamp rowid tie を保つため並列化しない。
            // provider deadline 後に残る Promise を作らないよう、D1 upsert は race 外で lease を更新する。
            for (const input of inputs) {
              const renewed = await deps.renewPullLock(c.env.DB, formId, {
                token: claimToken,
                nowMs: deps.now(),
                leaseMs: INSTANT_WEBHOOK_PULL_LEASE_MS,
              });
              if (!renewed) throw new Error('pull claim expired');
              await deps.upsertSubmission(c.env.DB, input);
            }
            success = true;
          } catch {
            // fail-soft: 次回の管理画面 reconcile / 6h cron が回収する。payload/secret/回答値はログへ出さない。
            console.error('Formaloo instant webhook targeted pull failed');
          } finally {
            await deps.completePull(c.env.DB, formId, {
              token: claimToken,
              generation: claim.generation,
              success,
            }).catch(() => {
              console.error('Formaloo instant webhook pull claim completion failed');
            });
          }
          if (!success) break;
        }
      } catch {
        // claim/scheduler 自体の D1 failure も 202 fail-soft。dirty 世代は可能な限り D1 に保持済み。
        console.error('Formaloo instant webhook pull scheduler failed');
      } finally {
        entry.activeJobs = Math.max(0, entry.activeJobs - 1);
        entry.touchedAt = deps.now();
      }
    })();

    try {
      c.executionCtx.waitUntil(job);
    } catch {
      // Hono unit test / non-Workers adapter は ExecutionContext を持たない。そこでだけ完了を待つ。
      await job;
    }
    return c.json({ success: true, status }, 202);
  });

  return routes;
}

export const formalooInstantWebhook = createFormalooInstantWebhookRoutes();
