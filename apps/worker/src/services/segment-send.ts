import {
  getBroadcastById,
  updateBroadcastStatus,
  jstNow,
  updateBroadcastLineRequestId,
  createBroadcastInsight,
} from '@line-crm/db';
import type { Broadcast } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep } from './stealth.js';
import { buildSegmentWhere } from './segment-query.js';
import type { SegmentCondition } from './segment-query.js';
import { buildBroadcastMessages, applyBatchVariation } from './broadcast.js';

const MULTICAST_BATCH_SIZE = 500;

interface FriendRow {
  id: string;
  line_user_id: string;
}

export async function processSegmentSend(
  db: D1Database,
  lineClient: LineClient,
  broadcastId: string,
  condition: SegmentCondition,
): Promise<Broadcast> {
  // Mark as sending
  await updateBroadcastStatus(db, broadcastId, 'sending');

  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const messages = buildBroadcastMessages(broadcast, null);

  let totalCount = 0;
  let successCount = 0;

  try {
    // Build and execute segment query to get matching friends (アカウントで絞り込み)。
    // clause は複数ルールを括弧で包むので account 条件と AND しても別アカウントの
    // 友だちへ誤送信しない (HIGH-2: 従来の文字列 replace は `acc AND A OR B` で漏れた)。
    const { clause, bindings } = buildSegmentWhere(condition);
    const broadcastAccountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    const wheres: string[] = [];
    const finalBindings: unknown[] = [];
    if (broadcastAccountId) {
      wheres.push('f.line_account_id = ?');
      finalBindings.push(broadcastAccountId);
    }
    wheres.push(clause);
    finalBindings.push(...bindings);
    const finalSql = `SELECT f.id, f.line_user_id FROM friends f WHERE ${wheres.join(' AND ')}`;
    const queryResult = await db
      .prepare(finalSql)
      .bind(...finalBindings)
      .all<FriendRow>();

    const friends = queryResult.results ?? [];
    totalCount = friends.length;

    const now = jstNow();
    const totalBatches = Math.ceil(friends.length / MULTICAST_BATCH_SIZE);
    const unit = `bcast_${broadcast.id.slice(0, 8)}`;

    for (let i = 0; i < friends.length; i += MULTICAST_BATCH_SIZE) {
      const batchIndex = Math.floor(i / MULTICAST_BATCH_SIZE);
      const batch = friends.slice(i, i + MULTICAST_BATCH_SIZE);
      const lineUserIds = batch.map((f) => f.line_user_id);

      // Stealth: stagger delays between batches
      if (batchIndex > 0) {
        const delay = calculateStaggerDelay(friends.length, batchIndex);
        await sleep(delay);
      }

      // Stealth: text 要素のみバリエーション (combo は各 text 要素)
      const batchMessages = applyBatchVariation(messages, batchIndex, totalBatches);

      try {
        await lineClient.multicast(lineUserIds, batchMessages, [unit]);
        successCount += batch.length;

        // Log successfully sent messages (batch insert for performance)
        // line_account_id は broadcast 設定時の固定値を記録 (送信時点のチャネル).
        const segmentBroadcastAccount = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
        const logStmts = batch.map(friend =>
          db.prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
          ).bind(crypto.randomUUID(), friend.id, broadcast.message_type, broadcast.message_content, broadcastId, segmentBroadcastAccount, now),
        );
        await db.batch(logStmts);
      } catch (err) {
        console.error(`Segment multicast batch ${batchIndex} failed:`, err);
        // Continue with next batch; failed batch is not logged
      }
    }

    await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcastId, 'sent', { totalCount, successCount });
  } catch (err) {
    // On failure, reset to draft so it can be retried
    await updateBroadcastStatus(db, broadcastId, 'draft');
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

// buildMessage is imported from ./broadcast.js (single source of truth)
