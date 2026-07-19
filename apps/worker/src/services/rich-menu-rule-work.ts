import {
  applyRichMenuRulesForFriend,
  type RichMenuRuleApplyResult,
  type RichMenuRuleLineClientFactory,
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

/**
 * Materialize rule boundaries into the existing deduplicated friend queue.
 * The checkpoint window is open on the left and closed on the right: (last, scheduled].
 * A normal cron detects a boundary within 15 minutes; the existing worker then drains
 * 20 friends per five-minute tick (10 reserved slots while a manual sweep is running).
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
           available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+10 minutes'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE friend_id = ? AND revision = ?
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
    )
    .bind(token, friendId, revision)
    .run();
  return (claimed.meta?.changes ?? 0) === 1 ? { token, revision } : null;
}

export async function processRichMenuRuleWork(
  db: D1Database,
  options: { limit?: number; clientFactory?: RichMenuRuleLineClientFactory } = {},
): Promise<{ attempted: number; queueProcessed: number; jobsCompleted: number }> {
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 20)));
  let attempted = 0;
  let jobsCompleted = 0;

  const runningJobs = await db
    .prepare(
      `SELECT * FROM rich_menu_rule_reapply_jobs
       WHERE status = 'running' ORDER BY created_at ASC, id ASC`,
    )
    .all<RichMenuRuleReapplyJobRow>();

  const readyQueueCount = runningJobs.results.length > 0
    ? await db
      .prepare(
        `SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue
         WHERE available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
      )
      .first<{ count: number }>()
    : null;
  const queueReservation = Math.min(
    readyQueueCount?.count ?? 0,
    Math.max(1, Math.floor(limit / 2)),
  );
  let jobRemaining = limit - queueReservation;

  for (const jobRow of runningJobs.results) {
    if (jobRemaining === 0) break;
    const jobLockToken = crypto.randomUUID();
    const claimed = await db
      .prepare(
        `UPDATE rich_menu_rule_reapply_jobs
         SET lock_token = ?,
             locked_until = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+10 minutes'),
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
    const hasMore = friendRows.results.length > jobRemaining;
    const batch = friendRows.results.slice(0, jobRemaining);
    let applied = 0;
    let skipped = 0;
    let failed = 0;
    for (const friend of batch) {
      const queueLease = await claimFriendEvaluation(db, friend.id);
      if (!queueLease) {
        skipped++;
        continue;
      }
      const result = await applyRichMenuRulesForFriend(
        db,
        friend.id,
        options.clientFactory,
        { queueLease },
      );
      const bucket = resultBucket(result);
      if (bucket === 'applied') applied++;
      else if (bucket === 'failed') failed++;
      else skipped++;
    }
    attempted += batch.length;
    jobRemaining -= batch.length;
    const completed = !hasMore;
    const lastFriendId = batch.at(-1)?.id ?? jobRow.last_friend_id;
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
        batch.length,
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
        `SELECT friend_id, revision FROM rich_menu_rule_evaluation_queue
         WHERE available_at <= strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         ORDER BY available_at ASC, friend_id ASC LIMIT ?`,
      )
      .bind(remaining)
      .all<{ friend_id: string; revision: number }>();
    for (const item of queued.results) {
      const queueLease = await claimFriendEvaluation(db, item.friend_id, item.revision);
      if (!queueLease) continue;
      await applyRichMenuRulesForFriend(
        db,
        item.friend_id,
        options.clientFactory,
        { queueLease },
      );
      attempted++;
      queueProcessed++;
    }
  }

  return { attempted, queueProcessed, jobsCompleted };
}
