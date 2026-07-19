import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFormalooRecurringSubmissionRoutes,
  type FormalooRecurringRouteDeps,
} from './formaloo-recurring-submissions.js';

const schedule = {
  interval: { 'provider-defined-key': 'provider-defined-value' },
  start_time: '2026-07-20T00:00:00Z',
  end_time: null,
};

const pendingMirror = {
  id: 'frs_1',
  formId: 'fa_1',
  idempotencyKey: 'attempt-1',
  requestFingerprint: '1ea579b874e06603b075fe910513ee3604a507aef01df33770fbff7c5fbbb447',
  remoteSlug: null,
  schedule,
  submissionData: { stock: 8 },
  status: 'resumed' as const,
  syncState: 'pending' as const,
  lastError: null,
  createdAt: '2026-07-19T23:00:00+09:00',
  updatedAt: '2026-07-19T23:00:00+09:00',
};

const syncedMirror = {
  ...pendingMirror,
  remoteSlug: 'rs_1',
  syncState: 'synced' as const,
};

function form(id = 'fa_1', workspaceId: string | null = 'fw_tenant_a') {
  return {
    id,
    formaloo_slug: `remote-${id}`,
    workspace_id: workspaceId,
    deleted: 0,
  };
}

function createBody() {
  return {
    idempotencyKey: 'attempt-1',
    schedule: {
      interval: { 'provider-defined-key': 'provider-defined-value' },
      startTime: '2026-07-20T00:00:00Z',
      endTime: null,
    },
    submissionData: { stock: 8 },
  };
}

function makeDeps(overrides: Partial<FormalooRecurringRouteDeps> = {}) {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() };
  const deps: Partial<FormalooRecurringRouteDeps> = {
    getForm: vi.fn(async (_db, id) => form(id) as never),
    listMirrors: vi.fn(async () => []),
    getByIdempotencyKey: vi.fn(async () => null),
    getByFingerprint: vi.fn(async () => null),
    getBySlug: vi.fn(async () => null),
    reserveMirror: vi.fn(async (_db, input) => ({
      ...pendingMirror,
      formId: input.formId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      schedule: input.schedule,
      submissionData: input.submissionData,
      status: input.status,
    })),
    claimMirror: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => undefined),
    completeMirror: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    refreshMirror: vi.fn(async () => syncedMirror),
    acquireFormLock: vi.fn(async () => true),
    releaseFormLock: vi.fn(async () => undefined),
    resolveClient: vi.fn(async () => api as never),
    deadlineClient: vi.fn((client) => client),
    ensureRemote: vi.fn(async (_client, request) => ({
      ok: true as const,
      slug: 'rs_1',
      created: true,
      value: { slug: 'rs_1', ...request },
    })),
    updateRemote: vi.fn(async (_client, slug, request) => ({
      ok: true as const,
      slug,
      created: false,
      value: { slug, ...request },
    })),
    changeRemoteStatus: vi.fn(async (_client, slug, status) => ({
      ok: true as const,
      slug,
      created: false,
      value: { slug, form: 'remote-fa_1', schedule, submission_data: { stock: 8 }, status },
    })),
    generateToken: vi.fn(() => 'operation-token'),
    now: vi.fn(() => 1_000),
    ...overrides,
  };
  return { deps: deps as FormalooRecurringRouteDeps, api };
}

function env() {
  return { DB: {} as D1Database };
}

