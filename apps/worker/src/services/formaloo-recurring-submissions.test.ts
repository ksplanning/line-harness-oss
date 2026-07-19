import { describe, expect, test, vi } from 'vitest';
import {
  buildFormalooSchedule,
  changeFormalooRecurringSubmissionStatus,
  ensureFormalooRecurringSubmission,
  fingerprintFormalooRecurringRequest,
  updateFormalooRecurringSubmission,
  type FormalooRecurringApi,
  type FormalooRecurringSubmissionRequest,
} from './formaloo-recurring-submissions.js';

function ok(data: unknown = {}, status = 200) {
  return { ok: true as const, status, data };
}

function fail(status: number) {
  return { ok: false as const, status, error: `HTTP ${status}` };
}

function client(input?: {
  gets?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
  posts?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
  puts?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
  patches?: Array<ReturnType<typeof ok> | ReturnType<typeof fail>>;
}) {
  const gets = [...(input?.gets ?? [])];
  const posts = [...(input?.posts ?? [])];
  const puts = [...(input?.puts ?? [])];
  const patches = [...(input?.patches ?? [])];
  const api: FormalooRecurringApi = {
    get: vi.fn(async () => gets.shift() ?? fail(500)),
    post: vi.fn(async () => posts.shift() ?? fail(500)),
    put: vi.fn(async () => puts.shift() ?? fail(500)),
    patch: vi.fn(async () => patches.shift() ?? fail(500)),
  };
  return api;
}

const schedule = {
  interval: { 'provider-defined-key': 'provider-defined-value' },
  start_time: '2026-07-20T00:00:00.000Z',
  end_time: null,
};

const request: FormalooRecurringSubmissionRequest = {
  form: 'safe-disposable-form',
  schedule,
  submission_data: { inventory: 12, note: '定型報告' },
  status: 'resumed',
};

describe('buildFormalooSchedule — official ScheduleRequest contract', () => {
  test('unknown interval keys remain opaque while non-empty string values and date-time fields are pinned', () => {
    expect(buildFormalooSchedule({
      interval: { 'provider-defined-key': 'provider-defined-value' },
      startTime: '2026-07-20T09:00:00+09:00',
      endTime: null,
    })).toEqual({
      interval: { 'provider-defined-key': 'provider-defined-value' },
      start_time: '2026-07-20T09:00:00+09:00',
      end_time: null,
    });
  });

  test('OpenAPI has no minProperties, so an empty interval object is not rejected locally', () => {
    expect(buildFormalooSchedule({
      interval: {},
      startTime: '2026-07-20T00:00:00Z',
    })).toEqual({ interval: {}, start_time: '2026-07-20T00:00:00Z' });
  });

  test.each([
    [{ every: '' }, 'interval の値は空でない文字列'],
    [{ every: 1 }, 'interval の値は空でない文字列'],
    [{ every: { unit: 'day' } }, 'interval の値は空でない文字列'],
  ])('rejects an interval outside Record<string, non-empty string>: %j', (interval, message) => {
    expect(() => buildFormalooSchedule({ interval, startTime: '2026-07-20T00:00:00Z' }))
      .toThrow(message);
  });

  test('rejects a non-RFC3339 start_time without inventing a timezone', () => {
    expect(() => buildFormalooSchedule({ interval: {}, startTime: '2026-07-20T09:00' }))
      .toThrow('start_time はタイムゾーン付き日時');
  });
});

