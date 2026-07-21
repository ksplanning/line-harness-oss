import { Hono, type Context } from 'hono';
import {
  acquireFormalooFormOperationLock,
  FormalooRecurringReservationUnavailableError,
  claimFormalooRecurringSubmission,
  completeFormalooRecurringSubmission,
  getFormalooForm,
  getFormalooRecurringSubmissionByFingerprint,
  getFormalooRecurringSubmissionByIdempotencyKey,
  getFormalooRecurringSubmissionBySlug,
  listFormalooRecurringSubmissions,
  markFormalooRecurringSubmissionFailed,
  refreshFormalooRecurringSubmission,
  releaseFormalooFormOperationLock,
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
  fingerprintFormalooRecurringRequest,
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
  getByFingerprint: typeof getFormalooRecurringSubmissionByFingerprint;
  getBySlug: typeof getFormalooRecurringSubmissionBySlug;
  reserveMirror: typeof reserveFormalooRecurringSubmission;
  claimMirror: typeof claimFormalooRecurringSubmission;
  releaseClaim: typeof releaseFormalooRecurringSubmissionClaim;
  completeMirror: typeof completeFormalooRecurringSubmission;
  markFailed: typeof markFormalooRecurringSubmissionFailed;
  refreshMirror: typeof refreshFormalooRecurringSubmission;
  acquireFormLock: typeof acquireFormalooFormOperationLock;
  releaseFormLock: typeof releaseFormalooFormOperationLock;
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
  getByFingerprint: getFormalooRecurringSubmissionByFingerprint,
  getBySlug: getFormalooRecurringSubmissionBySlug,
  reserveMirror: reserveFormalooRecurringSubmission,
  claimMirror: claimFormalooRecurringSubmission,
  releaseClaim: releaseFormalooRecurringSubmissionClaim,
  completeMirror: completeFormalooRecurringSubmission,
  markFailed: markFormalooRecurringSubmissionFailed,
  refreshMirror: refreshFormalooRecurringSubmission,
  acquireFormLock: acquireFormalooFormOperationLock,
  releaseFormLock: releaseFormalooFormOperationLock,
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

function mirrorMatches(
  mirror: FormalooRecurringSubmissionMirror,
  requestFingerprint: string,
  status: FormalooRecurringStatus,
): boolean {
  return mirror.status === status && mirror.requestFingerprint === requestFingerprint;
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

    const token = deps.generateToken();
    const nowMs = deps.now();
    if (!await deps.acquireFormLock(c.env.DB, form.id, {
      token,
      nowMs,
      leaseMs: OPERATION_LEASE_MS,
    })) {
      return c.json({ success: false, error: 'このフォームの Formaloo 操作を処理中です。少し待って再試行してください' }, 409);
    }

    try {
      const requestFingerprint = await fingerprintFormalooRecurringRequest(request);
      const byKey = await deps.getByIdempotencyKey(c.env.DB, form.id, idempotencyKey);
      if (byKey && !mirrorMatches(byKey, requestFingerprint, request.status)) {
        return c.json({ success: false, error: '同じ idempotencyKey に異なる内容は指定できません' }, 409);
      }
      const byFingerprint = await deps.getByFingerprint(c.env.DB, form.id, requestFingerprint);
      let mirror = byKey ?? byFingerprint;
      if (mirror && !mirrorMatches(mirror, requestFingerprint, request.status)) {
        return c.json({ success: false, error: '同じ内容の定期自動回答が別の状態で存在します。一覧から操作してください' }, 409);
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
      if (!mirror) {
        try {
          mirror = await deps.reserveMirror(c.env.DB, {
            formId: form.id,
            idempotencyKey,
            requestFingerprint,
            schedule: request.schedule,
            submissionData: request.submission_data,
            status: request.status as MirrorStatus,
          });
        } catch (error) {
          if (error instanceof FormalooRecurringReservationUnavailableError) {
            return c.json({ success: false, error: '配信方式が更新されました。再読込してください' }, 409);
          }
          throw error;
        }
      }
      // INSERT OR IGNORE may have returned a concurrent winner for the same key/fingerprint.
      if (!mirrorMatches(mirror, requestFingerprint, request.status)) {
        return c.json({ success: false, error: '同時登録された内容と一致しません。再読込してください' }, 409);
      }

      const claimed = await deps.claimMirror(c.env.DB, mirror.id, {
        token,
        nowMs,
        leaseMs: OPERATION_LEASE_MS,
      });
      if (!claimed) {
        const latest = await deps.refreshMirror(c.env.DB, mirror.id);
        if (
          latest?.syncState === 'synced'
          && latest.remoteSlug
          && mirrorMatches(latest, requestFingerprint, request.status)
        ) {
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
          requestFingerprint,
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
    } finally {
      await deps.releaseFormLock(c.env.DB, form.id, token).catch(() => {
        console.error('Formaloo form operation lock release failed');
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
    let request: FormalooRecurringSubmissionRequest;
    try {
      request = requestFromBody(body, form.formaloo_slug);
    } catch (error) {
      return c.json({ success: false, error: error instanceof Error ? error.message : '入力が不正です' }, 400);
    }
    const token = deps.generateToken();
    const nowMs = deps.now();
    if (!await deps.acquireFormLock(c.env.DB, form.id, { token, nowMs, leaseMs: OPERATION_LEASE_MS })) {
      return c.json({ success: false, error: 'このフォームの Formaloo 操作を処理中です' }, 409);
    }
    try {
      const mirror = await deps.getBySlug(c.env.DB, form.id, slug);
      if (!mirror) return c.json({ success: false, error: 'Not found' }, 404);
      if (mirror.status === 'cancelled') {
        return c.json({ success: false, error: '取消済みの定期自動回答は変更できません' }, 409);
      }
      const requestFingerprint = await fingerprintFormalooRecurringRequest(request);
      const conflict = await deps.getByFingerprint(c.env.DB, form.id, requestFingerprint);
      if (conflict && conflict.id !== mirror.id) {
        return c.json({ success: false, error: '同じ内容の定期自動回答がすでに存在します' }, 409);
      }
      if (!await deps.claimMirror(c.env.DB, mirror.id, { token, nowMs, leaseMs: OPERATION_LEASE_MS })) {
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
          requestFingerprint,
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
    } finally {
      await deps.releaseFormLock(c.env.DB, form.id, token).catch(() => {
        console.error('Formaloo form operation lock release failed');
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
    const token = deps.generateToken();
    const nowMs = deps.now();
    if (!await deps.acquireFormLock(c.env.DB, form.id, { token, nowMs, leaseMs: OPERATION_LEASE_MS })) {
      return c.json({ success: false, error: 'このフォームの Formaloo 操作を処理中です' }, 409);
    }
    try {
      const mirror = await deps.getBySlug(c.env.DB, form.id, slug);
      if (!mirror) return c.json({ success: false, error: 'Not found' }, 404);
      if (mirror.status === 'cancelled') {
        return status === 'cancelled' && mirror.syncState === 'synced'
          ? c.json({ success: true, data: mirror })
          : c.json({ success: false, error: '取消済みの定期自動回答は再開・変更できません' }, 409);
      }
      if (mirror.status === status && mirror.syncState === 'synced') {
        return c.json({ success: true, data: mirror });
      }
      if (!await deps.claimMirror(c.env.DB, mirror.id, { token, nowMs, leaseMs: OPERATION_LEASE_MS })) {
        return c.json({ success: false, error: '定期自動回答を処理中です' }, 409);
      }
      try {
        const client = await deps.resolveClient(c.env, form.workspace_id);
        if (!client) return c.json({ success: false, error: 'Formaloo 接続を確認してください' }, 503);
        const expected: FormalooRecurringSubmissionRequest = {
          form: form.formaloo_slug,
          schedule: mirror.schedule,
          submission_data: mirror.submissionData,
          status,
        };
        const result = await deps.changeRemoteStatus(
          deps.deadlineClient(client),
          slug,
          status,
          expected,
        );
        if (!result.ok) {
          await deps.markFailed(c.env.DB, mirror.id, {
            token, candidateSlug: result.candidateSlug, error: result.reason,
          });
          return c.json({ success: false, error: providerErrorMessage(result.reason) }, 502);
        }
        const completed = await deps.completeMirror(c.env.DB, mirror.id, {
          token,
          remoteSlug: result.slug,
          requestFingerprint: mirror.requestFingerprint,
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
    } finally {
      await deps.releaseFormLock(c.env.DB, form.id, token).catch(() => {
        console.error('Formaloo form operation lock release failed');
      });
    }
  };

  routes.patch('/api/forms-advanced/:id/recurring-submissions/:slug', (c) => runStatus(c));
  // Formaloo has no DELETE operation for this resource; REST delete maps to its official cancelled status.
  routes.delete('/api/forms-advanced/:id/recurring-submissions/:slug', (c) => runStatus(c, 'cancelled'));

  return routes;
}

export const formalooRecurringSubmissions = createFormalooRecurringSubmissionRoutes();
