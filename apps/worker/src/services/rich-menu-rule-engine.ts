import {
  listRichMenuDisplayRules,
  type RichMenuDisplayRule,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import {
  evaluateConditionWithResolverStrict,
  type ConditionValueResolver,
} from './step-delivery.js';

export interface RichMenuRuleLineClient {
  linkRichMenuToUser(userId: string, richMenuId: string): Promise<unknown>;
  unlinkRichMenuFromUser(userId: string): Promise<unknown>;
  linkRichMenuToMultipleUsers?(userIds: string[], richMenuId: string): Promise<unknown>;
  unlinkRichMenusFromMultipleUsers?(userIds: string[]): Promise<unknown>;
  getRichMenuIdOfUser?(userId: string): Promise<{ richMenuId: string }>;
  getDefaultRichMenuId?(): Promise<string | null>;
}

export type RichMenuRuleLineClientFactory = (channelAccessToken: string) => RichMenuRuleLineClient;

export type RichMenuRuleApplyResult =
  | { status: 'no_rules'; friendId: string }
  | { status: 'ignored'; friendId: string; reason: 'missing_friend' | 'not_following' | 'missing_account' | 'inactive_account' }
  | { status: 'applied'; friendId: string; ruleId: string; richMenuId: string }
  | { status: 'reverted'; friendId: string; ruleId: null; richMenuId: null }
  | { status: 'skipped'; friendId: string; reason: 'same_menu'; ruleId: string | null; richMenuId: string | null }
  | { status: 'failed'; friendId: string; error: string };

interface FriendRuleContext {
  id: string;
  line_user_id: string;
  line_account_id: string | null;
  is_following: number;
  metadata: string | null;
  channel_access_token: string | null;
  account_is_active: number | null;
}

interface FriendAssignment {
  friend_id: string;
  account_id: string;
  rule_id: string | null;
  rich_menu_id: string | null;
}

export interface RichMenuRuleQueueLease {
  friendId: string;
  token: string;
  revision: number;
}

export interface RichMenuRulePendingMutation {
  action: 'link' | 'unlink';
  friendId: string;
  lineUserId: string;
  accountId: string;
  channelAccessToken: string;
  ruleId: string | null;
  richMenuId: string | null;
  hadRules: boolean;
  queueLease: RichMenuRuleQueueLease;
}

export interface RichMenuRuleBatchPreparation {
  results: RichMenuRuleApplyResult[];
  mutations: RichMenuRulePendingMutation[];
}

export interface RichMenuRuleMutationOutcome {
  mutation: RichMenuRulePendingMutation;
  error?: unknown;
  terminalFailure?: boolean;
}

interface BatchFriendRuleContext extends FriendRuleContext {
  assignment_friend_id: string | null;
  assignment_account_id: string | null;
  assignment_rule_id: string | null;
  assignment_rich_menu_id: string | null;
}

const defaultClientFactory: RichMenuRuleLineClientFactory = (token) => new LineClient(token);

export interface RichMenuRuleApplyOptions {
  queueLease?: { token: string; revision: number };
  preserveQueue?: boolean;
  now?: Date;
}

function isRuleInActivePeriod(
  rule: { activeFrom: string | null; activeUntil: string | null },
  now: Date,
): boolean {
  const nowMs = now.getTime();
  const activeFromMs = rule.activeFrom === null ? null : Date.parse(rule.activeFrom);
  const activeUntilMs = rule.activeUntil === null ? null : Date.parse(rule.activeUntil);
  if (activeFromMs !== null && !Number.isFinite(activeFromMs)) throw new Error('invalid rich menu rule activeFrom');
  if (activeUntilMs !== null && !Number.isFinite(activeUntilMs)) throw new Error('invalid rich menu rule activeUntil');
  return (activeFromMs === null || nowMs >= activeFromMs)
    && (activeUntilMs === null || nowMs < activeUntilMs);
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function findWinningRule(
  rules: RichMenuDisplayRule[],
  context: {
    metadata: Record<string, unknown> | null;
    tagIds: Set<string>;
    tagNames: string[];
    defaults: Map<string, string>;
  },
): Promise<RichMenuDisplayRule | null> {
  const resolver: ConditionValueResolver = {
    async hasTag(tagId) { return context.tagIds.has(tagId); },
    async getMetadata(key) {
      if (!context.metadata) return undefined;
      return Object.prototype.hasOwnProperty.call(context.metadata, key)
        ? context.metadata[key]
        : context.defaults.get(key);
    },
    async getTagNames() { return context.tagNames; },
  };
  for (const rule of rules) {
    if (await evaluateConditionWithResolverStrict(resolver, {
      condition_type: rule.conditionType,
      condition_value: rule.conditionValue,
    })) return rule;
  }
  return null;
}

async function clearQueue(
  db: D1Database,
  friendId: string,
  options: RichMenuRuleApplyOptions,
): Promise<void> {
  if (options.preserveQueue) return;
  if (options.queueLease) {
    const removed = await db
      .prepare(
        `DELETE FROM rich_menu_rule_evaluation_queue
         WHERE friend_id = ? AND lease_token = ? AND revision = ?`,
      )
      .bind(friendId, options.queueLease.token, options.queueLease.revision)
      .run();
    if ((removed.meta?.changes ?? 0) === 0) {
      await db
        .prepare(
          `UPDATE rich_menu_rule_evaluation_queue
           SET lease_token = NULL,
               available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
               updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
           WHERE friend_id = ? AND lease_token = ?`,
        )
        .bind(friendId, options.queueLease.token)
        .run();
    }
    return;
  }
  await db.prepare('DELETE FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?').bind(friendId).run();
}

async function queueRetry(
  db: D1Database,
  friendId: string,
  error: unknown,
  options: RichMenuRuleApplyOptions,
): Promise<void> {
  if (options.queueLease) {
    await db
      .prepare(
        `UPDATE rich_menu_rule_evaluation_queue SET
           attempts = attempts + 1,
           available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+5 minutes'),
           last_error = ?,
           lease_token = NULL,
           revision = revision + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
         WHERE friend_id = ? AND lease_token = ?`,
      )
      .bind(safeError(error), friendId, options.queueLease.token)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue
       (friend_id, attempts, available_at, last_error, lease_token, revision, updated_at)
       VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+5 minutes'), ?, NULL, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
       ON CONFLICT(friend_id) DO UPDATE SET
         attempts = rich_menu_rule_evaluation_queue.attempts + 1,
         available_at = excluded.available_at,
         last_error = excluded.last_error,
         lease_token = NULL,
         revision = rich_menu_rule_evaluation_queue.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(friendId, safeError(error))
    .run();
}

async function saveAssignment(
  db: D1Database,
  input: { friendId: string; accountId: string; ruleId: string | null; richMenuId: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rich_menu_friend_assignments
       (friend_id, account_id, rule_id, rich_menu_id, applied_at, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
       ON CONFLICT(friend_id) DO UPDATE SET
         account_id = excluded.account_id,
         rule_id = excluded.rule_id,
         rich_menu_id = excluded.rich_menu_id,
         applied_at = excluded.applied_at,
         updated_at = excluded.updated_at`,
    )
    .bind(input.friendId, input.accountId, input.ruleId, input.richMenuId)
    .run();
}

export async function forgetRichMenuRuleAssignment(db: D1Database, friendId: string): Promise<void> {
  await db.prepare('DELETE FROM rich_menu_friend_assignments WHERE friend_id = ?').bind(friendId).run();
}

interface BatchAssignmentWrite extends RichMenuRuleQueueLease {
  accountId: string;
  ruleId: string | null;
  richMenuId: string | null;
}

interface BatchRetryWrite extends RichMenuRuleQueueLease {
  error: string;
}

async function upsertAssignmentsBatch(
  db: D1Database,
  assignments: BatchAssignmentWrite[],
): Promise<void> {
  if (assignments.length === 0) return;
  await db
    .prepare(
      `INSERT INTO rich_menu_friend_assignments
       (friend_id, account_id, rule_id, rich_menu_id, applied_at, updated_at)
       SELECT json_extract(item.value, '$.friendId'),
              json_extract(item.value, '$.accountId'),
              json_extract(item.value, '$.ruleId'),
              json_extract(item.value, '$.richMenuId'),
              strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
              strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       FROM json_each(?) AS item
       JOIN rich_menu_rule_evaluation_queue q
         ON q.friend_id = json_extract(item.value, '$.friendId')
        AND q.lease_token = json_extract(item.value, '$.token')
        AND q.revision = json_extract(item.value, '$.revision')
       WHERE 1
       ON CONFLICT(friend_id) DO UPDATE SET
         account_id = excluded.account_id,
         rule_id = excluded.rule_id,
         rich_menu_id = excluded.rich_menu_id,
         applied_at = excluded.applied_at,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(assignments))
    .run();
}

async function deleteAssignmentsBatch(db: D1Database, leases: RichMenuRuleQueueLease[]): Promise<void> {
  if (leases.length === 0) return;
  await db
    .prepare(
      `DELETE FROM rich_menu_friend_assignments
       WHERE EXISTS (
         SELECT 1
         FROM json_each(?) AS item
         JOIN rich_menu_rule_evaluation_queue q
           ON q.friend_id = json_extract(item.value, '$.friendId')
          AND q.lease_token = json_extract(item.value, '$.token')
          AND q.revision = json_extract(item.value, '$.revision')
         WHERE rich_menu_friend_assignments.friend_id = q.friend_id
       )`,
    )
    .bind(JSON.stringify(leases))
    .run();
}

async function clearQueueBatch(db: D1Database, leases: RichMenuRuleQueueLease[]): Promise<void> {
  if (leases.length === 0) return;
  const payload = JSON.stringify(leases);
  await db
    .prepare(
      `DELETE FROM rich_menu_rule_evaluation_queue
       WHERE EXISTS (
         SELECT 1 FROM json_each(?) AS item
         WHERE json_extract(item.value, '$.friendId') = rich_menu_rule_evaluation_queue.friend_id
           AND json_extract(item.value, '$.token') = rich_menu_rule_evaluation_queue.lease_token
           AND json_extract(item.value, '$.revision') = rich_menu_rule_evaluation_queue.revision
       )`,
    )
    .bind(payload)
    .run();
  // A newer dirty update increments revision while retaining this lease. Release only
  // the still-owned row so the new generation is immediately available to another worker.
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
           AND json_extract(item.value, '$.revision') <> rich_menu_rule_evaluation_queue.revision
       )`,
    )
    .bind(payload)
    .run();
}

async function queueRetryBatch(db: D1Database, retries: BatchRetryWrite[]): Promise<void> {
  if (retries.length === 0) return;
  const payload = JSON.stringify(retries);
  await db
    .prepare(
      `UPDATE rich_menu_rule_evaluation_queue SET
         attempts = attempts + 1,
         available_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+5 minutes'),
         last_error = (
           SELECT json_extract(item.value, '$.error') FROM json_each(?) AS item
           WHERE json_extract(item.value, '$.friendId') = rich_menu_rule_evaluation_queue.friend_id
             AND json_extract(item.value, '$.token') = rich_menu_rule_evaluation_queue.lease_token
           LIMIT 1
         ),
         lease_token = NULL,
         revision = revision + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       WHERE EXISTS (
         SELECT 1 FROM json_each(?) AS item
         WHERE json_extract(item.value, '$.friendId') = rich_menu_rule_evaluation_queue.friend_id
           AND json_extract(item.value, '$.token') = rich_menu_rule_evaluation_queue.lease_token
           AND json_extract(item.value, '$.revision') = rich_menu_rule_evaluation_queue.revision
       )`,
    )
    .bind(payload, payload)
    .run();
  // A dirty event can increment revision while the old worker still holds the token.
  // Do not postpone that newer generation behind the old failure's five-minute delay.
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
           AND json_extract(item.value, '$.revision') <> rich_menu_rule_evaluation_queue.revision
       )`,
    )
    .bind(payload)
    .run();
}

async function persistBatchEffects(
  db: D1Database,
  effects: {
    upserts: BatchAssignmentWrite[];
    deletes: RichMenuRuleQueueLease[];
    clears: RichMenuRuleQueueLease[];
    retries: BatchRetryWrite[];
  },
): Promise<void> {
  await upsertAssignmentsBatch(db, effects.upserts);
  await deleteAssignmentsBatch(db, effects.deletes);
  await clearQueueBatch(db, effects.clears);
  await queueRetryBatch(db, effects.retries);
}

async function currentLeaseFriendIds(
  db: D1Database,
  leases: RichMenuRuleQueueLease[],
): Promise<Set<string>> {
  if (leases.length === 0) return new Set();
  const rows = await db
    .prepare(
      `SELECT q.friend_id
       FROM rich_menu_rule_evaluation_queue q
       JOIN json_each(?) AS item
         ON json_extract(item.value, '$.friendId') = q.friend_id
        AND json_extract(item.value, '$.token') = q.lease_token
        AND json_extract(item.value, '$.revision') = q.revision`,
    )
    .bind(JSON.stringify(leases))
    .all<{ friend_id: string }>();
  return new Set(rows.results.map((row) => row.friend_id));
}

async function enqueueSupersededMutations(
  db: D1Database,
  mutations: RichMenuRulePendingMutation[],
): Promise<void> {
  if (mutations.length === 0) return;
  const payload = JSON.stringify(mutations.map((mutation) => ({ friendId: mutation.friendId })));
  // The superseded worker may have completed its LINE request after a newer worker.
  // Invalidate the assignment cache so the reconciliation cannot incorrectly skip
  // the corrective LINE mutation as "same_menu".
  await db
    .prepare(
      `DELETE FROM rich_menu_friend_assignments
       WHERE friend_id IN (
         SELECT json_extract(value, '$.friendId') FROM json_each(?)
       )`,
    )
    .bind(payload)
    .run();
  await db
    .prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue
       (friend_id, available_at, revision, updated_at)
       SELECT json_extract(value, '$.friendId'),
              strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
              1,
              strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
       FROM json_each(?) WHERE 1
       ON CONFLICT(friend_id) DO UPDATE SET
         available_at = CASE
           WHEN rich_menu_rule_evaluation_queue.lease_token IS NULL THEN excluded.available_at
           ELSE rich_menu_rule_evaluation_queue.available_at
         END,
         revision = rich_menu_rule_evaluation_queue.revision + 1,
         updated_at = excluded.updated_at`,
    )
    .bind(payload)
    .run();
}

/**
 * Evaluate one account sweep with a fixed query budget. The same ordered rule matcher
 * as the single-friend path is used, but friends/tags/defaults are loaded in batches.
 * LINE mutations remain pending until the bulk API has accepted the request.
 */
export async function prepareRichMenuRulesForBatch(
  db: D1Database,
  accountId: string,
  leases: RichMenuRuleQueueLease[],
  now = new Date(),
): Promise<RichMenuRuleBatchPreparation> {
  if (leases.length === 0) return { results: [], mutations: [] };
  const friendIds = leases.map((lease) => lease.friendId).sort();
  const friendIdsJson = JSON.stringify(friendIds);
  const leaseByFriendId = new Map(leases.map((lease) => [lease.friendId, lease]));
  const rules = await listRichMenuDisplayRules(db, accountId, { activeOnly: true });
  let eligibleRules: RichMenuDisplayRule[];
  try {
    eligibleRules = rules.filter((rule) => isRuleInActivePeriod(rule, now));
  } catch (error) {
    const message = safeError(error);
    await queueRetryBatch(db, leases.map((lease) => ({ ...lease, error: message })));
    return {
      results: leases.map((lease) => ({ status: 'failed', friendId: lease.friendId, error: message })),
      mutations: [],
    };
  }
  const needsTags = eligibleRules.some((rule) => rule.conditionType.startsWith('tag_'));
  const needsMetadata = eligibleRules.some((rule) => rule.conditionType.startsWith('metadata_'));
  const [friendRows, tagRows, definitionRows] = await Promise.all([
    db
      .prepare(
        `SELECT f.id, f.line_user_id, f.line_account_id, f.is_following, f.metadata,
                a.channel_access_token, a.is_active AS account_is_active,
                assignment.friend_id AS assignment_friend_id,
                assignment.account_id AS assignment_account_id,
                assignment.rule_id AS assignment_rule_id,
                assignment.rich_menu_id AS assignment_rich_menu_id
         FROM friends f
         LEFT JOIN line_accounts a ON a.id = f.line_account_id
         LEFT JOIN rich_menu_friend_assignments assignment ON assignment.friend_id = f.id
         WHERE f.line_account_id = ?
           AND f.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(accountId, friendIdsJson)
      .all<BatchFriendRuleContext>(),
    needsTags
      ? db
        .prepare(
          `SELECT ft.friend_id, ft.tag_id, t.name
           FROM friend_tags ft
           JOIN tags t ON t.id = ft.tag_id
           JOIN friends f ON f.id = ft.friend_id
           WHERE f.line_account_id = ?
             AND f.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, friendIdsJson)
        .all<{ friend_id: string; tag_id: string; name: string }>()
      : Promise.resolve({ results: [] as Array<{ friend_id: string; tag_id: string; name: string }> }),
    needsMetadata
      ? db
        .prepare('SELECT name, default_value FROM friend_field_definitions WHERE is_active = 1')
        .all<{ name: string; default_value: string }>()
      : Promise.resolve({ results: [] as Array<{ name: string; default_value: string }> }),
  ]);
  const friends = new Map(
    friendRows.results
      .filter((friend) => leaseByFriendId.has(friend.id))
      .map((friend) => [friend.id, friend]),
  );
  const tagsByFriend = new Map<string, Array<{ tag_id: string; name: string }>>();
  for (const tag of tagRows.results) {
    if (!leaseByFriendId.has(tag.friend_id)) continue;
    const values = tagsByFriend.get(tag.friend_id) ?? [];
    values.push(tag);
    tagsByFriend.set(tag.friend_id, values);
  }
  const defaults = new Map(definitionRows.results.map((definition) => [definition.name, definition.default_value]));
  const results: RichMenuRuleApplyResult[] = [];
  const mutations: RichMenuRulePendingMutation[] = [];
  const upserts: BatchAssignmentWrite[] = [];
  const deletes: RichMenuRuleQueueLease[] = [];
  const clears: RichMenuRuleQueueLease[] = [];
  const retries: BatchRetryWrite[] = [];

  for (const lease of leases) {
    const friend = friends.get(lease.friendId);
    if (!friend) {
      results.push({ status: 'ignored', friendId: lease.friendId, reason: 'missing_friend' });
      clears.push(lease);
      continue;
    }
    if (friend.is_following !== 1) {
      results.push({ status: 'ignored', friendId: lease.friendId, reason: 'not_following' });
      clears.push(lease);
      continue;
    }
    if (!friend.line_account_id || !friend.channel_access_token) {
      results.push({ status: 'ignored', friendId: lease.friendId, reason: 'missing_account' });
      clears.push(lease);
      continue;
    }
    if (friend.account_is_active !== 1) {
      results.push({ status: 'ignored', friendId: lease.friendId, reason: 'inactive_account' });
      clears.push(lease);
      continue;
    }
    const assignment: FriendAssignment | null = friend.assignment_friend_id
      ? {
        friend_id: friend.assignment_friend_id,
        account_id: friend.assignment_account_id!,
        rule_id: friend.assignment_rule_id,
        rich_menu_id: friend.assignment_rich_menu_id,
      }
      : null;
    if (rules.length === 0 && !assignment) {
      results.push({ status: 'no_rules', friendId: lease.friendId });
      clears.push(lease);
      continue;
    }
    try {
      const tags = tagsByFriend.get(lease.friendId) ?? [];
      const winner = await findWinningRule(eligibleRules, {
        metadata: parseMetadata(friend.metadata),
        tagIds: new Set(tags.map((tag) => tag.tag_id)),
        tagNames: tags.map((tag) => tag.name),
        defaults,
      });
      const desiredRichMenuId = winner?.richMenuId ?? null;
      if (
        assignment
        && assignment.account_id === friend.line_account_id
        && assignment.rich_menu_id === desiredRichMenuId
      ) {
        if (rules.length === 0 && desiredRichMenuId === null) {
          deletes.push(lease);
          results.push({ status: 'no_rules', friendId: lease.friendId });
        } else {
          upserts.push({
            ...lease,
            friendId: lease.friendId,
            accountId: friend.line_account_id,
            ruleId: winner?.id ?? null,
            richMenuId: desiredRichMenuId,
          });
          results.push({
            status: 'skipped', friendId: lease.friendId, reason: 'same_menu',
            ruleId: winner?.id ?? null, richMenuId: desiredRichMenuId,
          });
        }
        clears.push(lease);
        continue;
      }
      mutations.push({
        action: winner ? 'link' : 'unlink',
        friendId: lease.friendId,
        lineUserId: friend.line_user_id,
        accountId: friend.line_account_id,
        channelAccessToken: friend.channel_access_token,
        ruleId: winner?.id ?? null,
        richMenuId: desiredRichMenuId,
        hadRules: rules.length > 0,
        queueLease: lease,
      });
    } catch (error) {
      const message = safeError(error);
      results.push({ status: 'failed', friendId: lease.friendId, error: message });
      retries.push({ ...lease, error: message });
    }
  }
  await persistBatchEffects(db, { upserts, deletes, clears, retries });
  return { results, mutations };
}

/** Persist accepted bulk results without weakening the queue revision/lease CAS. */
export async function settleRichMenuRuleMutationBatch(
  db: D1Database,
  outcomes: RichMenuRuleMutationOutcome[],
): Promise<RichMenuRuleApplyResult[]> {
  const results: RichMenuRuleApplyResult[] = [];
  const upserts: BatchAssignmentWrite[] = [];
  const deletes: RichMenuRuleQueueLease[] = [];
  const clears: RichMenuRuleQueueLease[] = [];
  const retries: BatchRetryWrite[] = [];
  const currentFriendIds = await currentLeaseFriendIds(
    db,
    outcomes.map((outcome) => outcome.mutation.queueLease),
  );
  const superseded = outcomes
    .map((outcome) => outcome.mutation)
    .filter((mutation) => !currentFriendIds.has(mutation.friendId));
  await enqueueSupersededMutations(db, superseded);
  for (const outcome of outcomes) {
    const mutation = outcome.mutation;
    if (!currentFriendIds.has(mutation.friendId)) {
      results.push({
        status: 'failed',
        friendId: mutation.friendId,
        error: 'queue lease was superseded; reconciliation queued',
      });
      continue;
    }
    if (outcome.error !== undefined) {
      const message = safeError(outcome.error);
      results.push({ status: 'failed', friendId: mutation.friendId, error: message });
      if (outcome.terminalFailure) clears.push(mutation.queueLease);
      else retries.push({ ...mutation.queueLease, error: message });
      continue;
    }
    if (mutation.action === 'link') {
      upserts.push({
        ...mutation.queueLease,
        friendId: mutation.friendId,
        accountId: mutation.accountId,
        ruleId: mutation.ruleId,
        richMenuId: mutation.richMenuId,
      });
      results.push({
        status: 'applied', friendId: mutation.friendId,
        ruleId: mutation.ruleId!, richMenuId: mutation.richMenuId!,
      });
    } else {
      if (mutation.hadRules) {
        upserts.push({
          ...mutation.queueLease,
          friendId: mutation.friendId,
          accountId: mutation.accountId,
          ruleId: null,
          richMenuId: null,
        });
      } else {
        deletes.push(mutation.queueLease);
      }
      results.push({ status: 'reverted', friendId: mutation.friendId, ruleId: null, richMenuId: null });
    }
    clears.push(mutation.queueLease);
  }
  await persistBatchEffects(db, { upserts, deletes, clears, retries });
  return results;
}

/**
 * Evaluate one friend and apply at most one LINE mutation.
 *
 * Rules are already returned in the deterministic winner order. A successful
 * assignment row is the local same-value cache, so repeated tag/metadata
 * writes do not even construct a LINE client. With zero rules and no prior
 * engine-owned assignment, the function is a complete external no-op.
 */
export async function applyRichMenuRulesForFriend(
  db: D1Database,
  friendId: string,
  clientFactory: RichMenuRuleLineClientFactory = defaultClientFactory,
  applyOptions: RichMenuRuleApplyOptions = {},
): Promise<RichMenuRuleApplyResult> {
  try {
    const friend = await db
      .prepare(
        `SELECT f.id, f.line_user_id, f.line_account_id, f.is_following, f.metadata,
                a.channel_access_token, a.is_active AS account_is_active
         FROM friends f
         LEFT JOIN line_accounts a ON a.id = f.line_account_id
         WHERE f.id = ?`,
      )
      .bind(friendId)
      .first<FriendRuleContext>();
    if (!friend) {
      await clearQueue(db, friendId, applyOptions);
      return { status: 'ignored', friendId, reason: 'missing_friend' };
    }
    if (friend.is_following !== 1) {
      await clearQueue(db, friendId, applyOptions);
      return { status: 'ignored', friendId, reason: 'not_following' };
    }
    if (!friend.line_account_id || !friend.channel_access_token) {
      await clearQueue(db, friendId, applyOptions);
      return { status: 'ignored', friendId, reason: 'missing_account' };
    }
    if (friend.account_is_active !== 1) {
      await clearQueue(db, friendId, applyOptions);
      return { status: 'ignored', friendId, reason: 'inactive_account' };
    }

    const [rules, assignment] = await Promise.all([
      listRichMenuDisplayRules(db, friend.line_account_id, { activeOnly: true }),
      db
        .prepare('SELECT friend_id, account_id, rule_id, rich_menu_id FROM rich_menu_friend_assignments WHERE friend_id = ?')
        .bind(friendId)
        .first<FriendAssignment>(),
    ]);

    if (rules.length === 0 && !assignment) {
      await clearQueue(db, friendId, applyOptions);
      return { status: 'no_rules', friendId };
    }

    const evaluatedAt = applyOptions.now ?? new Date();
    const eligibleRules = rules.filter((rule) => isRuleInActivePeriod(rule, evaluatedAt));
    const needsTags = eligibleRules.some((rule) => rule.conditionType.startsWith('tag_'));
    const needsMetadata = eligibleRules.some((rule) => rule.conditionType.startsWith('metadata_'));
    const [tagRows, definitionRows] = await Promise.all([
      needsTags
        ? db
          .prepare(
            `SELECT ft.tag_id, t.name
             FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id
             WHERE ft.friend_id = ?`,
          )
          .bind(friendId)
          .all<{ tag_id: string; name: string }>()
        : Promise.resolve({ results: [] as Array<{ tag_id: string; name: string }> }),
      needsMetadata
        ? db
          .prepare('SELECT name, default_value FROM friend_field_definitions WHERE is_active = 1')
          .all<{ name: string; default_value: string }>()
        : Promise.resolve({ results: [] as Array<{ name: string; default_value: string }> }),
    ]);
    const tagIds = new Set(tagRows.results.map((tag) => tag.tag_id));
    const tagNames = tagRows.results.map((tag) => tag.name);
    const defaults = new Map(definitionRows.results.map((definition) => [definition.name, definition.default_value]));
    const winner = await findWinningRule(eligibleRules, {
      metadata: parseMetadata(friend.metadata),
      tagIds,
      tagNames,
      defaults,
    });

    const desiredRichMenuId = winner?.richMenuId ?? null;
    if (
      assignment
      && assignment.account_id === friend.line_account_id
      && assignment.rich_menu_id === desiredRichMenuId
    ) {
      await saveAssignment(db, {
        friendId,
        accountId: friend.line_account_id,
        ruleId: winner?.id ?? null,
        richMenuId: desiredRichMenuId,
      });
      if (rules.length === 0 && desiredRichMenuId === null) {
        await forgetRichMenuRuleAssignment(db, friendId);
        await clearQueue(db, friendId, applyOptions);
        return { status: 'no_rules', friendId };
      }
      await clearQueue(db, friendId, applyOptions);
      return {
        status: 'skipped',
        friendId,
        reason: 'same_menu',
        ruleId: winner?.id ?? null,
        richMenuId: desiredRichMenuId,
      };
    }

    const line = clientFactory(friend.channel_access_token);
    if (winner) {
      await line.linkRichMenuToUser(friend.line_user_id, winner.richMenuId);
      await saveAssignment(db, {
        friendId,
        accountId: friend.line_account_id,
        ruleId: winner.id,
        richMenuId: winner.richMenuId,
      });
      await clearQueue(db, friendId, applyOptions);
      return {
        status: 'applied',
        friendId,
        ruleId: winner.id,
        richMenuId: winner.richMenuId,
      };
    }

    await line.unlinkRichMenuFromUser(friend.line_user_id);
    if (rules.length === 0) {
      await forgetRichMenuRuleAssignment(db, friendId);
    } else {
      await saveAssignment(db, {
        friendId,
        accountId: friend.line_account_id,
        ruleId: null,
        richMenuId: null,
      });
    }
    await clearQueue(db, friendId, applyOptions);
    return { status: 'reverted', friendId, ruleId: null, richMenuId: null };
  } catch (error) {
    try {
      await queueRetry(db, friendId, error, applyOptions);
    } catch {
      // The original operation remains fail-soft even if retry persistence is unavailable.
    }
    console.error(`[rich-menu-rules] evaluation failed for friend ${friendId}`);
    return { status: 'failed', friendId, error: safeError(error) };
  }
}
