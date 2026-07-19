// Formaloo recurring-submissions provider contract.
// Official docs intentionally leave interval property names unspecified, so this module validates
// only the published Record<string, non-empty string> shape and never invents units or keys.

export type FormalooRecurringStatus = 'resumed' | 'paused' | 'cancelled';

export interface FormalooSchedule {
  interval: Record<string, string>;
  start_time: string;
  end_time?: string | null;
}

export interface FormalooRecurringSubmissionRequest {
  form: string;
  schedule: FormalooSchedule;
  submission_data: Record<string, unknown>;
  status: FormalooRecurringStatus;
}

export interface FormalooRecurringSubmission extends FormalooRecurringSubmissionRequest {
  slug: string;
}

export type FormalooRecurringApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: string };

export interface FormalooRecurringApi {
  get(path: string): Promise<FormalooRecurringApiResult>;
  post(path: string, body?: unknown): Promise<FormalooRecurringApiResult>;
  put(path: string, body?: unknown): Promise<FormalooRecurringApiResult>;
  patch(path: string, body?: unknown): Promise<FormalooRecurringApiResult>;
}

export type RecurringWriteResult =
  | { ok: true; slug: string; created: boolean; value: FormalooRecurringSubmission }
  | {
      ok: false;
      reason:
        | 'read_failed'
        | 'create_failed'
        | 'slug_missing'
        | 'update_failed'
        | 'status_failed'
        | 'read_back_failed';
      candidateSlug: string | null;
    };

const COLLECTION_PATH = '/v3.0/recurring-submissions/';
const LIST_PATH = `${COLLECTION_PATH}?pagination=0`;
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string'
    && RFC3339_DATE_TIME.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function buildFormalooSchedule(input: {
  interval: unknown;
  startTime: unknown;
  endTime?: unknown;
}): FormalooSchedule {
  const intervalRecord = asRecord(input.interval);
  if (!intervalRecord) throw new Error('interval は object で指定してください');
  const interval: Record<string, string> = {};
  for (const [key, value] of Object.entries(intervalRecord)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('interval の値は空でない文字列で指定してください');
    }
    interval[key] = value;
  }
  if (!isDateTime(input.startTime)) {
    throw new Error('start_time はタイムゾーン付き日時で指定してください');
  }
  if (input.endTime !== undefined && input.endTime !== null && !isDateTime(input.endTime)) {
    throw new Error('end_time はタイムゾーン付き日時または null で指定してください');
  }
  return {
    interval,
    start_time: input.startTime,
    ...(input.endTime !== undefined ? { end_time: input.endTime as string | null } : {}),
  };
}

function detailPath(slug: string): string {
  return `${COLLECTION_PATH}${encodeURIComponent(slug)}/`;
}

