import { LineApiError, LineClient } from '@line-crm/line-sdk';
import type { FollowerIdsPage, UserProfile } from '@line-crm/line-sdk';

export const ACCOUNT_NOT_VERIFIED_MESSAGE =
  'このアカウントは認証済みではないため利用できません (LINE の仕様)';
const LINE_ACCOUNT_UNAVAILABLE_MESSAGE =
  'LINEアカウントが無効または削除されたため、取り込みを続けられません。';

const DEFAULT_PROFILE_BATCH_SIZE = 10;
const DEFAULT_PROFILE_INTERVAL_MS = 1_000;
const DEFAULT_PROFILE_RETRY_DELAY_MS = 5_000;
const DEFAULT_FOLLOWER_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_PROFILE_ATTEMPTS = 3;
const DEFAULT_API_TIMEOUT_MS = 15_000;
// The scheduled handler shares one Worker invocation with broadcasts, health,
// reminders, and other cron work. Advance one import only so its LINE/D1 calls
// cannot consume the shared subrequest budget.
const DEFAULT_DUE_JOB_LIMIT = 1;
const JOB_LOCK_MS = 60_000;

type StoredJobStatus = 'running' | 'completed' | 'failed';
type StoredJobPhase = 'followers' | 'profiles' | 'completed';

