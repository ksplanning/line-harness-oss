import { listRichMenuDisplayRules } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { evaluateConditionStrict } from './step-delivery.js';

export interface RichMenuRuleLineClient {
  linkRichMenuToUser(userId: string, richMenuId: string): Promise<unknown>;
  unlinkRichMenuFromUser(userId: string): Promise<unknown>;
}

export type RichMenuRuleLineClientFactory = (channelAccessToken: string) => RichMenuRuleLineClient;

export type RichMenuRuleApplyResult =
  | { status: 'no_rules'; friendId: string }
  | { status: 'ignored'; friendId: string; reason: 'missing_friend' | 'not_following' | 'missing_account' }
  | { status: 'applied'; friendId: string; ruleId: string; richMenuId: string }
  | { status: 'reverted'; friendId: string; ruleId: null; richMenuId: null }
  | { status: 'skipped'; friendId: string; reason: 'same_menu'; ruleId: string | null; richMenuId: string | null }
  | { status: 'failed'; friendId: string; error: string };

interface FriendRuleContext {
  id: string;
  line_user_id: string;
  line_account_id: string | null;
  is_following: number;
  channel_access_token: string | null;
}

interface FriendAssignment {
  friend_id: string;
  account_id: string;
  rule_id: string | null;
  rich_menu_id: string | null;
}

const defaultClientFactory: RichMenuRuleLineClientFactory = (token) => new LineClient(token);

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
}

async function clearQueue(db: D1Database, friendId: string): Promise<void> {
  await db.prepare('DELETE FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?').bind(friendId).run();
}

async function queueRetry(db: D1Database, friendId: string, error: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue
       (friend_id, attempts, available_at, last_error, updated_at)
       VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', '+5 minutes'), ?, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
       ON CONFLICT(friend_id) DO UPDATE SET
         attempts = rich_menu_rule_evaluation_queue.attempts + 1,
         available_at = excluded.available_at,
         last_error = excluded.last_error,
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
): Promise<RichMenuRuleApplyResult> {
  try {
    const friend = await db
      .prepare(
        `SELECT f.id, f.line_user_id, f.line_account_id, f.is_following,
                a.channel_access_token
         FROM friends f
         LEFT JOIN line_accounts a ON a.id = f.line_account_id
         WHERE f.id = ?`,
      )
      .bind(friendId)
      .first<FriendRuleContext>();
    if (!friend) {
      await clearQueue(db, friendId);
      return { status: 'ignored', friendId, reason: 'missing_friend' };
    }
    if (friend.is_following !== 1) {
      await clearQueue(db, friendId);
      return { status: 'ignored', friendId, reason: 'not_following' };
    }
    if (!friend.line_account_id || !friend.channel_access_token) {
      await clearQueue(db, friendId);
      return { status: 'ignored', friendId, reason: 'missing_account' };
    }

    const [rules, assignment] = await Promise.all([
      listRichMenuDisplayRules(db, friend.line_account_id, { activeOnly: true }),
      db
        .prepare('SELECT friend_id, account_id, rule_id, rich_menu_id FROM rich_menu_friend_assignments WHERE friend_id = ?')
        .bind(friendId)
        .first<FriendAssignment>(),
    ]);

    if (rules.length === 0 && !assignment) {
      await clearQueue(db, friendId);
      return { status: 'no_rules', friendId };
    }

    let winner: (typeof rules)[number] | null = null;
    for (const rule of rules) {
      if (await evaluateConditionStrict(db, friendId, {
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
        await clearQueue(db, friendId);
        return { status: 'no_rules', friendId };
      }
      await clearQueue(db, friendId);
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
      await clearQueue(db, friendId);
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
    await clearQueue(db, friendId);
    return { status: 'reverted', friendId, ruleId: null, richMenuId: null };
  } catch (error) {
    try {
      await queueRetry(db, friendId, error);
    } catch {
      // The original operation remains fail-soft even if retry persistence is unavailable.
    }
    console.error(`[rich-menu-rules] evaluation failed for friend ${friendId}`);
    return { status: 'failed', friendId, error: safeError(error) };
  }
}
