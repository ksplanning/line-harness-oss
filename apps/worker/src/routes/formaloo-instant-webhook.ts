import { Hono } from 'hono';
import {
  clearFormalooWebhookRegistration,
  disableFormalooWebhookRegistration,
  getFormalooForm,
  prepareFormalooWebhookRegistration,
  setFormalooWebhookRegistration,
  upsertFormalooSubmission,
} from '@line-crm/db';
import { resolveFormalooClient } from '../services/formaloo-client.js';
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
const MAX_GATE_ENTRIES = 1_000;

export interface InstantWebhookRouteDeps {
  getForm: typeof getFormalooForm;
  prepareRegistration: typeof prepareFormalooWebhookRegistration;
  setRegistration: typeof setFormalooWebhookRegistration;
  disableRegistration: typeof disableFormalooWebhookRegistration;
  clearRegistration: typeof clearFormalooWebhookRegistration;
  resolveClient: typeof resolveFormalooClient;
  ensureRegistration: typeof ensureFormalooInstantWebhook;
  removeRegistration: typeof removeFormalooInstantWebhook;
  pullInputs: typeof pullFriendReconcileInputs;
  upsertSubmission: typeof upsertFormalooSubmission;
  linkSecret: typeof friendLinkSecret;
  generateSecret: () => string;
  now: () => number;
}

const defaultDeps: InstantWebhookRouteDeps = {
  getForm: getFormalooForm,
  prepareRegistration: prepareFormalooWebhookRegistration,
  setRegistration: setFormalooWebhookRegistration,
  disableRegistration: disableFormalooWebhookRegistration,
  clearRegistration: clearFormalooWebhookRegistration,
  resolveClient: resolveFormalooClient,
  ensureRegistration: ensureFormalooInstantWebhook,
  removeRegistration: removeFormalooInstantWebhook,
  pullInputs: pullFriendReconcileInputs,
  upsertSubmission: upsertFormalooSubmission,
  linkSecret: friendLinkSecret,
  generateSecret: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  },
  now: Date.now,
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
  startedAt: number;
  inFlight: boolean;
}

export function createFormalooInstantWebhookRoutes(
  deps: InstantWebhookRouteDeps = defaultDeps,
) {
  const routes = new Hono<Env>();
  const gate = new Map<string, GateEntry>();

  const pruneGate = (now: number) => {
    if (gate.size <= MAX_GATE_ENTRIES) return;
    for (const [formId, entry] of gate) {
      if (!entry.inFlight && now - entry.startedAt >= INSTANT_WEBHOOK_COOLDOWN_MS) gate.delete(formId);
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
    const form = await deps.getForm(c.env.DB, formId);
    if (!form || form.deleted === 1) return c.json({ success: false, error: 'Not found' }, 404);
    if (!form.formaloo_slug) {
      return c.json({ success: false, error: '先にフォームを Formaloo へ保存してください' }, 409);
    }

    if (!body.enabled) {
      // remote 障害中でも受信を先に止める。cleanup 情報は成功まで保持する。
      await deps.disableRegistration(c.env.DB, formId);
      if (!form.formaloo_webhook_id || !form.formaloo_webhook_url) {
        await deps.clearRegistration(c.env.DB, formId);
        return c.json({ success: true, data: { enabled: false, available: true } });
      }
      const client = await deps.resolveClient(c.env, form.workspace_id);
      if (!client) {
        return c.json({ success: false, error: '即時反映は停止しました。Formaloo 接続後に解除を再試行してください' }, 503);
      }
      const removed = await deps.removeRegistration(client, {
        formSlug: form.formaloo_slug,
        webhookId: form.formaloo_webhook_id,
        callbackUrl: form.formaloo_webhook_url,
      });
      if (!removed.ok) {
        return c.json({ success: false, error: 'Webhook の解除に失敗しました。再試行してください' }, 502);
      }
      await deps.clearRegistration(c.env.DB, formId);
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
    const secret = form.formaloo_webhook_secret || deps.generateSecret();
    const callbackUrl = form.formaloo_webhook_url || `${origin}${callbackPath(formId, secret)}`;

    // remote POST 前に OFF 状態で callback を固定。POST 後の D1 failure retry でも URL が変わらず重複しない。
    if (!form.formaloo_webhook_secret || !form.formaloo_webhook_url || form.formaloo_webhook_enabled !== 1) {
      await deps.prepareRegistration(c.env.DB, formId, { secret, url: callbackUrl });
    }
    const ensured = await deps.ensureRegistration(client, {
      formSlug: form.formaloo_slug,
      callbackUrl,
    });
    if (!ensured.ok) {
      return c.json({ success: false, error: 'Webhook の登録確認に失敗しました' }, 502);
    }
    await deps.setRegistration(c.env.DB, formId, {
      webhookId: ensured.webhookId,
      secret,
      url: callbackUrl,
    });
    return c.json({ success: true, data: { enabled: true, available: true } });
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

    const now = deps.now();
    pruneGate(now);
    const prior = gate.get(formId);
    if (prior && (prior.inFlight || now - prior.startedAt < INSTANT_WEBHOOK_COOLDOWN_MS)) {
      return c.json({ success: true, status: 'debounced' }, 202);
    }
    gate.set(formId, { startedAt: now, inFlight: true });

    const job = (async () => {
      try {
        const client = await deps.resolveClient(c.env, form.workspace_id);
        if (!client) return;
        // request payload は form 特定にも回答値にも使わない。D1 form をキーに真値を bounded pull する。
        const inputs = await deps.pullInputs(client, form, {
          friendTokenSecret: deps.linkSecret(c.env),
          maxPages: 1,
          pageSize: 25,
        });
        // newest-first / same timestamp rowid tie を保つため並列化しない。
        for (const input of inputs) await deps.upsertSubmission(c.env.DB, input);
      } catch {
        // fail-soft: 次回の管理画面 reconcile / 6h cron が回収する。payload/secret/回答値はログへ出さない。
        console.error('Formaloo instant webhook targeted pull failed');
      } finally {
        const current = gate.get(formId);
        if (current) current.inFlight = false;
      }
    })();

    try {
      c.executionCtx.waitUntil(job);
    } catch {
      // Hono unit test / non-Workers adapter は ExecutionContext を持たない。そこでだけ完了を待つ。
      await job;
    }
    return c.json({ success: true, status: 'accepted' }, 202);
  });

  return routes;
}

export const formalooInstantWebhook = createFormalooInstantWebhookRoutes();
