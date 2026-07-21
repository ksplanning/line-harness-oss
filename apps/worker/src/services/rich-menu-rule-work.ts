import { LineApiError, LineClient } from '@line-crm/line-sdk';
import {
  applyRichMenuRulesForFriend,
  prepareRichMenuRulesForBatch,
  settleRichMenuRuleMutationBatch,
  type RichMenuRuleApplyResult,
  type RichMenuRuleLineClientFactory,
  type RichMenuRuleMutationOutcome,
  type RichMenuRulePendingMutation,
  type RichMenuRuleQueueLease,
} from './rich-menu-rule-engine.js';

export interface RichMenuRuleReapplyJob {
  id: string;
  accountId: string;
  status: 'running' | 'completed';
  totalCount: number;
  processedCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  lastFriendId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface RichMenuRuleReapplyJobRow {
  id: string;
  account_id: string;
  status: 'running' | 'completed';
  total_count: number;
  processed_count: number;
  applied_count: number;
  skipped_count: number;
  failed_count: number;
  last_friend_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function serializeJob(row: RichMenuRuleReapplyJobRow): RichMenuRuleReapplyJob {
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    totalCount: row.total_count,
    processedCount: row.processed_count,
    appliedCount: row.applied_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    lastFriendId: row.last_friend_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class RichMenuRuleReapplyConflictError extends Error {
  constructor(public readonly job: RichMenuRuleReapplyJob) {
    super('A reapply job is already running or was started less than one minute ago');
    this.name = 'RichMenuRuleReapplyConflictError';
  }
}

export interface RichMenuRuleScheduleEnqueueResult {
  enqueued: number;
  scannedFrom: string;
  scannedThrough: string;
}

const RICH_MENU_RULE_SCHEDULE_SCAN_INTERVAL_MS = 15 * 60_000;
export const RICH_MENU_RULE_SWEEP_LIMIT = 1_500;
const RICH_MENU_RULE_DIRTY_LIMIT = 20;
const LINE_BULK_USER_LIMIT = 500;
// LINE currently allows 2,000 requests/second per endpoint/channel. Starting at
// most one request each millisecond caps this worker at 1,000/second (50%).
// https://developers.line.biz/en/reference/messaging-api/#rate-limits
const LINE_SAFE_REQUEST_INTERVAL_MS = 1;
const LINE_RETRY_BASE_MS = 1_000;
const LINE_RETRY_ATTEMPTS = 3;
// This repository deliberately runs within the Workers Free 50-external-subrequest
// ceiling. The cron dispatches this work in an isolated HTTP invocation and this
// lower local ceiling bounds retry/error expansion inside that dedicated budget.
// https://developers.cloudflare.com/workers/platform/limits/#subrequests
const LINE_SUBREQUEST_BUDGET = 9;

interface RichMenuRuleRequestCounter {
  used: number;
  started?: boolean;
}

export interface RichMenuRuleBulkOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  requestIntervalMs?: number;
  retryBaseMs?: number;
  retryAttempts?: number;
  maxSubrequests?: number;
  requestCounter?: RichMenuRuleRequestCounter;
}

interface RichMenuRuleWorkOptions {
  limit?: number;
  clientFactory?: RichMenuRuleLineClientFactory;
  bulkOptions?: RichMenuRuleBulkOptions;
}

/**
 * Materialize rule boundaries into the existing deduplicated friend queue.
 * The checkpoint window is open on the left and closed on the right: (last, scheduled].
 * A normal cron detects a boundary within 15 minutes. A manual sweep reserves a bounded
 * 20-item lane for unrelated dirty work; a standalone boundary queue uses the bulk path.
 */
export async function enqueueRichMenuRuleScheduleTransitions(
  db: D1Database,
  scheduledAt: Date,
): Promise<RichMenuRuleScheduleEnqueueResult> {
  if (!Number.isFinite(scheduledAt.getTime())) throw new Error('invalid rich menu rule scheduled time');
  const scannedThrough = scheduledAt.toISOString();
  const fallbackFrom = new Date(
    scheduledAt.getTime() - RICH_MENU_RULE_SCHEDULE_SCAN_INTERVAL_MS,
  ).toISOString();

  await db
    .prepare(
      `INSERT INTO rich_menu_rule_schedule_state (id, last_scanned_at)
       VALUES (1, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(fallbackFrom)
    .run();
  const state = await db
    .prepare('SELECT last_scanned_at FROM rich_menu_rule_schedule_state WHERE id = 1')
    .first<{ last_scanned_at: string }>();
  const scannedFrom = state?.last_scanned_at ?? fallbackFrom;
  if (Date.parse(scannedFrom) >= scheduledAt.getTime()) {
    return { enqueued: 0, scannedFrom, scannedThrough };
  }

  const queued = await db
    .prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue
       (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at)
       SELECT f.id, 0,
              strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
              NULL, NULL, 1,
              strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       FROM friends f
       JOIN line_accounts a ON a.id = f.line_account_id AND a.is_active = 1
       WHERE f.is_following = 1
         AND EXISTS (
           SELECT 1 FROM rich_menu_display_rules r
           WHERE r.account_id = f.line_account_id
             AND r.is_active = 1
             AND (
               (r.active_from IS NOT NULL
                 AND julianday(r.active_from) > julianday(?)
                 AND julianday(r.active_from) <= julianday(?))
               OR
               (r.active_until IS NOT NULL
                 AND julianday(r.active_until) > julianday(?)
                 AND julianday(r.active_until) <= julianday(?))
             )
         )
       ON CONFLICT(friend_id) DO UPDATE SET
         attempts = 0,
         available_at = CASE
           WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at
           ELSE rich_menu_rule_evaluation_queue.available_at
         END,
         last_error = NULL,
         revision = rich_menu_rule_evaluation_queue.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(scannedFrom, scannedThrough, scannedFrom, scannedThrough)
    .run();

  await db
    .prepare(
      `UPDATE rich_menu_rule_schedule_state SET last_scanned_at = ?
       WHERE id = 1 AND julianday(last_scanned_at) < julianday(?)`,
    )
    .bind(scannedThrough, scannedThrough)
    .run();
  return {
    enqueued: queued.meta?.changes ?? 0,
    scannedFrom,
    scannedThrough,
  };
}

export async function getLatestRichMenuRuleReapplyJob(
  db: D1Database,
  accountId: string,
): Promise<RichMenuRuleReapplyJob | null> {
  const row = await db
    .prepare(
      `SELECT * FROM rich_menu_rule_reapply_jobs
       WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(accountId)
    .first<RichMenuRuleReapplyJobRow>();
  return row ? serializeJob(row) : null;
}

export async function createRichMenuRuleReapplyJob(
  db: D1Database,
  accountId: string,
): Promise<RichMenuRuleReapplyJob> {
  const recent = await db
    .prepare(
      `SELECT * FROM rich_menu_rule_reapply_jobs
       WHERE account_id = ?
         AND (status = 'running' OR created_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-1 minute'))
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(accountId)
    .first<RichMenuRuleReapplyJobRow>();
  if (recent) throw new RichMenuRuleReapplyConflictError(serializeJob(recent));

  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM friends WHERE line_account_id = ? AND is_following = 1')
    .bind(accountId)
    .first<{ count: number }>();
  const total = count?.count ?? 0;
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO rich_menu_rule_reapply_jobs
         (id, account_id, status, total_count)
         VALUES (?, ?, 'running', ?)`,
      )
      .bind(id, accountId, total)
      .run();
  } catch (error) {
    const conflicting = await db
      .prepare(
        `SELECT * FROM rich_menu_rule_reapply_jobs
         WHERE account_id = ?
           AND (status = 'running' OR created_at >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '-1 minute'))
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<RichMenuRuleReapplyJobRow>();
    if (conflicting) throw new RichMenuRuleReapplyConflictError(serializeJob(conflicting));
    throw error;
  }
  return (await getLatestRichMenuRuleReapplyJob(db, accountId))!;
}

function resultBucket(result: RichMenuRuleApplyResult): 'applied' | 'skipped' | 'failed' {
  if (result.status === 'applied' || result.status === 'reverted') return 'applied';
  if (result.status === 'failed') return 'failed';
  return 'skipped';
}

async function claimFriendEvaluation(
  db: D1Database,
  friendId: string,
  knownRevision?: number,
): Promise<{ token: string; revision: number } | null> {
  let revision = knownRevision;
  if (revision === undefined) {
    await db
      .prepare(
        `INSERT INTO rich_menu_rule_evaluation_queue (friend_id)
         VALUES (?) ON CONFLICT(friend_id) DO NOTHING`,
      )
      .bind(friendId)
      .run();
    const row = await db
      .prepare('SELECT revision FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?')
      .bind(friendId)
      .first<{ revision: number }>();
    if (!row) return null;
    revision = row.revision;
  }

  const token = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE rich_menu_rule_evaluation_queue
       SET lease_token = ?,
           available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+15 minutes'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE friend_id = ? AND revision = ?
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
    )
    .bind(token, friendId, revision)
    .run();
  return (claimed.meta?.changes ?? 0) === 1 ? { token, revision } : null;
}

async function claimFriendEvaluations(
  db: D1Database,
  friendIds: string[],
): Promise<RichMenuRuleQueueLease[]> {
  if (friendIds.length === 0) return [];
  const friendIdsJson = JSON.stringify(friendIds);
  await db
    .prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id)
       SELECT value FROM json_each(?) WHERE 1
       ON CONFLICT(friend_id) DO NOTHING`,
    )
    .bind(friendIdsJson)
    .run();
  const token = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE rich_menu_rule_evaluation_queue
       SET lease_token = ?,
           available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+15 minutes'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE friend_id IN (SELECT value FROM json_each(?))
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       RETURNING friend_id, revision`,
    )
    .bind(token, friendIdsJson)
    .all<{ friend_id: string; revision: number }>();
  return claimed.results.map((row) => ({ friendId: row.friend_id, token, revision: row.revision }));
}

async function releaseFriendEvaluations(
  db: D1Database,
  leases: RichMenuRuleQueueLease[],
): Promise<void> {
  if (leases.length === 0) return;
  await db
    .prepare(
      `UPDATE rich_menu_rule_evaluation_queue SET
         lease_token = NULL,
         available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE EXISTS (
         SELECT 1 FROM json_each(?) AS item
         WHERE json_extract(item.value, '$.friendId') = rich_menu_rule_evaluation_queue.friend_id
           AND json_extract(item.value, '$.token') = rich_menu_rule_evaluation_queue.lease_token
       )`,
    )
    .bind(JSON.stringify(leases))
    .run();
}

type BulkCapableLineClient = ReturnType<RichMenuRuleLineClientFactory> & Required<Pick<
  ReturnType<RichMenuRuleLineClientFactory>,
  | 'linkRichMenuToMultipleUsers'
  | 'unlinkRichMenusFromMultipleUsers'
>>;

function isBulkCapable(client: ReturnType<RichMenuRuleLineClientFactory>): client is BulkCapableLineClient {
  return typeof client.linkRichMenuToMultipleUsers === 'function'
    && typeof client.unlinkRichMenusFromMultipleUsers === 'function';
}

function isRetryableLineError(error: unknown): boolean {
  if (error instanceof LineApiError) return error.status === 429 || error.status >= 500;
  // Network timeouts/fetch failures do not carry a LINE status and are safe to retry;
  // rich-menu link/unlink operations are idempotent desired-state writes.
  return !(error instanceof RangeError);
}

function isTerminalLineError(error: unknown): boolean {
  return error instanceof LineApiError
    && error.status >= 400
    && error.status < 500
    && error.status !== 429;
}

function failedUserIndexes(error: unknown, userCount: number): number[] {
  if (!(error instanceof LineApiError) || error.status !== 400) return [];
  const indexes = new Set<number>();
  for (const match of error.responseBody.matchAll(/userIds\[(\d+)\]/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 0 && index < userCount) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

async function executeRichMenuMutations(
  mutations: RichMenuRulePendingMutation[],
  clientFactory: RichMenuRuleLineClientFactory,
  bulkOptions: RichMenuRuleBulkOptions = {},
): Promise<RichMenuRuleMutationOutcome[]> {
  if (mutations.length === 0) return [];
  const sleep = bulkOptions.sleep ?? ((milliseconds: number) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  const requestIntervalMs = bulkOptions.requestIntervalMs ?? LINE_SAFE_REQUEST_INTERVAL_MS;
  const retryBaseMs = bulkOptions.retryBaseMs ?? LINE_RETRY_BASE_MS;
  const retryAttempts = bulkOptions.retryAttempts ?? LINE_RETRY_ATTEMPTS;
  const maxSubrequests = bulkOptions.maxSubrequests ?? LINE_SUBREQUEST_BUDGET;
  const requestCounter = bulkOptions.requestCounter ?? { used: 0 };
  const paced = async <T>(request: () => Promise<T>): Promise<T> => {
    if (requestCounter.used >= maxSubrequests) {
      throw new RangeError('rich-menu LINE subrequest budget exhausted');
    }
    if (requestCounter.started && requestIntervalMs > 0) await sleep(requestIntervalMs);
    requestCounter.started = true;
    requestCounter.used++;
    return request();
  };
  const requestWithRetry = async <T>(request: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      try {
        return await paced(request);
      } catch (error) {
        lastError = error;
        if (!isRetryableLineError(error) || attempt === retryAttempts - 1) throw error;
        await sleep(retryBaseMs * (2 ** attempt));
      }
    }
    throw lastError;
  };
  const clients = new Map<string, ReturnType<RichMenuRuleLineClientFactory>>();
  const getClient = (token: string) => {
    let client = clients.get(token);
    if (!client) {
      client = clientFactory(token);
      clients.set(token, client);
    }
    return client;
  };
  const outcomes = new Map<string, RichMenuRuleMutationOutcome>();
  const bulkGroups = new Map<string, {
    client: BulkCapableLineClient;
    action: 'link' | 'unlink';
    richMenuId: string | null;
    mutations: RichMenuRulePendingMutation[];
  }>();

  for (const mutation of mutations) {
    const client = getClient(mutation.channelAccessToken);
    if (!isBulkCapable(client)) {
      try {
        if (mutation.action === 'link') {
          await requestWithRetry(() => client.linkRichMenuToUser(mutation.lineUserId, mutation.richMenuId!));
        } else {
          await requestWithRetry(() => client.unlinkRichMenuFromUser(mutation.lineUserId));
        }
        outcomes.set(mutation.friendId, { mutation });
      } catch (error) {
        outcomes.set(mutation.friendId, {
          mutation,
          error,
          terminalFailure: isTerminalLineError(error),
        });
      }
      continue;
    }
    const key = `${mutation.channelAccessToken}\u0000${mutation.action}\u0000${mutation.richMenuId ?? ''}`;
    const group = bulkGroups.get(key) ?? {
      client,
      action: mutation.action,
      richMenuId: mutation.richMenuId,
      mutations: [],
    };
    group.mutations.push(mutation);
    bulkGroups.set(key, group);
  }

  const retryIndividually = async (mutation: RichMenuRulePendingMutation): Promise<void> => {
    try {
      if (mutation.action === 'link') {
        await requestWithRetry(
          () => getClient(mutation.channelAccessToken)
            .linkRichMenuToUser(mutation.lineUserId, mutation.richMenuId!),
        );
      } else {
        await requestWithRetry(
          () => getClient(mutation.channelAccessToken).unlinkRichMenuFromUser(mutation.lineUserId),
        );
      }
      outcomes.set(mutation.friendId, { mutation });
    } catch (error) {
      outcomes.set(mutation.friendId, {
        mutation,
        error,
        terminalFailure: isTerminalLineError(error),
      });
    }
  };

  // LINE's accepted response is asynchronous and empty. A normal 1,450-user run
  // therefore stays at exactly three external calls (500 + 500 + 450), which fits
  // the Free Worker budget. When LINE identifies malformed userIds[n] in a 400,
  // retry only those users individually and resubmit the unaffected remainder.
  for (const group of bulkGroups.values()) {
    for (let offset = 0; offset < group.mutations.length; offset += LINE_BULK_USER_LIMIT) {
      let pending = group.mutations.slice(offset, offset + LINE_BULK_USER_LIMIT);
      while (pending.length > 0) {
        const userIds = pending.map((mutation) => mutation.lineUserId);
        try {
          if (group.action === 'link') {
            await requestWithRetry(() => group.client.linkRichMenuToMultipleUsers(userIds, group.richMenuId!));
          } else {
            await requestWithRetry(() => group.client.unlinkRichMenusFromMultipleUsers(userIds));
          }
          for (const mutation of pending) outcomes.set(mutation.friendId, { mutation });
          pending = [];
        } catch (error) {
          const indexes = failedUserIndexes(error, pending.length);
          if (indexes.length === 0) {
            for (const mutation of pending) {
              outcomes.set(mutation.friendId, {
                mutation,
                error,
                terminalFailure: isTerminalLineError(error),
              });
            }
            pending = [];
            continue;
          }
          const failedIndexSet = new Set(indexes);
          const failed = pending.filter((_mutation, index) => failedIndexSet.has(index));
          pending = pending.filter((_mutation, index) => !failedIndexSet.has(index));
          for (const mutation of failed) await retryIndividually(mutation);
        }
      }
    }
  }
  return mutations.map((mutation) => outcomes.get(mutation.friendId) ?? {
    mutation,
    error: new Error('LINE rich menu outcome was not recorded'),
  });
}

export async function processRichMenuRuleWork(
  db: D1Database,
  options: RichMenuRuleWorkOptions = {},
): Promise<{ attempted: number; queueProcessed: number; jobsCompleted: number }> {
  const limit = Math.min(
    RICH_MENU_RULE_SWEEP_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? RICH_MENU_RULE_SWEEP_LIMIT)),
  );
  const clientFactory = options.clientFactory ?? ((token: string) => new LineClient(token));
  const requestCounter = options.bulkOptions?.requestCounter ?? { used: 0 };
  const bulkOptions = { ...options.bulkOptions, requestCounter };
  let attempted = 0;
  let jobsCompleted = 0;

  const runningJobs = await db
    .prepare(
      `SELECT * FROM rich_menu_rule_reapply_jobs
       WHERE status = 'running' ORDER BY created_at ASC, id ASC`,
    )
    .all<RichMenuRuleReapplyJobRow>();

  const readyQueueCount = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM rich_menu_rule_evaluation_queue q
       LEFT JOIN friends f ON f.id = q.friend_id
       WHERE q.available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         AND (
           f.line_account_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM rich_menu_rule_reapply_jobs j
             WHERE j.status = 'running' AND j.account_id = f.line_account_id
           )
         )`,
    )
    .first<{ count: number }>();
  const minimumJobCapacity = runningJobs.results.length > 0
    ? Math.min(RICH_MENU_RULE_DIRTY_LIMIT, Math.ceil(limit / 2))
    : 0;
  const queueReservation = Math.min(
    readyQueueCount?.count ?? 0,
    Math.max(0, limit - minimumJobCapacity),
  );
  let jobRemaining = limit - queueReservation;

  for (const jobRow of runningJobs.results) {
    if (jobRemaining === 0) break;
    const jobLockToken = crypto.randomUUID();
    const claimed = await db
      .prepare(
        `UPDATE rich_menu_rule_reapply_jobs
         SET lock_token = ?,
             locked_until = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+15 minutes'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         WHERE id = ? AND status = 'running'
           AND processed_count = ? AND last_friend_id IS ?
           AND (locked_until IS NULL OR locked_until <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))`,
      )
      .bind(jobLockToken, jobRow.id, jobRow.processed_count, jobRow.last_friend_id)
      .run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;

    const friendRows = await db
      .prepare(
        `SELECT id FROM friends
         WHERE line_account_id = ? AND is_following = 1 AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .bind(jobRow.account_id, jobRow.last_friend_id ?? '', jobRemaining + 1)
      .all<{ id: string }>();
    const hasMoreFromCursor = friendRows.results.length > jobRemaining;
    const batch = friendRows.results.slice(0, jobRemaining);
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    const queueLeases = await claimFriendEvaluations(db, batch.map((friend) => friend.id));
    const leaseByFriendId = new Map(queueLeases.map((lease) => [lease.friendId, lease]));
    const firstUnclaimedIndex = batch.findIndex((friend) => !leaseByFriendId.has(friend.id));
    const processedBatch = firstUnclaimedIndex === -1 ? batch : batch.slice(0, firstUnclaimedIndex);
    const processedFriendIds = new Set(processedBatch.map((friend) => friend.id));
    const processedLeases = processedBatch.map((friend) => leaseByFriendId.get(friend.id)!);
    await releaseFriendEvaluations(
      db,
      queueLeases.filter((lease) => !processedFriendIds.has(lease.friendId)),
    );
    const prepared = await prepareRichMenuRulesForBatch(
      db,
      jobRow.account_id,
      processedLeases,
    );
    const outcomes = await executeRichMenuMutations(
      prepared.mutations,
      clientFactory,
      bulkOptions,
    );
    const mutationResults = await settleRichMenuRuleMutationBatch(db, outcomes);
    for (const result of [...prepared.results, ...mutationResults]) {
      const bucket = resultBucket(result);
      if (bucket === 'applied') applied++;
      else if (bucket === 'failed') failed++;
      else skipped++;
    }
    attempted += processedBatch.length;
    jobRemaining -= processedBatch.length;
    const lastFriendId = processedBatch.at(-1)?.id ?? jobRow.last_friend_id;
    const pendingQueue = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM rich_menu_rule_evaluation_queue q
         JOIN friends f ON f.id = q.friend_id
         WHERE f.line_account_id = ?`,
      )
      .bind(jobRow.account_id)
      .first<{ count: number }>();
    const completed = !hasMoreFromCursor
      && processedBatch.length === batch.length
      && (pendingQueue?.count ?? 0) === 0;
    const finalized = await db
      .prepare(
        `UPDATE rich_menu_rule_reapply_jobs SET
           status = ?,
           processed_count = processed_count + ?,
           applied_count = applied_count + ?,
           skipped_count = skipped_count + ?,
           failed_count = failed_count + ?,
           last_friend_id = ?,
           locked_until = NULL,
           lock_token = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
           completed_at = CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') ELSE NULL END
         WHERE id = ? AND lock_token = ?`,
      )
      .bind(
        completed ? 'completed' : 'running',
        processedBatch.length,
        applied,
        skipped,
        failed,
        lastFriendId,
        completed ? 'completed' : 'running',
        jobRow.id,
        jobLockToken,
      )
      .run();
    if (completed && (finalized.meta?.changes ?? 0) === 1) jobsCompleted++;
  }

  let queueProcessed = 0;
  const remaining = limit - attempted;
  if (remaining > 0) {
    const queued = await db
      .prepare(
        `SELECT q.friend_id, q.revision, f.line_account_id AS account_id
         FROM rich_menu_rule_evaluation_queue q
         LEFT JOIN friends f ON f.id = q.friend_id
         WHERE q.available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         ORDER BY
           CASE WHEN f.line_account_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM rich_menu_rule_reapply_jobs j
             WHERE j.status = 'running' AND j.account_id = f.line_account_id
           ) THEN 0 ELSE 1 END,
           q.available_at ASC,
           q.friend_id ASC
         LIMIT ?`,
      )
      .bind(remaining)
      .all<{ friend_id: string; revision: number; account_id: string | null }>();
    const queueLeases = await claimFriendEvaluations(
      db,
      queued.results.map((item) => item.friend_id),
    );
    const accountByFriendId = new Map(queued.results.map((item) => [item.friend_id, item.account_id]));
    const leasesByAccount = new Map<string, RichMenuRuleQueueLease[]>();
    const missingFriendLeases: RichMenuRuleQueueLease[] = [];
    for (const lease of queueLeases) {
      const accountId = accountByFriendId.get(lease.friendId);
      if (!accountId) {
        missingFriendLeases.push(lease);
        continue;
      }
      const accountLeases = leasesByAccount.get(accountId) ?? [];
      accountLeases.push(lease);
      leasesByAccount.set(accountId, accountLeases);
    }
    const mutations: RichMenuRulePendingMutation[] = [];
    for (const [accountId, accountLeases] of leasesByAccount) {
      const prepared = await prepareRichMenuRulesForBatch(db, accountId, accountLeases);
      mutations.push(...prepared.mutations);
    }
    const outcomes = await executeRichMenuMutations(mutations, clientFactory, bulkOptions);
    await settleRichMenuRuleMutationBatch(db, outcomes);
    for (const lease of missingFriendLeases) {
      await applyRichMenuRulesForFriend(db, lease.friendId, clientFactory, { queueLease: lease });
    }
    attempted += queueLeases.length;
    queueProcessed = queueLeases.length;
  }

  return { attempted, queueProcessed, jobsCompleted };
}
