import { buildSegmentWhere } from './segment-query.js';
import type { SegmentCondition } from './segment-query.js';
import { checkMonthlyCap } from './monthly-cap.js';
import type { Broadcast as DbBroadcast } from '@line-crm/db';

const MAX_AUDIENCE_RULES = 50;
const SNAPSHOT_BUILD_OFFSET = -2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse and validate a persisted/API segment condition. Calling the SQL
 * compiler is deliberate validation: every accepted rule must have a known
 * type and a correctly shaped value before it can be saved.
 */
export function parseSegmentConditions(value: unknown): SegmentCondition {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error('segmentConditions must be valid JSON');
    }
  }
  if (!isRecord(parsed)) {
    throw new Error('segmentConditions must be an object');
  }
  if (parsed.operator !== 'AND' && parsed.operator !== 'OR') {
    throw new Error('segmentConditions.operator must be AND or OR');
  }
  if (
    !Array.isArray(parsed.rules) ||
    parsed.rules.length < 1 ||
    parsed.rules.length > MAX_AUDIENCE_RULES
  ) {
    throw new Error(`segmentConditions.rules must contain 1-${MAX_AUDIENCE_RULES} rules`);
  }

  const condition = parsed as unknown as SegmentCondition;
  buildSegmentWhere(condition);
  return condition;
}

export function parseStoredSegmentConditions(value: unknown): SegmentCondition | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return parseSegmentConditions(value);
  } catch {
    return null;
  }
}

export function compileBroadcastAudience(
  accountId: string,
  condition: SegmentCondition,
): { clause: string; bindings: unknown[] } {
  if (!accountId) throw new Error('line account is required for a conditional broadcast');
  const segment = buildSegmentWhere(condition);
  const tagIds = Array.from(new Set(
    condition.rules
      .filter((rule) => rule.type === 'tag_exists' || rule.type === 'tag_not_exists')
      .map((rule) => rule.value)
      .filter((value): value is string => typeof value === 'string'),
  ));
  const tagGuards = tagIds.map(
    () => 'EXISTS (SELECT 1 FROM tags audience_tag WHERE audience_tag.id = ?)',
  );
  return {
    clause: [
      'f.line_account_id = ?',
      'f.is_following = 1',
      ...tagGuards,
      segment.clause,
    ].join(' AND '),
    bindings: [accountId, ...tagIds, ...segment.bindings],
  };
}

