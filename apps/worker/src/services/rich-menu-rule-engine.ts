import { listRichMenuDisplayRules } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import {
  evaluateConditionWithResolverStrict,
  type ConditionValueResolver,
} from './step-delivery.js';

export interface RichMenuRuleLineClient {
  linkRichMenuToUser(userId: string, richMenuId: string): Promise<unknown>;
  unlinkRichMenuFromUser(userId: string): Promise<unknown>;
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

const defaultClientFactory: RichMenuRuleLineClientFactory = (token) => new LineClient(token);

export interface RichMenuRuleApplyOptions {
  queueLease?: { token: string; revision: number };
  preserveQueue?: boolean;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
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

    const needsTags = rules.some((rule) => rule.conditionType.startsWith('tag_'));
    const needsMetadata = rules.some((rule) => rule.conditionType.startsWith('metadata_'));
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
    let metadata: Record<string, unknown> | null = null;
    if (typeof friend.metadata === 'string') {
      try {
        const parsed = JSON.parse(friend.metadata) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch {
        metadata = null;
      }
    }
    const tagIds = new Set(tagRows.results.map((tag) => tag.tag_id));
    const tagNames = tagRows.results.map((tag) => tag.name);
    const defaults = new Map(definitionRows.results.map((definition) => [definition.name, definition.default_value]));
    const resolver: ConditionValueResolver = {
      async hasTag(tagId) { return tagIds.has(tagId); },
      async getMetadata(key) {
        if (!metadata) return undefined;
        return Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : defaults.get(key);
      },
      async getTagNames() { return tagNames; },
    };

    let winner: (typeof rules)[number] | null = null;
    for (const rule of rules) {
      if (await evaluateConditionWithResolverStrict(resolver, {
        condition_type: rule.conditionType,
        condition_value: rule.conditionValue,
      })) {
        winner = rule;
        break;
      }
    }

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
