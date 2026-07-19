import { Hono, type Context } from 'hono';
import {
  claimFormalooRecurringSubmission,
  completeFormalooRecurringSubmission,
  getFormalooForm,
  getFormalooRecurringSubmissionByIdempotencyKey,
  getFormalooRecurringSubmissionBySlug,
  listFormalooRecurringSubmissions,
  markFormalooRecurringSubmissionFailed,
  refreshFormalooRecurringSubmission,
  releaseFormalooRecurringSubmissionClaim,
  reserveFormalooRecurringSubmission,
  type FormalooRecurringStatus as MirrorStatus,
  type FormalooRecurringSubmissionMirror,
} from '@line-crm/db';
import { resolveFormalooClient, type FormalooClient } from '../services/formaloo-client.js';
import {
  buildFormalooSchedule,
  changeFormalooRecurringSubmissionStatus,
  ensureFormalooRecurringSubmission,
  updateFormalooRecurringSubmission,
  type FormalooRecurringStatus,
  type FormalooRecurringSubmissionRequest,
} from '../services/formaloo-recurring-submissions.js';
import type { Env } from '../index.js';

const OPERATION_LEASE_MS = 120_000;
const PROVIDER_DEADLINE_MS = 30_000;

export interface FormalooRecurringRouteDeps {
  getForm: typeof getFormalooForm;
  listMirrors: typeof listFormalooRecurringSubmissions;
  getByIdempotencyKey: typeof getFormalooRecurringSubmissionByIdempotencyKey;
  getBySlug: typeof getFormalooRecurringSubmissionBySlug;
  reserveMirror: typeof reserveFormalooRecurringSubmission;
  claimMirror: typeof claimFormalooRecurringSubmission;
  releaseClaim: typeof releaseFormalooRecurringSubmissionClaim;
  completeMirror: typeof completeFormalooRecurringSubmission;
  markFailed: typeof markFormalooRecurringSubmissionFailed;
  refreshMirror: typeof refreshFormalooRecurringSubmission;
  resolveClient: typeof resolveFormalooClient;
  deadlineClient: (client: FormalooClient) => FormalooClient;
  ensureRemote: typeof ensureFormalooRecurringSubmission;
  updateRemote: typeof updateFormalooRecurringSubmission;
  changeRemoteStatus: typeof changeFormalooRecurringSubmissionStatus;
  generateToken: () => string;
  now: () => number;
}