function collectRecords(root: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if ('form' in record || 'schedule' in record || 'slug' in record || 'id' in record) {
      found.push(record);
    }
    for (const key of ['data', 'results', 'recurring_submission', 'recurring_submissions']) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

function candidateSlug(root: unknown): string | null {
  for (const record of collectRecords(root)) {
    // OpenAPI does not document another identifier as interchangeable with the detail-path slug.
    // In particular, never guess that an `id` can be used in /{slug}/.
    const value = record.slug;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function normalizeRecurring(record: Record<string, unknown>): FormalooRecurringSubmission | null {
  const slug = record.slug;
  if (typeof slug !== 'string' || slug.length === 0 || typeof record.form !== 'string') return null;
  const rawSchedule = asRecord(record.schedule);
  if (!rawSchedule) return null;
  let schedule: FormalooSchedule;
  try {
    schedule = buildFormalooSchedule({
      interval: rawSchedule.interval,
      startTime: rawSchedule.start_time,
      ...(Object.prototype.hasOwnProperty.call(rawSchedule, 'end_time')
        ? { endTime: rawSchedule.end_time }
        : {}),
    });
  } catch {
    return null;
  }
  const status = record.status;
  if (status !== 'resumed' && status !== 'paused' && status !== 'cancelled') return null;
  return {
    slug,
    form: record.form,
    schedule,
    submission_data: asRecord(record.submission_data) ?? {},
    status,
  };
}

function recurringValues(root: unknown): FormalooRecurringSubmission[] {
  return collectRecords(root)
    .map(normalizeRecurring)
    .filter((value): value is FormalooRecurringSubmission => value !== null);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
  );
}

export async function fingerprintFormalooRecurringRequest(
  request: FormalooRecurringSubmissionRequest,
): Promise<string> {
  const identity = canonical({
    form: request.form,
    schedule: {
      interval: request.schedule.interval,
      start_time: new Date(request.schedule.start_time).toISOString(),
      end_time: request.schedule.end_time == null
        ? null
        : new Date(request.schedule.end_time).toISOString(),
    },
    submission_data: request.submission_data,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function equalDateTime(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function equalSchedule(left: FormalooSchedule, right: FormalooSchedule): boolean {
  const leftEnd = left.end_time ?? null;
  const rightEnd = right.end_time ?? null;
  return equalJson(left.interval, right.interval)
    && equalDateTime(left.start_time, right.start_time)
    && (leftEnd === null || rightEnd === null
      ? leftEnd === rightEnd
      : equalDateTime(leftEnd, rightEnd));
}

function matchesRequest(
  value: FormalooRecurringSubmission,
  expected: FormalooRecurringSubmissionRequest,
): boolean {
  return value.form === expected.form
    && value.status === expected.status
    && equalSchedule(value.schedule, expected.schedule)
    && equalJson(value.submission_data, expected.submission_data);
}

async function readVerified(
  client: FormalooRecurringApi,
  slug: string,
  expected: FormalooRecurringSubmissionRequest,
): Promise<FormalooRecurringSubmission | null> {
  const result = await client.get(detailPath(slug));
  if (!result.ok) return null;
  return recurringValues(result.data).find((value) => value.slug === slug && matchesRequest(value, expected)) ?? null;
}

export async function ensureFormalooRecurringSubmission(
  client: FormalooRecurringApi,
  request: FormalooRecurringSubmissionRequest,
  options: { candidateSlug?: string | null } = {},
): Promise<RecurringWriteResult> {
  if (options.candidateSlug) {
    const verified = await readVerified(client, options.candidateSlug, request);
    return verified
      ? { ok: true, slug: verified.slug, created: false, value: verified }
      : { ok: false, reason: 'read_back_failed', candidateSlug: options.candidateSlug };
  }

  const before = await client.get(LIST_PATH);
  if (!before.ok) return { ok: false, reason: 'read_failed', candidateSlug: null };
  const existing = recurringValues(before.data).find((value) => matchesRequest(value, request));
  if (existing) {
    const verified = await readVerified(client, existing.slug, request);
    return verified
      ? { ok: true, slug: verified.slug, created: false, value: verified }
      : { ok: false, reason: 'read_back_failed', candidateSlug: existing.slug };
  }

  const created = await client.post(COLLECTION_PATH, request);
  if (!created.ok) return { ok: false, reason: 'create_failed', candidateSlug: null };
  const slug = candidateSlug(created.data);
  if (!slug) return { ok: false, reason: 'slug_missing', candidateSlug: null };
  const verified = await readVerified(client, slug, request);
  return verified
    ? { ok: true, slug, created: true, value: verified }
    : { ok: false, reason: 'read_back_failed', candidateSlug: slug };
}

export async function updateFormalooRecurringSubmission(
  client: FormalooRecurringApi,
  slug: string,
  request: FormalooRecurringSubmissionRequest,
): Promise<RecurringWriteResult> {
  const updated = await client.put(detailPath(slug), request);
  if (!updated.ok) return { ok: false, reason: 'update_failed', candidateSlug: slug };
  const verified = await readVerified(client, slug, request);
  return verified
    ? { ok: true, slug, created: false, value: verified }
    : { ok: false, reason: 'read_back_failed', candidateSlug: slug };
}

export async function changeFormalooRecurringSubmissionStatus(
  client: FormalooRecurringApi,
  slug: string,
  status: FormalooRecurringStatus,
  expected: FormalooRecurringSubmissionRequest,
): Promise<RecurringWriteResult> {
  const updated = await client.patch(detailPath(slug), { status });
  if (!updated.ok) return { ok: false, reason: 'status_failed', candidateSlug: slug };
  const readBack = await client.get(detailPath(slug));
  if (!readBack.ok) return { ok: false, reason: 'read_back_failed', candidateSlug: slug };
  const expectedAfterWrite = { ...expected, status };
  const value = recurringValues(readBack.data)
    .find((item) => item.slug === slug && matchesRequest(item, expectedAfterWrite));
  return value
    ? { ok: true, slug, created: false, value }
    : { ok: false, reason: 'read_back_failed', candidateSlug: slug };
}