interface FollowerImportJobRow {
  id: string;
  account_id: string;
  status: StoredJobStatus;
  phase: StoredJobPhase;
  continuation_token: string | null;
  fetched_count: number;
  new_count: number;
  existing_count: number;
  profile_processed_count: number;
  failed_count: number;
  next_run_at: string | null;
  lock_token: string | null;
  locked_until: string | null;
  last_error_code: string | null;
  last_error: string | null;
  requested_by_id: string;
  requested_by_name: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PendingProfileRow {
  line_user_id: string;
  friend_id: string;
  profile_attempts: number;
}

interface ProfileResult {
  lineUserId: string;
  friendId: string;
  profileStatus: 'succeeded' | 'pending' | 'failed';
  profileAttempts: number;
  nextAttemptAt: string | null;
  errorMessage: string | null;
  displayName: string | null;
  pictureUrl: string | null;
  statusMessage: string | null;
}

export interface FollowerImportClient {
  getFollowerIds(start?: string, limit?: number): Promise<FollowerIdsPage>;
  getProfile(userId: string): Promise<UserProfile>;
}

export interface FollowerImportDependencies {
  createClient?: (channelAccessToken: string) => FollowerImportClient;
  now?: () => Date;
  profileBatchSize?: number;
  profileIntervalMs?: number;
  profileRetryDelayMs?: number;
  followerRetryDelayMs?: number;
  maxProfileAttempts?: number;
  apiTimeoutMs?: number;
  dueJobLimit?: number;
}

export interface FollowerImportAccount {
  id: string;
  channelAccessToken: string;
  isActive: boolean;
}

export interface FollowerImportActor {
  id: string;
  name: string;
}

export interface FollowerImportJob {
  id: string;
  accountId: string;
  status: 'fetching' | 'profiling' | 'completed' | 'failed';
  continuationToken: string | null;
  fetchedCount: number;
  newCount: number;
  existingCount: number;
  profileCompletedCount: number;
  failedCount: number;
  nextRunAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface FollowerImportDueResult {
  attempted: number;
  completed: number;
  failed: number;
  retrying: number;
}

export class FollowerImportConflictError extends Error {
  constructor(public readonly job: FollowerImportJob) {
    super('follower import already running');
    this.name = 'FollowerImportConflictError';
  }
}

export class FollowerImportAccountNotVerifiedError extends Error {
  constructor(
    public readonly job: FollowerImportJob,
    public readonly status: 403 | 404,
  ) {
    super(ACCOUNT_NOT_VERIFIED_MESSAGE);
    this.name = 'FollowerImportAccountNotVerifiedError';
  }
}

export class FollowerImportLineApiError extends Error {
  constructor(public readonly job: FollowerImportJob) {
    super('LINE API への接続に失敗しました。進捗は保存されているため、もう一度お試しください。');
    this.name = 'FollowerImportLineApiError';
  }
}

function resolveDependencies(dependencies: FollowerImportDependencies) {
  return {
    createClient: dependencies.createClient ?? ((token: string) => new LineClient(token)),
    now: dependencies.now ?? (() => new Date()),
    profileBatchSize: dependencies.profileBatchSize ?? DEFAULT_PROFILE_BATCH_SIZE,
    profileIntervalMs: dependencies.profileIntervalMs ?? DEFAULT_PROFILE_INTERVAL_MS,
    profileRetryDelayMs: dependencies.profileRetryDelayMs ?? DEFAULT_PROFILE_RETRY_DELAY_MS,
    followerRetryDelayMs: dependencies.followerRetryDelayMs ?? DEFAULT_FOLLOWER_RETRY_DELAY_MS,
    maxProfileAttempts: dependencies.maxProfileAttempts ?? DEFAULT_MAX_PROFILE_ATTEMPTS,
    apiTimeoutMs: dependencies.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    dueJobLimit: dependencies.dueJobLimit ?? DEFAULT_DUE_JOB_LIMIT,
  };
}

function serializeJob(row: FollowerImportJobRow): FollowerImportJob {
  const status: FollowerImportJob['status'] = row.status === 'failed'
    ? 'failed'
    : row.status === 'completed'
      ? 'completed'
      : row.phase === 'followers' ? 'fetching' : 'profiling';
  return {
    id: row.id,
    accountId: row.account_id,
    status,
    continuationToken: row.continuation_token,
    fetchedCount: row.fetched_count,
    newCount: row.new_count,
    existingCount: row.existing_count,
    profileCompletedCount: row.profile_processed_count,
    failedCount: row.failed_count,
    nextRunAt: row.next_run_at,
    errorCode: row.last_error_code,
    errorMessage: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function getJobRow(
  db: D1Database,
  jobId: string,
  accountId?: string,
): Promise<FollowerImportJobRow | null> {
  const row = accountId
    ? await db.prepare('SELECT * FROM friend_import_jobs WHERE id = ? AND account_id = ?')
      .bind(jobId, accountId).first<FollowerImportJobRow>()
    : await db.prepare('SELECT * FROM friend_import_jobs WHERE id = ?')
      .bind(jobId).first<FollowerImportJobRow>();
  return row ?? null;
}

export async function getLatestFollowerImportJob(
  db: D1Database,
  accountId: string,
): Promise<FollowerImportJob | null> {
  const row = await db.prepare(`
    SELECT * FROM friend_import_jobs
     WHERE account_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).bind(accountId).first<FollowerImportJobRow>();
  return row ? serializeJob(row) : null;
}

function ownsLease(row: FollowerImportJobRow, lockToken: string, nowIso: string): boolean {
  return row.lock_token === lockToken
    && row.locked_until !== null
    && row.locked_until > nowIso;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('LINE API request timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fencedAuditStatement(
  db: D1Database,
  auditId: string,
  jobId: string,
  lockToken: string,
  nowIso: string,
  eventType: string,
  detail: Record<string, unknown> | null = null,
): D1PreparedStatement {
  return db.prepare(`
    INSERT OR IGNORE INTO friend_import_audit_log
      (id, job_id, account_id, event_type, actor_id, actor_name,
       new_count, existing_count, failed_count, detail)
    SELECT ?, j.id, j.account_id, ?, j.requested_by_id, j.requested_by_name,
           j.new_count, j.existing_count, j.failed_count, ?
      FROM friend_import_jobs j
     WHERE j.id = ? AND j.lock_token = ? AND j.locked_until > ?
  `).bind(
    auditId,
    eventType,
    detail ? JSON.stringify(detail) : null,
    jobId,
    lockToken,
    nowIso,
  );
}

async function ensureTerminalAudit(db: D1Database, row: FollowerImportJobRow): Promise<void> {
  if (row.status !== 'completed' && row.status !== 'failed') return;
  await db.prepare(`
    INSERT OR IGNORE INTO friend_import_audit_log
      (id, job_id, account_id, event_type, actor_id, actor_name,
       new_count, existing_count, failed_count, detail)
    SELECT ?, j.id, j.account_id, ?, j.requested_by_id, j.requested_by_name,
           j.new_count, j.existing_count, j.failed_count, NULL
      FROM friend_import_jobs j
     WHERE j.id = ? AND j.status = ?
  `).bind(`${row.id}:${row.status}`, row.status, row.id, row.status).run();
}

async function markTerminalFailure(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  nowIso: string,
  errorCode: string,
  errorMessage: string,
  detail: Record<string, unknown>,
): Promise<{ job: FollowerImportJob; applied: boolean }> {
  await db.batch([
    db.prepare(`
      UPDATE friend_import_jobs
         SET status = 'failed',
             fetched_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ?),
             new_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'new'),
             existing_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'existing'),
             profile_processed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND outcome = 'new' AND profile_status = 'succeeded'
             ),
             failed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND (
                  outcome = 'conflict' OR (outcome = 'new' AND profile_status = 'failed')
                )
             ),
             last_error_code = ?, last_error = ?,
             next_run_at = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
    `).bind(
      row.id,
      row.id,
      row.id,
      row.id,
      row.id,
      errorCode,
      errorMessage,
      nowIso,
      nowIso,
      row.id,
      lockToken,
      nowIso,
    ),
    fencedAuditStatement(
      db,
      `${row.id}:failed`,
      row.id,
      lockToken,
      nowIso,
      'failed',
      detail,
    ),
  ]);
  const current = await getJobRow(db, row.id, row.account_id);
  if (!current) throw new Error('follower import job disappeared');
  return {
    job: serializeJob(current),
    applied: current.status === 'failed' && current.last_error_code === errorCode,
  };
}

async function markEligibilityFailure(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  status: 403 | 404,
  nowIso: string,
): Promise<{ job: FollowerImportJob; applied: boolean }> {
  return markTerminalFailure(
    db,
    row,
    lockToken,
    nowIso,
    'account_not_verified',
    ACCOUNT_NOT_VERIFIED_MESSAGE,
    { errorCode: 'account_not_verified', lineStatus: status },
  );
}

async function scheduleFollowerRetry(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  error: unknown,
  now: Date,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<{ job: FollowerImportJob; applied: boolean }> {
  const nowIso = now.toISOString();
  const nextRunAt = new Date(now.getTime() + dependencies.followerRetryDelayMs).toISOString();
  const message = safeErrorMessage(error);
  await db.batch([
    db.prepare(`
      UPDATE friend_import_jobs
         SET last_error_code = 'line_api_error', last_error = ?,
             next_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
    `).bind(message, nextRunAt, nowIso, row.id, lockToken, nowIso),
    fencedAuditStatement(
      db,
      `${row.id}:followers-retry:${nowIso}`,
      row.id,
      lockToken,
      nowIso,
      'retry_scheduled',
      { phase: 'followers', error: message },
    ),
  ]);
  const current = await getJobRow(db, row.id, row.account_id);
  if (!current) throw new Error('follower import job disappeared');
  return {
    job: serializeJob(current),
    applied: ownsLease(current, lockToken, nowIso) && current.last_error_code === 'line_api_error',
  };
}

function followerPageStatements(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  lineUserIds: string[],
  returnedCount: number,
  next: string | null,
  nowIso: string,
): D1PreparedStatement[] {
  const incoming = JSON.stringify(lineUserIds.map((lineUserId) => ({
    lineUserId,
    generatedFriendId: crypto.randomUUID(),
  })));
  const phase: StoredJobPhase = next ? 'followers' : 'profiles';
  const pageKey = row.continuation_token ?? 'initial';
  return [
    db.prepare(`
      WITH incoming AS (
        SELECT json_extract(value, '$.lineUserId') AS line_user_id,
               json_extract(value, '$.generatedFriendId') AS generated_friend_id
          FROM json_each(?)
      )
      INSERT OR IGNORE INTO friend_import_items
        (job_id, line_user_id, friend_id, outcome, profile_status, created_at, updated_at)
      SELECT ?, incoming.line_user_id,
             COALESCE(f.id, incoming.generated_friend_id),
             CASE
               WHEN f.id IS NULL THEN 'new'
               WHEN f.line_account_id = ? THEN 'existing'
               ELSE 'conflict'
             END,
             CASE WHEN f.id IS NULL THEN 'pending' ELSE 'not_required' END,
             ?, ?
        FROM incoming
        LEFT JOIN friends f ON f.line_user_id = incoming.line_user_id
       WHERE EXISTS (
         SELECT 1 FROM friend_import_jobs j
          WHERE j.id = ? AND j.status = 'running'
            AND j.lock_token = ? AND j.locked_until > ?
       )
    `).bind(incoming, row.id, row.account_id, nowIso, nowIso, row.id, lockToken, nowIso),
    db.prepare(`
      WITH incoming AS (
        SELECT json_extract(value, '$.lineUserId') AS line_user_id
          FROM json_each(?)
      )
      INSERT OR IGNORE INTO friends
        (id, line_user_id, display_name, picture_url, status_message, is_following,
         line_account_id, source, created_at, updated_at)
      SELECT i.friend_id, i.line_user_id, NULL, NULL, NULL, 1,
             ?, 'followers_import', ?, ?
        FROM friend_import_items i
        JOIN incoming ON incoming.line_user_id = i.line_user_id
       WHERE i.job_id = ? AND i.outcome = 'new'
         AND EXISTS (
           SELECT 1 FROM friend_import_jobs j
            WHERE j.id = ? AND j.status = 'running'
              AND j.lock_token = ? AND j.locked_until > ?
         )
    `).bind(incoming, row.account_id, nowIso, nowIso, row.id, row.id, lockToken, nowIso),
    db.prepare(`
      WITH incoming AS (
        SELECT json_extract(value, '$.lineUserId') AS line_user_id
          FROM json_each(?)
      )
      UPDATE friend_import_items
         SET friend_id = (
               SELECT f.id FROM friends f
                WHERE f.line_user_id = friend_import_items.line_user_id
             ),
             outcome = CASE
               WHEN (
                 SELECT f.line_account_id FROM friends f
                  WHERE f.line_user_id = friend_import_items.line_user_id
               ) = ? THEN 'existing'
               ELSE 'conflict'
             END,
             profile_status = 'not_required', updated_at = ?
       WHERE job_id = ? AND outcome = 'new'
         AND line_user_id IN (SELECT line_user_id FROM incoming)
         AND NOT EXISTS (
           SELECT 1 FROM friends f WHERE f.id = friend_import_items.friend_id
         )
         AND EXISTS (
           SELECT 1 FROM friends f WHERE f.line_user_id = friend_import_items.line_user_id
         )
         AND EXISTS (
           SELECT 1 FROM friend_import_jobs j
            WHERE j.id = ? AND j.status = 'running'
              AND j.lock_token = ? AND j.locked_until > ?
         )
    `).bind(incoming, row.account_id, nowIso, row.id, row.id, lockToken, nowIso),
    db.prepare(`
      UPDATE friend_import_jobs
         SET phase = ?, continuation_token = ?,
             fetched_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ?),
             new_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'new'),
             existing_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'existing'),
             profile_processed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND outcome = 'new' AND profile_status = 'succeeded'
             ),
             failed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND (
                  outcome = 'conflict' OR (outcome = 'new' AND profile_status = 'failed')
                )
             ),
             next_run_at = NULL, last_error_code = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
    `).bind(
      phase,
      next,
      row.id,
      row.id,
      row.id,
      row.id,
      row.id,
      nowIso,
      row.id,
      lockToken,
      nowIso,
    ),
    fencedAuditStatement(
      db,
      `${row.id}:followers:${pageKey}`,
      row.id,
      lockToken,
      nowIso,
      'followers_page',
      { returnedCount, uniquePageCount: lineUserIds.length, hasNext: next !== null },
    ),
  ];
}

async function processFollowerPage(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  client: FollowerImportClient,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<FollowerImportJob> {
  let page: FollowerIdsPage;
  try {
    page = await withTimeout(
      client.getFollowerIds(row.continuation_token ?? undefined, 1000),
      dependencies.apiTimeoutMs,
    );
    const hasValidFollowerIds = page
      && Array.isArray(page.userIds)
      && page.userIds.length <= 1000
      && page.userIds.every(
        (lineUserId): lineUserId is string => typeof lineUserId === 'string' && lineUserId.length > 0,
      );
    const hasValidContinuation = page
      && (page.next === undefined || (typeof page.next === 'string' && page.next.length > 0));
    if (!hasValidFollowerIds || !hasValidContinuation) {
      throw new Error('LINE followers response is invalid');
    }
  } catch (error) {
    const failureNow = dependencies.now();
    if (error instanceof LineApiError && (error.status === 403 || error.status === 404)) {
      const failed = await markEligibilityFailure(
        db,
        row,
        lockToken,
        error.status,
        failureNow.toISOString(),
      );
      if (failed.applied) throw new FollowerImportAccountNotVerifiedError(failed.job, error.status);
      return failed.job;
    }
    const retrying = await scheduleFollowerRetry(db, row, lockToken, error, failureNow, dependencies);
    if (retrying.applied) throw new FollowerImportLineApiError(retrying.job);
    return retrying.job;
  }

  const nowIso = dependencies.now().toISOString();
  const uniqueIds = [...new Set(page.userIds)];
  const next = typeof page.next === 'string' && page.next.length > 0 ? page.next : null;
  await db.batch(followerPageStatements(
    db,
    row,
    lockToken,
    uniqueIds,
    page.userIds.length,
    next,
    nowIso,
  ));
  const current = await getJobRow(db, row.id, row.account_id);
  if (!current) throw new Error('follower import job disappeared');
  return serializeJob(current);
}

async function completeJob(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  nowIso: string,
): Promise<FollowerImportJob> {
  await db.batch([
    db.prepare(`
      UPDATE friend_import_jobs
         SET status = 'completed', phase = 'completed', continuation_token = NULL,
             fetched_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ?),
             new_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'new'),
             existing_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'existing'),
             profile_processed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND outcome = 'new' AND profile_status = 'succeeded'
             ),
             failed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND (
                  outcome = 'conflict' OR (outcome = 'new' AND profile_status = 'failed')
                )
             ),
             next_run_at = NULL, last_error_code = NULL, last_error = NULL,
             completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
    `).bind(
      row.id,
      row.id,
      row.id,
      row.id,
      row.id,
      nowIso,
      nowIso,
      row.id,
      lockToken,
      nowIso,
    ),
    fencedAuditStatement(db, `${row.id}:completed`, row.id, lockToken, nowIso, 'completed'),
  ]);
  const current = await getJobRow(db, row.id, row.account_id);
  if (!current) throw new Error('follower import job disappeared');
  return serializeJob(current);
}

function profileMutationStatements(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  results: ProfileResult[],
  nowIso: string,
  nextRunAt: string,
): D1PreparedStatement[] {
  const successful = results.filter((result) => result.profileStatus === 'succeeded');
  const statements: D1PreparedStatement[] = [];
  if (successful.length > 0) {
    statements.push(db.prepare(`
      WITH profiles AS (
        SELECT json_extract(value, '$.friendId') AS friend_id,
               json_extract(value, '$.displayName') AS display_name,
               json_extract(value, '$.pictureUrl') AS picture_url,
               json_extract(value, '$.statusMessage') AS status_message
          FROM json_each(?)
      )
      UPDATE friends
         SET display_name = (SELECT display_name FROM profiles WHERE friend_id = friends.id),
             picture_url = (SELECT picture_url FROM profiles WHERE friend_id = friends.id),
             status_message = (SELECT status_message FROM profiles WHERE friend_id = friends.id),
             updated_at = ?
       WHERE id IN (SELECT friend_id FROM profiles)
         AND source = 'followers_import'
         AND EXISTS (
           SELECT 1 FROM friend_import_items i
            WHERE i.job_id = ? AND i.friend_id = friends.id AND i.outcome = 'new'
         )
         AND EXISTS (
           SELECT 1 FROM friend_import_jobs j
            WHERE j.id = ? AND j.status = 'running'
              AND j.lock_token = ? AND j.locked_until > ?
         )
    `).bind(JSON.stringify(successful), nowIso, row.id, row.id, lockToken, nowIso));
  }
  statements.push(
    db.prepare(`
      WITH outcomes AS (
        SELECT json_extract(value, '$.lineUserId') AS line_user_id,
               json_extract(value, '$.profileStatus') AS profile_status,
               json_extract(value, '$.profileAttempts') AS profile_attempts,
               json_extract(value, '$.nextAttemptAt') AS next_attempt_at,
               json_extract(value, '$.errorMessage') AS error_message
          FROM json_each(?)
      )
      UPDATE friend_import_items
         SET profile_status = (
               SELECT profile_status FROM outcomes
                WHERE line_user_id = friend_import_items.line_user_id
             ),
             profile_attempts = (
               SELECT profile_attempts FROM outcomes
                WHERE line_user_id = friend_import_items.line_user_id
             ),
             next_attempt_at = (
               SELECT next_attempt_at FROM outcomes
                WHERE line_user_id = friend_import_items.line_user_id
             ),
             error_message = (
               SELECT error_message FROM outcomes
                WHERE line_user_id = friend_import_items.line_user_id
             ),
             updated_at = ?
       WHERE job_id = ? AND outcome = 'new'
         AND line_user_id IN (SELECT line_user_id FROM outcomes)
         AND EXISTS (
           SELECT 1 FROM friend_import_jobs j
            WHERE j.id = ? AND j.status = 'running'
              AND j.lock_token = ? AND j.locked_until > ?
         )
    `).bind(JSON.stringify(results), nowIso, row.id, row.id, lockToken, nowIso),
    db.prepare(`
      UPDATE friend_import_jobs
         SET fetched_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ?),
             new_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'new'),
             existing_count = (SELECT COUNT(*) FROM friend_import_items WHERE job_id = ? AND outcome = 'existing'),
             profile_processed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND outcome = 'new' AND profile_status = 'succeeded'
             ),
             failed_count = (
               SELECT COUNT(*) FROM friend_import_items
                WHERE job_id = ? AND (
                  outcome = 'conflict' OR (outcome = 'new' AND profile_status = 'failed')
                )
             ),
             next_run_at = CASE WHEN EXISTS (
               SELECT 1 FROM friend_import_items
                WHERE job_id = ? AND outcome = 'new' AND profile_status = 'pending'
             ) THEN ? ELSE NULL END,
             last_error_code = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
    `).bind(
      row.id,
      row.id,
      row.id,
      row.id,
      row.id,
      row.id,
      nextRunAt,
      nowIso,
      row.id,
      lockToken,
      nowIso,
    ),
    fencedAuditStatement(
      db,
      `${row.id}:profiles:${nowIso}`,
      row.id,
      lockToken,
      nowIso,
      'profiles_batch',
      { batchSize: results.length },
    ),
  );
  return statements;
}

async function processProfileBatch(
  db: D1Database,
  row: FollowerImportJobRow,
  lockToken: string,
  client: FollowerImportClient,
  dependencies: ReturnType<typeof resolveDependencies>,
): Promise<FollowerImportJob> {
  const startedAt = dependencies.now();
  const startedIso = startedAt.toISOString();
  const pending = await db.prepare(`
    SELECT line_user_id, friend_id, profile_attempts
      FROM friend_import_items
     WHERE job_id = ? AND outcome = 'new' AND profile_status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       AND EXISTS (
         SELECT 1 FROM friend_import_jobs j
          WHERE j.id = ? AND j.status = 'running'
            AND j.lock_token = ? AND j.locked_until > ?
       )
     ORDER BY line_user_id
     LIMIT ?
  `).bind(
    row.id,
    startedIso,
    row.id,
    lockToken,
    startedIso,
    dependencies.profileBatchSize,
  ).all<PendingProfileRow>();

  if (pending.results.length === 0) {
    const remaining = await db.prepare(`
      SELECT COUNT(*) AS count, MIN(next_attempt_at) AS next_attempt_at
        FROM friend_import_items
       WHERE job_id = ? AND outcome = 'new' AND profile_status = 'pending'
    `).bind(row.id).first<{ count: number; next_attempt_at: string | null }>();
    if (!remaining || remaining.count === 0) return completeJob(db, row, lockToken, startedIso);
    await db.prepare(`
      UPDATE friend_import_jobs SET next_run_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lock_token = ? AND locked_until > ?
    `).bind(remaining.next_attempt_at, startedIso, row.id, lockToken, startedIso).run();
    const waiting = await getJobRow(db, row.id, row.account_id);
    if (!waiting) throw new Error('follower import job disappeared');
    return serializeJob(waiting);
  }

  const results = await Promise.all(pending.results.map(async (item): Promise<ProfileResult> => {
    try {
      const profile = await withTimeout(client.getProfile(item.line_user_id), dependencies.apiTimeoutMs);
      if (!profile || typeof profile.displayName !== 'string' || profile.displayName.length === 0) {
        throw new Error('LINE profile response is invalid');
      }
      return {
        lineUserId: item.line_user_id,
        friendId: item.friend_id,
        profileStatus: 'succeeded',
        profileAttempts: item.profile_attempts + 1,
        nextAttemptAt: null,
        errorMessage: null,
        displayName: profile.displayName,
        pictureUrl: profile.pictureUrl ?? null,
        statusMessage: profile.statusMessage ?? null,
      };
    } catch (error) {
      const attempts = item.profile_attempts + 1;
      const unavailable = error instanceof LineApiError && (error.status === 403 || error.status === 404);
      const terminal = unavailable || attempts >= dependencies.maxProfileAttempts;
      const resultNow = dependencies.now();
      return {
        lineUserId: item.line_user_id,
        friendId: item.friend_id,
        profileStatus: terminal ? 'failed' : 'pending',
        profileAttempts: attempts,
        nextAttemptAt: terminal
          ? null
          : new Date(resultNow.getTime() + dependencies.profileRetryDelayMs).toISOString(),
        errorMessage: safeErrorMessage(error),
        displayName: null,
        pictureUrl: null,
        statusMessage: null,
      };
    }
  }));

  const writeNow = dependencies.now();
  const nowIso = writeNow.toISOString();
  const nextRunAt = new Date(writeNow.getTime() + dependencies.profileIntervalMs).toISOString();
  await db.batch(profileMutationStatements(db, row, lockToken, results, nowIso, nextRunAt));
  const current = await getJobRow(db, row.id, row.account_id);
  if (!current) throw new Error('follower import job disappeared');
  if (!ownsLease(current, lockToken, nowIso) || current.status !== 'running') {
    return serializeJob(current);
  }
  if (current.next_run_at === null) return completeJob(db, current, lockToken, nowIso);
  return serializeJob(current);
}

export async function startFollowerImport(
  db: D1Database,
  account: FollowerImportAccount,
  actor: FollowerImportActor,
  dependencyOverrides: FollowerImportDependencies = {},
): Promise<FollowerImportJob> {
  const running = await db.prepare(`
    SELECT * FROM friend_import_jobs
     WHERE account_id = ? AND status = 'running'
     ORDER BY created_at DESC, id DESC LIMIT 1
  `).bind(account.id).first<FollowerImportJobRow>();
  if (running) throw new FollowerImportConflictError(serializeJob(running));

  const dependencies = resolveDependencies(dependencyOverrides);
  const jobId = crypto.randomUUID();
  const nowIso = dependencies.now().toISOString();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO friend_import_jobs
          (id, account_id, requested_by_id, requested_by_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(jobId, account.id, actor.id, actor.name, nowIso, nowIso),
      db.prepare(`
        INSERT INTO friend_import_audit_log
          (id, job_id, account_id, event_type, actor_id, actor_name,
           new_count, existing_count, failed_count, detail)
        VALUES (?, ?, ?, 'started', ?, ?, 0, 0, 0, NULL)
      `).bind(`${jobId}:started`, jobId, account.id, actor.id, actor.name),
    ]);
  } catch (error) {
    const latest = await getLatestFollowerImportJob(db, account.id);
    if (latest?.status === 'fetching' || latest?.status === 'profiling') {
      throw new FollowerImportConflictError(latest);
    }
    throw error;
  }

  const created = await getJobRow(db, jobId, account.id);
  if (!created) throw new Error('failed to create follower import job');
  return advanceFollowerImport(db, jobId, account.id, {
    ...dependencyOverrides,
    createClient: dependencies.createClient,
    now: dependencies.now,
  });
}

export async function advanceFollowerImport(
  db: D1Database,
  jobId: string,
  accountId: string,
  dependencyOverrides: FollowerImportDependencies = {},
): Promise<FollowerImportJob> {
  const dependencies = resolveDependencies(dependencyOverrides);
  let row = await getJobRow(db, jobId, accountId);
  if (!row) throw new Error('follower import job not found');
  if (row.status !== 'running') {
    await ensureTerminalAudit(db, row);
    return serializeJob(row);
  }

  const now = dependencies.now();
  const nowIso = now.toISOString();
  if (row.next_run_at && row.next_run_at > nowIso) return serializeJob(row);

  const lockToken = crypto.randomUUID();
  const lockedUntil = new Date(now.getTime() + JOB_LOCK_MS).toISOString();
  const claim = await db.prepare(`
    UPDATE friend_import_jobs
       SET lock_token = ?, locked_until = ?, updated_at = ?
     WHERE id = ? AND account_id = ? AND status = 'running'
       AND (lock_token IS NULL OR locked_until IS NULL OR locked_until <= ?)
  `).bind(lockToken, lockedUntil, nowIso, jobId, accountId, nowIso).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return (await getLatestFollowerImportJob(db, accountId)) ?? serializeJob(row);
  }

  try {
    row = (await getJobRow(db, jobId, accountId))!;
    const account = await db.prepare(`
      SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1
    `).bind(accountId).first<{ channel_access_token: string }>();
    if (!account) {
      return (await markTerminalFailure(
        db,
        row,
        lockToken,
        dependencies.now().toISOString(),
        'line_account_unavailable',
        LINE_ACCOUNT_UNAVAILABLE_MESSAGE,
        { errorCode: 'line_account_unavailable' },
      )).job;
    }
    const client = dependencies.createClient(account.channel_access_token);
    return await (row.phase === 'followers'
      ? processFollowerPage(db, row, lockToken, client, dependencies)
      : processProfileBatch(db, row, lockToken, client, dependencies));
  } finally {
    await db.prepare(`
      UPDATE friend_import_jobs SET lock_token = NULL, locked_until = NULL
       WHERE id = ? AND lock_token = ?
    `).bind(jobId, lockToken).run();
  }
}

export async function processDueFollowerImports(
  db: D1Database,
  dependencyOverrides: FollowerImportDependencies = {},
): Promise<FollowerImportDueResult> {
  const dependencies = resolveDependencies(dependencyOverrides);
  const nowIso = dependencies.now().toISOString();
  const due = await db.prepare(`
    SELECT id, account_id
      FROM friend_import_jobs
     WHERE status = 'running'
       AND (next_run_at IS NULL OR next_run_at <= ?)
       AND (lock_token IS NULL OR locked_until IS NULL OR locked_until <= ?)
     ORDER BY COALESCE(next_run_at, created_at), updated_at, id
     LIMIT ?
  `).bind(nowIso, nowIso, dependencies.dueJobLimit)
    .all<{ id: string; account_id: string }>();

  const result: FollowerImportDueResult = { attempted: 0, completed: 0, failed: 0, retrying: 0 };
  for (const job of due.results) {
    result.attempted += 1;
    try {
      const advanced = await advanceFollowerImport(db, job.id, job.account_id, dependencyOverrides);
      if (advanced.status === 'completed') result.completed += 1;
      else if (advanced.status === 'failed') result.failed += 1;
      else result.retrying += 1;
    } catch (error) {
      if (error instanceof FollowerImportAccountNotVerifiedError) result.failed += 1;
      else if (error instanceof FollowerImportLineApiError) result.retrying += 1;
      else throw error;
    }
  }
  return result;
}