const defaultDeps: FormalooRecurringRouteDeps = {
  getForm: getFormalooForm,
  listMirrors: listFormalooRecurringSubmissions,
  getByIdempotencyKey: getFormalooRecurringSubmissionByIdempotencyKey,
  getBySlug: getFormalooRecurringSubmissionBySlug,
  reserveMirror: reserveFormalooRecurringSubmission,
  claimMirror: claimFormalooRecurringSubmission,
  releaseClaim: releaseFormalooRecurringSubmissionClaim,
  completeMirror: completeFormalooRecurringSubmission,
  markFailed: markFormalooRecurringSubmissionFailed,
  refreshMirror: refreshFormalooRecurringSubmission,
  resolveClient: resolveFormalooClient,
  deadlineClient: (client) => client.withDeadline(PROVIDER_DEADLINE_MS),
  ensureRemote: ensureFormalooRecurringSubmission,
  updateRemote: updateFormalooRecurringSubmission,
  changeRemoteStatus: changeFormalooRecurringSubmissionStatus,
  generateToken: () => crypto.randomUUID(),
  now: Date.now,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function statusValue(value: unknown, fallback?: FormalooRecurringStatus): FormalooRecurringStatus | undefined {
  if (value === undefined && fallback) return fallback;
  return value === 'resumed' || value === 'paused' || value === 'cancelled' ? value : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function mirrorMatches(
  mirror: FormalooRecurringSubmissionMirror,
  request: FormalooRecurringSubmissionRequest,
): boolean {
  return mirror.status === request.status
    && sameJson(mirror.schedule, request.schedule)
    && sameJson(mirror.submissionData, request.submission_data);
}

function requestFromBody(
  body: Record<string, unknown>,
  formalooFormSlug: string,
  statusFallback?: FormalooRecurringStatus,
): FormalooRecurringSubmissionRequest {
  const scheduleInput = asRecord(body.schedule);
  if (!scheduleInput) throw new Error('schedule を指定してください');
  const schedule = buildFormalooSchedule({
    interval: scheduleInput.interval,
    startTime: scheduleInput.startTime ?? scheduleInput.start_time,
    ...(Object.prototype.hasOwnProperty.call(scheduleInput, 'endTime')
      ? { endTime: scheduleInput.endTime }
      : Object.prototype.hasOwnProperty.call(scheduleInput, 'end_time')
        ? { endTime: scheduleInput.end_time }
        : {}),
  });
  const submissionData = body.submissionData ?? body.submission_data ?? {};
  const submissionRecord = asRecord(submissionData);
  if (!submissionRecord) throw new Error('submissionData は object で指定してください');
  const status = statusValue(body.status, statusFallback);
  if (!status) throw new Error('status は resumed / paused / cancelled で指定してください');
  return {
    form: formalooFormSlug,
    schedule,
    submission_data: submissionRecord,
    status,
  };
}

async function formOr404(c: Context<Env>, deps: FormalooRecurringRouteDeps) {
  const id = c.req.param('id');
  if (!id) return null;
  const form = await deps.getForm(c.env.DB, id);
  return form && form.deleted !== 1 ? form : null;
}

async function jsonBody(c: Context<Env>): Promise<Record<string, unknown> | null> {
  const value = await c.req.json<unknown>().catch(() => null);
  return asRecord(value);
}

function providerErrorMessage(reason: string): string {
  if (reason === 'slug_missing') {
    return 'Formaloo の作成結果を識別できませんでした。重複防止のため自動再登録せず、host 手順で確認してください';
  }
  return 'Formaloo への反映を確認できませんでした。台帳は成功状態に更新していません';
}

export function createFormalooRecurringSubmissionRoutes(
  injected: FormalooRecurringRouteDeps = defaultDeps,
) {
  const deps = injected;
  const routes = new Hono<Env>();

  routes.get('/api/forms-advanced/:id/recurring-submissions', async (c) => {
    const form = await formOr404(c, deps);
    if (!form) return c.json({ success: false, error: 'Not found' }, 404);
    const items = await deps.listMirrors(c.env.DB, form.id);
    return c.json({ success: true, data: { items, available: Boolean(form.formaloo_slug) } });
  });

  routes.post('/api/forms-advanced/:id/recurring-submissions', async (c) => {
    const body = await jsonBody(c);
    if (!body) return c.json({ success: false, error: 'JSON object を指定してください' }, 400);
    const idempotencyKey = body.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 128) {
      return c.json({ success: false, error: 'idempotencyKey は1〜128文字で指定してください' }, 400);
    }
    const form = await formOr404(c, deps);
    if (!form) return c.json({ success: false, error: 'Not found' }, 404);
    if (!form.formaloo_slug) {
      return c.json({ success: false, error: '先にフォームを Formaloo へ保存してください' }, 409);
    }
    let request: FormalooRecurringSubmissionRequest;
    try {
      request = requestFromBody(body, form.formaloo_slug, 'resumed');
    } catch (error) {
      return c.json({ success: false, error: error instanceof Error ? error.message : '入力が不正です' }, 400);
    }

    let mirror = await deps.getByIdempotencyKey(c.env.DB, form.id, idempotencyKey);
    if (mirror && !mirrorMatches(mirror, request)) {
      return c.json({ success: false, error: '同じ idempotencyKey に異なる内容は指定できません' }, 409);
    }
    if (mirror?.syncState === 'synced' && mirror.remoteSlug) {
      return c.json({ success: true, data: mirror });
    }
    if (
      mirror?.syncState === 'failed'
      && !mirror.remoteSlug
      && (mirror.lastError === 'slug_missing' || mirror.lastError === 'create_failed')
    ) {
      return c.json({ success: false, error: providerErrorMessage(mirror.lastError) }, 409);
    }
    mirror ??= await deps.reserveMirror(c.env.DB, {
      formId: form.id,
      idempotencyKey,
      schedule: request.schedule,
      submissionData: request.submission_data,
      status: request.status as MirrorStatus,
    });

    const token = deps.generateToken();
    const claimed = await deps.claimMirror(c.env.DB, mirror.id, {
      token,
      nowMs: deps.now(),
      leaseMs: OPERATION_LEASE_MS,
    });
    if (!claimed) {
      const latest = await deps.refreshMirror(c.env.DB, mirror.id);
      if (latest?.syncState === 'synced' && latest.remoteSlug && mirrorMatches(latest, request)) {
        return c.json({ success: true, data: latest });
      }
      return c.json({ success: false, error: '定期自動回答を処理中です。少し待って再試行してください' }, 409);
    }

    try {
      const client = await deps.resolveClient(c.env, form.workspace_id);
      if (!client) return c.json({ success: false, error: 'Formaloo 接続を確認してください' }, 503);
      const result = await deps.ensureRemote(deps.deadlineClient(client), request, {
        candidateSlug: mirror.remoteSlug,
      });
      if (!result.ok) {
        await deps.markFailed(c.env.DB, mirror.id, {
          token,
          candidateSlug: result.candidateSlug,
          error: result.reason,
        });
        return c.json({ success: false, error: providerErrorMessage(result.reason) }, 502);
      }
      const completed = await deps.completeMirror(c.env.DB, mirror.id, {
        token,
        remoteSlug: result.slug,
        schedule: result.value.schedule,
        submissionData: result.value.submission_data,
        status: result.value.status as MirrorStatus,
      });
      if (!completed) return c.json({ success: false, error: '台帳が更新されました。再読込してください' }, 409);
      const saved = await deps.refreshMirror(c.env.DB, mirror.id);
      if (!saved) return c.json({ success: false, error: '台帳の再取得に失敗しました' }, 500);
      return c.json({ success: true, data: saved }, result.created ? 201 : 200);
    } finally {
      await deps.releaseClaim(c.env.DB, mirror.id, token).catch(() => {
        console.error('Formaloo recurring submission claim release failed');
      });
    }
  });

  routes.put('/api/forms-advanced/:id/recurring-submissions/:slug', async (c) => {
    const body = await jsonBody(c);
    if (!body) return c.json({ success: false, error: 'JSON object を指定してください' }, 400);
    const form = await formOr404(c, deps);
    if (!form || !form.formaloo_slug) return c.json({ success: false, error: 'Not found' }, 404);
    const slug = c.req.param('slug');
    if (!slug) return c.json({ success: false, error: 'Not found' }, 404);
    const mirror = await deps.getBySlug(c.env.DB, form.id, slug);
    if (!mirror) return c.json({ success: false, error: 'Not found' }, 404);
    let request: FormalooRecurringSubmissionRequest;
    try {
      request = requestFromBody(body, form.formaloo_slug);
    } catch (error) {
      return c.json({ success: false, error: error instanceof Error ? error.message : '入力が不正です' }, 400);
    }
    const token = deps.generateToken();
    if (!await deps.claimMirror(c.env.DB, mirror.id, { token, nowMs: deps.now(), leaseMs: OPERATION_LEASE_MS })) {
      return c.json({ success: false, error: '定期自動回答を処理中です' }, 409);
    }
    try {
      const client = await deps.resolveClient(c.env, form.workspace_id);
      if (!client) return c.json({ success: false, error: 'Formaloo 接続を確認してください' }, 503);
      const result = await deps.updateRemote(deps.deadlineClient(client), slug, request);
      if (!result.ok) {
        await deps.markFailed(c.env.DB, mirror.id, {
          token, candidateSlug: result.candidateSlug, error: result.reason,
        });
        return c.json({ success: false, error: providerErrorMessage(result.reason) }, 502);
      }
      const completed = await deps.completeMirror(c.env.DB, mirror.id, {
        token,
        remoteSlug: result.slug,
        schedule: result.value.schedule,
        submissionData: result.value.submission_data,
        status: result.value.status as MirrorStatus,
      });
      if (!completed) return c.json({ success: false, error: '台帳が更新されました。再読込してください' }, 409);
      const saved = await deps.refreshMirror(c.env.DB, mirror.id);
      return saved
        ? c.json({ success: true, data: saved })
        : c.json({ success: false, error: '台帳の再取得に失敗しました' }, 500);
    } finally {
      await deps.releaseClaim(c.env.DB, mirror.id, token).catch(() => {
        console.error('Formaloo recurring submission claim release failed');
      });
    }
  });

  const runStatus = async (
    c: Context<Env>,
    forcedStatus?: FormalooRecurringStatus,
  ) => {
    const form = await formOr404(c, deps);
    if (!form || !form.formaloo_slug) return c.json({ success: false, error: 'Not found' }, 404);
    let status = forcedStatus;
    if (!status) {
      const body = await jsonBody(c);
      status = statusValue(body?.status);
      if (!status) {
        return c.json({ success: false, error: 'status は resumed / paused / cancelled で指定してください' }, 400);
      }
    }
    const slug = c.req.param('slug');
    if (!slug) return c.json({ success: false, error: 'Not found' }, 404);
    const mirror = await deps.getBySlug(c.env.DB, form.id, slug);
    if (!mirror) return c.json({ success: false, error: 'Not found' }, 404);
    const token = deps.generateToken();
    if (!await deps.claimMirror(c.env.DB, mirror.id, { token, nowMs: deps.now(), leaseMs: OPERATION_LEASE_MS })) {
      return c.json({ success: false, error: '定期自動回答を処理中です' }, 409);
    }
    try {
      const client = await deps.resolveClient(c.env, form.workspace_id);
      if (!client) return c.json({ success: false, error: 'Formaloo 接続を確認してください' }, 503);
      const result = await deps.changeRemoteStatus(deps.deadlineClient(client), slug, status);
      if (!result.ok) {
        await deps.markFailed(c.env.DB, mirror.id, {
          token, candidateSlug: result.candidateSlug, error: result.reason,
        });
        return c.json({ success: false, error: providerErrorMessage(result.reason) }, 502);
      }
      const completed = await deps.completeMirror(c.env.DB, mirror.id, {
        token,
        remoteSlug: result.slug,
        schedule: result.value.schedule,
        submissionData: result.value.submission_data,
        status: result.value.status as MirrorStatus,
      });
      if (!completed) return c.json({ success: false, error: '台帳が更新されました。再読込してください' }, 409);
      const saved = await deps.refreshMirror(c.env.DB, mirror.id);
      return saved
        ? c.json({ success: true, data: saved })
        : c.json({ success: false, error: '台帳の再取得に失敗しました' }, 500);
    } finally {
      await deps.releaseClaim(c.env.DB, mirror.id, token).catch(() => {
        console.error('Formaloo recurring submission claim release failed');
      });
    }
  };

  routes.patch('/api/forms-advanced/:id/recurring-submissions/:slug', (c) => runStatus(c));
  // Formaloo has no DELETE operation for this resource; REST delete maps to its official cancelled status.
  routes.delete('/api/forms-advanced/:id/recurring-submissions/:slug', (c) => runStatus(c, 'cancelled'));

  return routes;
}

export const formalooRecurringSubmissions = createFormalooRecurringSubmissionRoutes();