describe('form-scoped recurring submission routes', () => {
  beforeEach(() => vi.clearAllMocks());

  test('POST uses the stored form/workspace, validates schedule, and mirrors only read-back truth', async () => {
    const { deps, api } = makeDeps();
    const routes = createFormalooRecurringSubmissionRoutes(deps);
    const response = await routes.request('/api/forms-advanced/fa_1/recurring-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody()),
    }, env() as never);

    expect(response.status).toBe(201);
    expect(deps.resolveClient).toHaveBeenCalledWith(expect.anything(), 'fw_tenant_a');
    expect(deps.ensureRemote).toHaveBeenCalledWith(api, {
      form: 'remote-fa_1',
      schedule,
      submission_data: { stock: 8 },
      status: 'resumed',
    }, { candidateSlug: null });
    expect(deps.completeMirror).toHaveBeenCalledWith(expect.anything(), 'frs_1', {
      token: 'operation-token',
      remoteSlug: 'rs_1',
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      schedule,
      submissionData: { stock: 8 },
      status: 'resumed',
    });
    expect(await response.json()).toMatchObject({ success: true, data: { remoteSlug: 'rs_1' } });
  });

  test('a synced idempotency key returns the mirror without provider IO', async () => {
    const { deps } = makeDeps({
      getByIdempotencyKey: vi.fn(async () => syncedMirror),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody()),
      },
      env() as never,
    );
    expect(response.status).toBe(200);
    expect(deps.resolveClient).not.toHaveBeenCalled();
    expect(deps.ensureRemote).not.toHaveBeenCalled();
  });

  test('a retry treats equivalent RFC3339 instants and omitted nullable end_time as the same request', async () => {
    const normalizedMirror = {
      ...syncedMirror,
      schedule: {
        interval: schedule.interval,
        start_time: '2026-07-20T00:00:00.000Z',
      },
    };
    const { deps } = makeDeps({
      getByIdempotencyKey: vi.fn(async () => normalizedMirror),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody()),
      },
      env() as never,
    );
    expect(response.status).toBe(200);
    expect(deps.ensureRemote).not.toHaveBeenCalled();
  });

  test('same idempotency key with different content is rejected instead of silently reusing it', async () => {
    const { deps } = makeDeps({ getByIdempotencyKey: vi.fn(async () => syncedMirror) });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createBody(), submissionData: { stock: 999 } }),
      },
      env() as never,
    );
    expect(response.status).toBe(409);
    expect(deps.ensureRemote).not.toHaveBeenCalled();
  });

  test('a raced reservation is revalidated before a different body can use the winning ledger', async () => {
    const { deps } = makeDeps({
      getByIdempotencyKey: vi.fn(async () => null),
      reserveMirror: vi.fn(async () => pendingMirror),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createBody(), submissionData: { stock: 999 } }),
      },
      env() as never,
    );
    expect(response.status).toBe(409);
    expect(deps.claimMirror).not.toHaveBeenCalled();
    expect(deps.ensureRemote).not.toHaveBeenCalled();
  });

  test('different idempotency keys cannot race two provider creates for identical content', async () => {
    let finishFirst!: () => void;
    const ensureRemote = vi.fn()
      .mockImplementationOnce(async (_client, remoteRequest) => new Promise((resolve) => {
        finishFirst = () => resolve({
          ok: true as const,
          slug: 'rs_1',
          created: true,
          value: { slug: 'rs_1', ...remoteRequest },
        });
      }))
      .mockImplementationOnce(async (_client, remoteRequest) => ({
        ok: true as const,
        slug: 'rs_duplicate',
        created: true,
        value: { slug: 'rs_duplicate', ...remoteRequest },
      }));
    const { deps } = makeDeps({
      acquireFormLock: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      ensureRemote,
    });
    const routes = createFormalooRecurringSubmissionRoutes(deps);
    const firstPromise = routes.request('/api/forms-advanced/fa_1/recurring-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...createBody(), idempotencyKey: 'tab-a' }),
    }, env() as never);
    await vi.waitFor(() => expect(ensureRemote).toHaveBeenCalledTimes(1));
    const second = await routes.request('/api/forms-advanced/fa_1/recurring-submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...createBody(), idempotencyKey: 'tab-b' }),
    }, env() as never);
    finishFirst();
    const first = await firstPromise;

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(ensureRemote).toHaveBeenCalledTimes(1);
  });

  test('a different key cannot bypass an unresolved identical create outcome', async () => {
    const failed = {
      ...pendingMirror,
      idempotencyKey: 'first-tab',
      syncState: 'failed' as const,
      lastError: 'slug_missing',
    };
    const { deps } = makeDeps({
      getByFingerprint: vi.fn(async () => failed),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createBody(), idempotencyKey: 'second-tab' }),
      },
      env() as never,
    );
    expect(response.status).toBe(409);
    expect(deps.claimMirror).not.toHaveBeenCalled();
    expect(deps.ensureRemote).not.toHaveBeenCalled();
  });

  test('soft-201/read-back failure keeps a candidate for retry and does not finalize D1', async () => {
    const { deps } = makeDeps({
      ensureRemote: vi.fn(async () => ({
        ok: false as const,
        reason: 'read_back_failed' as const,
        candidateSlug: 'rs_uncertain',
      })),
      refreshMirror: vi.fn(async () => ({
        ...pendingMirror,
        remoteSlug: 'rs_uncertain',
        syncState: 'failed' as const,
        lastError: 'read_back_failed',
      })),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody()),
      },
      env() as never,
    );
    expect(response.status).toBe(502);
    expect(deps.markFailed).toHaveBeenCalledWith(expect.anything(), 'frs_1', {
      token: 'operation-token', candidateSlug: 'rs_uncertain', error: 'read_back_failed',
    });
    expect(deps.completeMirror).not.toHaveBeenCalled();
  });

  test.each([
    ['fa_a', 'workspace-a'],
    ['fa_b', 'workspace-b'],
  ])('resolves the provider client from %s stored workspace (%s)', async (formId, workspaceId) => {
    const mirror = { ...pendingMirror, id: `frs_${formId}`, formId };
    const { deps } = makeDeps({
      getForm: vi.fn(async () => form(formId, workspaceId) as never),
      reserveMirror: vi.fn(async (_db, input) => ({
        ...mirror,
        requestFingerprint: input.requestFingerprint,
      })),
      refreshMirror: vi.fn(async () => ({ ...mirror, remoteSlug: 'rs_tenant', syncState: 'synced' as const })),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      `/api/forms-advanced/${formId}/recurring-submissions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody()),
      },
      env() as never,
    );
    expect(response.status).toBe(201);
    expect(deps.resolveClient).toHaveBeenCalledWith(expect.anything(), workspaceId);
  });

  test('PATCH pause verifies provider truth, while another form cannot address the same remote slug', async () => {
    const target = { ...syncedMirror, status: 'resumed' as const };
    const paused = { ...target, status: 'paused' as const };
    const getBySlug = vi.fn(async (_db, formId: string) => formId === 'fa_1' ? target : null);
    const { deps } = makeDeps({
      getBySlug,
      refreshMirror: vi.fn(async () => paused),
    });
    const routes = createFormalooRecurringSubmissionRoutes(deps);
    const pausedResponse = await routes.request(
      '/api/forms-advanced/fa_1/recurring-submissions/rs_1',
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'paused' }),
      },
      env() as never,
    );
    expect(pausedResponse.status).toBe(200);
    expect(deps.changeRemoteStatus).toHaveBeenCalledWith(
      expect.anything(),
      'rs_1',
      'paused',
      expect.objectContaining({ form: 'remote-fa_1', status: 'paused' }),
    );

    const foreignResponse = await routes.request(
      '/api/forms-advanced/fa_other/recurring-submissions/rs_1',
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      env() as never,
    );
    expect(foreignResponse.status).toBe(404);
    expect(deps.changeRemoteStatus).toHaveBeenCalledTimes(1);
  });

  test('PUT performs complete schedule replacement and DELETE maps to official cancelled status', async () => {
    const { deps } = makeDeps({
      getBySlug: vi.fn(async () => syncedMirror),
      refreshMirror: vi.fn(async () => syncedMirror),
    });
    const routes = createFormalooRecurringSubmissionRoutes(deps);
    const updated = await routes.request('/api/forms-advanced/fa_1/recurring-submissions/rs_1', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schedule: createBody().schedule,
        submissionData: { stock: 8 },
        status: 'resumed',
      }),
    }, env() as never);
    expect(updated.status).toBe(200);
    expect(deps.updateRemote).toHaveBeenCalled();

    const cancelled = await routes.request('/api/forms-advanced/fa_1/recurring-submissions/rs_1', {
      method: 'DELETE',
    }, env() as never);
    expect(cancelled.status).toBe(200);
    expect(deps.changeRemoteStatus).toHaveBeenCalledWith(
      expect.anything(),
      'rs_1',
      'cancelled',
      expect.objectContaining({ form: 'remote-fa_1', status: 'cancelled' }),
    );
  });

  test('PUT rejects an active fingerprint owned by another mirror before provider IO', async () => {
    const conflict = { ...syncedMirror, id: 'frs_other', remoteSlug: 'rs_other' };
    const { deps } = makeDeps({
      getBySlug: vi.fn(async () => syncedMirror),
      getByFingerprint: vi.fn(async () => conflict),
    });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions/rs_1',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schedule: createBody().schedule,
          submissionData: { stock: 8 },
          status: 'resumed',
        }),
      },
      env() as never,
    );
    expect(response.status).toBe(409);
    expect(deps.updateRemote).not.toHaveBeenCalled();
  });

  test('cancelled is terminal and cannot be resumed by a direct API caller', async () => {
    const cancelled = { ...syncedMirror, status: 'cancelled' as const };
    const { deps } = makeDeps({ getBySlug: vi.fn(async () => cancelled) });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions/rs_1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'resumed' }),
      },
      env() as never,
    );
    expect(response.status).toBe(409);
    expect(deps.changeRemoteStatus).not.toHaveBeenCalled();
  });

  test('repeated cancellation is idempotent and does not call the provider again', async () => {
    const cancelled = { ...syncedMirror, status: 'cancelled' as const };
    const { deps } = makeDeps({ getBySlug: vi.fn(async () => cancelled) });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions/rs_1',
      { method: 'DELETE' },
      env() as never,
    );
    expect(response.status).toBe(200);
    expect(deps.changeRemoteStatus).not.toHaveBeenCalled();
  });

  test('PUT cannot replace a cancelled recurring submission', async () => {
    const cancelled = { ...syncedMirror, status: 'cancelled' as const };
    const { deps } = makeDeps({ getBySlug: vi.fn(async () => cancelled) });
    const response = await createFormalooRecurringSubmissionRoutes(deps).request(
      '/api/forms-advanced/fa_1/recurring-submissions/rs_1',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schedule: createBody().schedule,
          submissionData: { stock: 8 },
          status: 'resumed',
        }),
      },
      env() as never,
    );
    expect(response.status).toBe(409);
    expect(deps.updateRemote).not.toHaveBeenCalled();
  });
});