export async function countBroadcastAudience(
  db: D1Database,
  accountId: string,
  condition: SegmentCondition,
): Promise<number> {
  const { clause, bindings } = compileBroadcastAudience(accountId, condition);
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM friends f WHERE ${clause}`)
    .bind(...bindings)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Freeze the recipient set in SQL at send start. No per-friend JavaScript
 * evaluation occurs: DELETE + INSERT ... SELECT are one D1 batch.
 */
export async function snapshotBroadcastRecipients(
  db: D1Database,
  broadcastId: string,
  accountId: string,
  condition: SegmentCondition,
): Promise<number> {
  const { clause, bindings } = compileBroadcastAudience(accountId, condition);
  await db.batch([
    db.prepare(
      `DELETE FROM broadcast_recipient_snapshots WHERE broadcast_id = ?`,
    ).bind(broadcastId),
    db.prepare(
      `INSERT INTO broadcast_recipient_snapshots
         (broadcast_id, friend_id, line_user_id)
       SELECT ?, f.id, f.line_user_id
       FROM friends f
       WHERE ${clause}`,
    ).bind(broadcastId, ...bindings),
  ]);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM broadcast_recipient_snapshots
       WHERE broadcast_id = ?`,
    )
    .bind(broadcastId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listBroadcastRecipientSnapshot(
  db: D1Database,
  broadcastId: string,
): Promise<Array<{ id: string; line_user_id: string }>> {
  const result = await db
    .prepare(
      `SELECT friend_id AS id, line_user_id
       FROM broadcast_recipient_snapshots
       WHERE broadcast_id = ?
       ORDER BY friend_id`,
    )
    .bind(broadcastId)
    .all<{ id: string; line_user_id: string }>();
  return result.results ?? [];
}

export type SegmentQueueResult =
  | { ok: true; count: number }
  | {
      ok: false;
      status: 400 | 409 | 429;
      error: string;
      cap?: { count: number; cap: number; pending: number };
    };

interface QueueConditionalBroadcastOptions {
  /** Legacy /send-segment atomically changes the target while claiming it. */
  persistCondition?: boolean;
  /** A scheduled cap failure must require an owner decision instead of retrying every cron. */
  capBlockedStatus?: 'draft' | 'scheduled';
}

/**
 * Claim, freeze, and then publish a conditional audience to the queue.
 *
 * batch_offset=-2 is a private construction state. Queue readers only accept
 * non-negative offsets, so they cannot observe an empty or stale snapshot
 * between the status claim and INSERT ... SELECT.
 */
export async function queueConditionalBroadcast(
  db: D1Database,
  broadcast: DbBroadcast,
  condition: SegmentCondition,
  options: QueueConditionalBroadcastOptions = {},
): Promise<SegmentQueueResult> {
  const raw = broadcast as unknown as Record<string, unknown>;
  const accountId = (raw.line_account_id as string | null) ?? null;
  if (!accountId) {
    return {
      ok: false,
      status: 400,
      error: 'Conditional broadcast requires a line account',
    };
  }
  if (broadcast.status !== 'draft' && broadcast.status !== 'scheduled') {
    return {
      ok: false,
      status: 409,
      error: 'Broadcast is already sent or sending',
    };
  }

  const claimedStatus = broadcast.status;
  const storedCondition = raw.segment_conditions;
  const storedScheduledAt = raw.scheduled_at as string | null;
  let claim;
  if (options.persistCondition) {
    claim = await db
      .prepare(
        `UPDATE broadcasts
         SET status = 'sending',
             batch_offset = ?,
             batch_lock_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
             target_type = 'segment',
             target_tag_id = NULL,
             segment_conditions = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(
        SNAPSHOT_BUILD_OFFSET,
        JSON.stringify(condition),
        broadcast.id,
        claimedStatus,
      )
      .run();
  } else {
    if (broadcast.target_type !== 'segment' || typeof storedCondition !== 'string') {
      return {
        ok: false,
        status: 400,
        error: 'Conditional broadcast requires valid segmentConditions',
      };
    }
    claim = await db
      .prepare(
        `UPDATE broadcasts
         SET status = 'sending',
             batch_offset = ?,
             batch_lock_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         WHERE id = ?
           AND status = ?
           AND target_type = 'segment'
           AND segment_conditions = ?
           AND (
             (scheduled_at IS NULL AND ? IS NULL)
             OR scheduled_at = ?
           )`,
      )
      .bind(
        SNAPSHOT_BUILD_OFFSET,
        broadcast.id,
        claimedStatus,
        storedCondition,
        storedScheduledAt,
        storedScheduledAt,
      )
      .run();
  }
  if (!claim.meta.changes) {
    return {
      ok: false,
      status: 409,
      error: 'Broadcast changed or is already sending',
    };
  }

  try {
    const count = await snapshotBroadcastRecipients(
      db,
      broadcast.id,
      accountId,
      condition,
    );
    const cap = await checkMonthlyCap(db, accountId, count);
    if (!cap.allowed && cap.cap !== null) {
      await db.batch([
        db.prepare(
          `DELETE FROM broadcast_recipient_snapshots WHERE broadcast_id = ?`,
        ).bind(broadcast.id),
        db.prepare(
          `UPDATE broadcasts
           SET status = ?, batch_offset = 0, batch_lock_at = NULL, total_count = 0
           WHERE id = ? AND status = 'sending' AND batch_offset = ?`,
        ).bind(
          options.capBlockedStatus ?? claimedStatus,
          broadcast.id,
          SNAPSHOT_BUILD_OFFSET,
        ),
      ]);
      return {
        ok: false,
        status: 429,
        error: `今月の配信上限に達しています (今月${cap.count} / 上限${cap.cap} 通)。上限を変えるか来月までお待ちください。テスト送信も上限の対象です。`,
        cap: { count: cap.count, cap: cap.cap, pending: count },
      };
    }

    const published = await db
      .prepare(
        `UPDATE broadcasts
         SET batch_offset = 0, batch_lock_at = NULL, total_count = ?
         WHERE id = ? AND status = 'sending' AND batch_offset = ?`,
      )
      .bind(count, broadcast.id, SNAPSHOT_BUILD_OFFSET)
      .run();
    if (!published.meta.changes) {
      throw new Error('Conditional audience snapshot lost its construction lock');
    }
    return { ok: true, count };
  } catch (error) {
    await db.batch([
      db.prepare(
        `DELETE FROM broadcast_recipient_snapshots WHERE broadcast_id = ?`,
      ).bind(broadcast.id),
      db.prepare(
        `UPDATE broadcasts
         SET status = ?, batch_offset = 0, batch_lock_at = NULL, total_count = 0
         WHERE id = ? AND status = 'sending' AND batch_offset = ?`,
      ).bind(claimedStatus, broadcast.id, SNAPSHOT_BUILD_OFFSET),
    ]);
    throw error;
  }
}