describe('Formaloo recurring-submissions provider service', () => {
  test('request fingerprint is canonical and ignores lifecycle status', async () => {
    const reordered = {
      ...request,
      schedule: {
        ...request.schedule,
        interval: { z: 'last', a: 'first' },
      },
      submission_data: { z: 2, nested: { z: true, a: false }, a: 1 },
    };
    const sameContent = {
      ...reordered,
      schedule: {
        ...reordered.schedule,
        interval: { a: 'first', z: 'last' },
      },
      submission_data: { a: 1, nested: { a: false, z: true }, z: 2 },
      status: 'paused' as const,
    };
    await expect(fingerprintFormalooRecurringRequest(reordered))
      .resolves.toBe(await fingerprintFormalooRecurringRequest(sameContent));
    await expect(fingerprintFormalooRecurringRequest({
      ...reordered,
      submission_data: { ...reordered.submission_data, a: 999 },
    })).resolves.not.toBe(await fingerprintFormalooRecurringRequest(reordered));
  });

  test('GET-before-POST and detail read-back make create idempotent and detect soft-201', async () => {
    // Hypothetical host-observed success shape used only to exercise the wired path. The official
    // response schema does not document where a detail-path slug is returned; the no-slug case below
    // pins the production fail-safe until the host checklist confirms this shape.
    const api = client({
      gets: [
        ok({ results: [] }),
        ok({ slug: 'rs_1', ...request }),
      ],
      posts: [ok({ data: { slug: 'rs_1' } }, 201)],
    });

    await expect(ensureFormalooRecurringSubmission(api, request)).resolves.toEqual({
      ok: true,
      slug: 'rs_1',
      created: true,
      value: { slug: 'rs_1', ...request },
    });
    expect(api.get).toHaveBeenNthCalledWith(1, '/v3.0/recurring-submissions/?pagination=0');
    expect(api.post).toHaveBeenCalledWith('/v3.0/recurring-submissions/', request);
    expect(api.get).toHaveBeenNthCalledWith(2, '/v3.0/recurring-submissions/rs_1/');
  });

  test('an exact existing remote schedule is adopted without another POST', async () => {
    const api = client({
      gets: [
        ok({ data: { results: [{ slug: 'rs_existing', ...request }] } }),
        ok({ data: { slug: 'rs_existing', ...request } }),
      ],
    });
    await expect(ensureFormalooRecurringSubmission(api, request)).resolves.toMatchObject({
      ok: true,
      slug: 'rs_existing',
      created: false,
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  test('POST 201 is not success when fresh detail differs from the requested status', async () => {
    const api = client({
      gets: [ok({ results: [] }), ok({ slug: 'rs_soft', ...request, status: 'paused' })],
      posts: [ok({ slug: 'rs_soft' }, 201)],
    });
    await expect(ensureFormalooRecurringSubmission(api, request)).resolves.toEqual({
      ok: false,
      reason: 'read_back_failed',
      candidateSlug: 'rs_soft',
    });
  });

  test('read-back accepts equivalent RFC3339 instants and omitted nullable end_time', async () => {
    const api = client({
      gets: [
        ok({ results: [] }),
        ok({
          slug: 'rs_normalized',
          ...request,
          schedule: {
            interval: request.schedule.interval,
            start_time: '2026-07-20T00:00:00Z',
          },
        }),
      ],
      posts: [ok({ slug: 'rs_normalized' }, 201)],
    });

    await expect(ensureFormalooRecurringSubmission(api, request)).resolves.toMatchObject({
      ok: true,
      slug: 'rs_normalized',
    });
  });

  test('missing create-response slug is surfaced as an unknown provider outcome and an id is never guessed as a slug', async () => {
    const api = client({
      gets: [ok({ results: [] })],
      posts: [ok({ id: 'undocumented-identifier', ...request }, 201)],
    });
    await expect(ensureFormalooRecurringSubmission(api, request)).resolves.toEqual({
      ok: false,
      reason: 'slug_missing',
      candidateSlug: null,
    });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test('PUT emits the complete request and updates only after an exact detail read-back', async () => {
    const api = client({
      puts: [ok({})],
      gets: [ok({ slug: 'rs_update', ...request })],
    });
    await expect(updateFormalooRecurringSubmission(api, 'rs_update', request)).resolves
      .toMatchObject({ ok: true, slug: 'rs_update' });
    expect(api.put).toHaveBeenCalledWith('/v3.0/recurring-submissions/rs_update/', request);
  });

  test.each(['paused', 'resumed', 'cancelled'] as const)(
    'PATCH emits official status %s and verifies it with a fresh GET',
    async (status) => {
      const api = client({
        patches: [ok({})],
        gets: [ok({ slug: 'rs_status', ...request, status })],
      });
      await expect(changeFormalooRecurringSubmissionStatus(
        api,
        'rs_status',
        status,
        { ...request, status },
      )).resolves
        .toMatchObject({ ok: true, value: { status } });
      expect(api.patch).toHaveBeenCalledWith('/v3.0/recurring-submissions/rs_status/', { status });
    },
  );

  test('status soft-200 is rejected when read-back changed schedule or submission identity', async () => {
    const api = client({
      patches: [ok({})],
      gets: [ok({
        slug: 'rs_status',
        ...request,
        submission_data: { inventory: 999 },
        status: 'paused',
      })],
    });
    await expect(changeFormalooRecurringSubmissionStatus(
      api,
      'rs_status',
      'paused',
      { ...request, status: 'paused' },
    )).resolves.toEqual({
      ok: false,
      reason: 'read_back_failed',
      candidateSlug: 'rs_status',
    });
  });
});
