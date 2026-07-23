import { MessageBuildError } from '../utils/message-build.js';
import {
  getBroadcastById,
  getBroadcasts,
  getQueuedBroadcasts,
  updateBroadcastStatus,
  updateBroadcastBatchProgress,
  getFriendsByTag,
  jstNow,
  updateBroadcastLineRequestId,
  createBroadcastInsight,
} from '@line-crm/db';
import type { Broadcast } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message, MessageSender } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep, addMessageVariation } from './stealth.js';
import { checkMonthlyCap } from './monthly-cap.js';
import { renderMessageContent } from './render-message.js';
import { buildOutboundMessage } from './outbound-message.js';
import {
  countBroadcastAudience,
  listBroadcastRecipientSnapshot,
  parseStoredSegmentConditions,
  queueConditionalBroadcast,
} from './broadcast-audience.js';

const MULTICAST_BATCH_SIZE = 500;

/**
 * この broadcast の送信予定人数を数える (G2 上限 gate の「今回予定数」)。
 *  - multi-account-dedup: per-account 別計算のため単一 account の cap 対象外 (null = cap skip)。
 *  - segment: segment_conditions を account scope と AND して count。
 *  - tag: フォロー中 × タグ。
 *  - all: フォロー中の友だち数。
 * null は「cap 判定対象外 (skip)」を意味する (誤爆ゼロ側に倒す)。
 */
export async function countBroadcastRecipients(
  db: D1Database,
  broadcast: Broadcast,
): Promise<number | null> {
  const raw = broadcast as unknown as Record<string, unknown>;
  const accountId = raw.line_account_id as string | null;
  if (broadcast.target_type === 'multi-account-dedup') return null;
  if (broadcast.target_type === 'segment') {
    const conditions = parseStoredSegmentConditions(raw.segment_conditions);
    if (!accountId || !conditions) return null;
    return countBroadcastAudience(db, accountId, conditions);
  }
  const legacySegmentConditions = raw.segment_conditions as string | null;
  if (legacySegmentConditions) {
    const { buildSegmentWhere } = await import('./segment-query.js');
    const { clause, bindings } = buildSegmentWhere(JSON.parse(legacySegmentConditions));
    const wheres: string[] = [];
    const scopedBindings: unknown[] = [];
    if (accountId) {
      wheres.push('f.line_account_id = ?');
      scopedBindings.push(accountId);
    }
    wheres.push(clause);
    scopedBindings.push(...bindings);
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM friends f WHERE ${wheres.join(' AND ')}`)
      .bind(...scopedBindings)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }
  if (broadcast.target_type === 'tag' && broadcast.target_tag_id) {
    const tagFriends = await getFriendsByTag(db, broadcast.target_tag_id);
    return tagFriends.filter((f) => f.is_following).length;
  }
  // target_type === 'all'
  if (!accountId) return null;
  const r = await db.prepare(`SELECT COUNT(*) as c FROM friends WHERE is_following = 1 AND line_account_id = ?`).bind(accountId).first<{ c: number }>();
  return r?.c ?? 0;
}

export async function processBroadcastSend(
  db: D1Database,
  lineClient: LineClient,
  broadcastId: string,
  workerUrl?: string,
): Promise<Broadcast> {
  // Mark as sending
  await updateBroadcastStatus(db, broadcastId, 'sending');

  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  // Auto-wrap URLs with tracking links。combo は messages 配列の各要素を tracking 化する
  // (即時経路は cross-batch persist 不要なので送信用にのみ計算・single も従来どおり非永続)。
  let finalType: string = broadcast.message_type;
  let finalContent = broadcast.message_content;
  let finalMessages = ((broadcast as unknown as Record<string, unknown>).messages as string | null | undefined) ?? null;
  if (workerUrl) {
    if (finalMessages != null) {
      const tracked = await autoTrackBroadcastMessages(db, finalMessages, workerUrl);
      if (tracked.blocks.length > 0) {
        finalMessages = tracked.messages;
        finalType = tracked.blocks[0].type;
        finalContent = tracked.blocks[0].content;
      }
    } else {
      const { autoTrackContent } = await import('./auto-track.js');
      const tracked = await autoTrackContent(db, broadcast.message_type, broadcast.message_content, workerUrl);
      finalType = tracked.messageType;
      finalContent = tracked.content;
    }
  }
  // {{liff_id}} 置換用 liffId を解決する。render 自体は buildBroadcastMessages が要素単位に行う。
  // multi-account-dedup は dedup-broadcast.ts 側で per-account 置換するので、ここは
  // scheduled / tag / segment / all 系の単一 account 経路のみ (dedup では liffId=null)。
  let liffId: string | null = null;
  if (broadcast.target_type !== 'multi-account-dedup') {
    const broadcastAccountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    if (broadcastAccountId) {
      const { getLineAccountById: getLA } = await import('@line-crm/db');
      const acct = await getLA(db, broadcastAccountId);
      liffId = (acct as unknown as { liff_id?: string | null } | null)?.liff_id ?? null;
    }
  }
  // auto-track 結果 (finalType/finalContent/finalMessages) を反映した broadcast から Message[] を組む。
  // messages NULL は byte 等価な単発 (fallback)、非NULL は combo 配列。
  const sendBroadcast = { ...broadcast, message_type: finalType as Broadcast['message_type'], message_content: finalContent, messages: finalMessages };
  let messages: Message[];
  try {
    messages = buildBroadcastMessages(sendBroadcast, liffId);
  } catch (err) {
    // fail-closed: 不正な image/flex JSON や壊れた messages は送信スキップ (生 JSON を送らない / W5 T-E2)。
    // status は既存の rollback 流儀に合わせ 'draft' に戻す ('sending' で stuck させない)。
    // 'failed' は BroadcastStatus / CHECK 制約に無いので使わない。owner が draft を修正して送り直す。
    if (err instanceof MessageBuildError) {
      console.error(`Broadcast ${broadcastId} 送信スキップ (内容不正): ${err.message}`);
      await updateBroadcastStatus(db, broadcastId, 'draft');
    }
    throw err;
  }
  let totalCount = 0;
  let successCount = 0;

  try {
    if (broadcast.target_type === 'all') {
      // Use LINE broadcast API (sends to all followers)
      const { requestId } = await lineClient.broadcast(messages);
      await updateBroadcastLineRequestId(db, broadcast.id, requestId, null);
      // We don't have exact count for broadcast API, set as 0 (unknown)
      totalCount = 0;
      successCount = 0;
    } else if (broadcast.target_type === 'tag') {
      if (!broadcast.target_tag_id) {
        throw new Error('target_tag_id is required for tag-targeted broadcasts');
      }

      const friends = await getFriendsByTag(db, broadcast.target_tag_id);
      const followingFriends = friends.filter((f) => f.is_following);
      totalCount = followingFriends.length;

      // Send in batches with stealth delays to mimic human patterns
      const now = jstNow();
      const totalBatches = Math.ceil(followingFriends.length / MULTICAST_BATCH_SIZE);
      const unit = `bcast_${broadcast.id.slice(0, 8)}`;
      for (let i = 0; i < followingFriends.length; i += MULTICAST_BATCH_SIZE) {
        const batchIndex = Math.floor(i / MULTICAST_BATCH_SIZE);
        const batch = followingFriends.slice(i, i + MULTICAST_BATCH_SIZE);
        const lineUserIds = batch.map((f) => f.line_user_id);

        // Stealth: add staggered delay between batches
        if (batchIndex > 0) {
          const delay = calculateStaggerDelay(followingFriends.length, batchIndex);
          await sleep(delay);
        }

        // Stealth: add slight variation to text elements (combo は各 text 要素のみ)
        const batchMessages = applyBatchVariation(messages, batchIndex, totalBatches);

        try {
          await lineClient.multicast(lineUserIds, batchMessages, [unit]);
          successCount += batch.length;

          // Log only successfully sent messages (batch insert for performance)
          // line_account_id は broadcast 設定時のアカウントを記録 (送信時点の固定値)。
          // friends.line_account_id は webhook で書き換わる mutable なので使わない。
          const broadcastAccount = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
          const logStmts = batch.map(friend =>
            db.prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
            ).bind(crypto.randomUUID(), friend.id, broadcast.message_type, broadcast.message_content, broadcastId, broadcastAccount, now),
          );
          await db.batch(logStmts);
        } catch (err) {
          console.error(`Multicast batch ${i / MULTICAST_BATCH_SIZE} failed:`, err);
          // Continue with next batch; failed batch is not logged
        }
      }
      await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
    } else if (broadcast.target_type === 'segment') {
      throw new Error('Conditional broadcasts must be queued from a recipient snapshot');
    } else if (broadcast.target_type === 'multi-account-dedup') {
      // Always queued via routes/broadcasts.ts、ただし scheduled 経由でも
      // processBroadcastSend に到達するため両方カバーが必要。dedup 内部で
      // per-account に {{liff_id}} 置換 + buildMessage するが、auto-track
      // 結果 (finalType / finalContent) を反映した broadcast を渡さないと
      // tracked Flex 変換が落ちる。
      const { processMultiAccountDedupBroadcast } = await import('./dedup-broadcast.js');
      const broadcastForDedup = { ...broadcast, message_type: finalType, message_content: finalContent, messages: finalMessages };
      const result = await processMultiAccountDedupBroadcast(db, broadcastForDedup);
      totalCount = result.totalCount;
      successCount = result.successCount;
    }

    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcastId, 'sent', { totalCount, successCount });
  } catch (err) {
    // On failure, reset to draft so it can be retried
    await updateBroadcastStatus(db, broadcastId, 'draft');
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

export async function processScheduledBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const allBroadcasts = await getBroadcasts(db);

  const nowMs = Date.now();
  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  for (const broadcast of scheduled) {
    try {
      const accountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
      if (broadcast.target_type === 'segment') {
        const conditions = parseStoredSegmentConditions(
          (broadcast as unknown as Record<string, unknown>).segment_conditions,
        );
        if (!accountId || !conditions) {
          console.error(
            `Scheduled conditional broadcast ${broadcast.id} has invalid conditions; status reset to draft`,
          );
          await db
            .prepare(
              `UPDATE broadcasts
               SET status = 'draft', batch_offset = 0, batch_lock_at = NULL
               WHERE id = ? AND status = 'scheduled'`,
            )
            .bind(broadcast.id)
            .run();
          continue;
        }
        const queued = await queueConditionalBroadcast(db, broadcast, conditions, {
          capBlockedStatus: 'draft',
        });
        if (!queued.ok && queued.status !== 409) {
          console.warn(
            `Scheduled conditional broadcast ${broadcast.id} was not queued: ${queued.error}`,
          );
        }
        continue;
      }

      // Optimistic lock: claim this broadcast (scheduled → sending)
      const lockResult = await db
        .prepare(`UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'scheduled'`)
        .bind(broadcast.id)
        .run();
      if (!lockResult.meta.changes || lockResult.meta.changes === 0) continue;

      // Resolve correct lineClient for this broadcast's account
      let deliveryClient = lineClient;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(db, accountId);
        if (account) {
          const { LineClient: LC } = await import('@line-crm/line-sdk');
          deliveryClient = new LC(account.channel_access_token);
        }
      }

      // G2 authoritative gate: 真の送信点 (executor) でも月次上限を確認する。enqueue/予約時点で
      // 通っても、実行時点で cap 到達していれば止める (Codex HIGH)。cap=null は常に通す (誤爆ゼロ)。
      const scheduledPending = await countBroadcastRecipients(db, broadcast);
      const scheduledCap = await checkMonthlyCap(db, accountId, scheduledPending ?? 0);
      if (scheduledPending !== null && !scheduledCap.allowed) {
        console.warn(`[monthly-cap] scheduled broadcast ${broadcast.id} blocked: ${scheduledCap.count}+${scheduledPending} > ${scheduledCap.cap}. 上限まで送らずスキップ (status→draft)。`);
        await db.prepare(`UPDATE broadcasts SET status = 'draft' WHERE id = ? AND status = 'sending'`).bind(broadcast.id).run();
        continue;
      }

      await processBroadcastSend(db, deliveryClient, broadcast.id, workerUrl);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
      // Reset to scheduled so it can be retried next cron
      try {
        await db.prepare(`UPDATE broadcasts SET status = 'scheduled' WHERE id = ? AND status = 'sending'`)
          .bind(broadcast.id).run();
      } catch (resetErr) {
        console.error(`Failed to reset broadcast ${broadcast.id} status:`, resetErr);
      }
    }
  }
}

/**
 * Cronから呼ばれるキュー処理。status='queued' のブロードキャストを
 * batch_offset から500人ずつ処理する。1回のCron実行で全バッチを処理可能。
 */
export async function processQueuedBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const queued = await getQueuedBroadcasts(db);
  for (const broadcast of queued) {
    // アカウント別のlineClientを解決
    const accountId = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    let client = lineClient;
    if (accountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, accountId);
      if (account) client = new (await import('@line-crm/line-sdk')).LineClient(account.channel_access_token);
    }

    try {
      await processQueuedBroadcastBatches(db, client, broadcast, workerUrl);
    } catch (err) {
      console.error(`Failed to process queued broadcast ${broadcast.id}:`, err);
    }
  }
}

async function processQueuedBroadcastBatches(
  db: D1Database,
  lineClient: LineClient,
  broadcast: import('@line-crm/db').Broadcast,
  workerUrl?: string,
): Promise<void> {
  const raw = broadcast as unknown as Record<string, unknown>;
  const segmentConditionsStr = raw.segment_conditions as string | null;
  const batchOffset = (raw.batch_offset as number) || 0;

  // 排他ロック: batch_offset を -1 に設定して他のCronが拾わないようにする
  // WHERE batch_offset = ? で楽観ロック（既に他が処理中なら更新0行→スキップ）
  // batch_lock_at は recoverStalledBroadcasts が「ロック取得後 N 分経過」を判定する
  // ためのタイムスタンプ。created_at だと draft 作成時刻基準で本物の lock age と
  // ずれて Worker 並走 race を引き起こすため別カラムで管理する。
  // 重要: 値は SQL の strftime で生成する。jstNow() の '+09:00' suffix は SQLite で
  // UTC 正規化されて見かけ 9 時間古くなり、recover 側 (julianday('now','+9 hours'))
  // と比較すると即座に「stale」扱いされて lock 取得直後に解除される。created_at
  // 列の DEFAULT と同じ式を使って naive JST に揃える。
  const lockResult = await db.prepare(
    `UPDATE broadcasts SET batch_offset = -1, batch_lock_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = ? AND batch_offset = ?`,
  ).bind(broadcast.id, batchOffset).run();
  if (!lockResult.meta.changes || lockResult.meta.changes === 0) {
    // 他のCron実行が既に処理中 → スキップ
    return;
  }

  // auto-track（初回バッチのみ、offsetが0のとき）。combo は messages 配列の各要素を tracking 化し、
  // 更新後 messages を先頭ミラー付きで persist する (次バッチ以降で使えるように・offset 0 のみ = 冪等)。
  let finalType: string = broadcast.message_type;
  let finalContent = broadcast.message_content;
  let finalMessages = ((broadcast as unknown as Record<string, unknown>).messages as string | null | undefined) ?? null;
  if (workerUrl && batchOffset === 0) {
    if (finalMessages != null) {
      const tracked = await autoTrackBroadcastMessages(db, finalMessages, workerUrl);
      if (tracked.changed) {
        finalMessages = tracked.messages;
        finalType = tracked.blocks[0].type;
        finalContent = tracked.blocks[0].content;
        // messages + 先頭ミラー(message_type/content) を原子的に persist。
        await db.prepare('UPDATE broadcasts SET messages = ?, message_type = ?, message_content = ? WHERE id = ?')
          .bind(finalMessages, finalType, finalContent, broadcast.id).run();
      }
    } else {
      const { autoTrackContent } = await import('./auto-track.js');
      const tracked = await autoTrackContent(db, broadcast.message_type, broadcast.message_content, workerUrl);
      finalType = tracked.messageType;
      finalContent = tracked.content;
      // 変換後のコンテンツを保存（次バッチ以降で使えるように）
      if (finalType !== broadcast.message_type || finalContent !== broadcast.message_content) {
        await db.prepare('UPDATE broadcasts SET message_type = ?, message_content = ? WHERE id = ?')
          .bind(finalType, finalContent, broadcast.id).run();
      }
    }
  }

  // {{liff_id}} 置換用 liffId (single account 経路のみ; multi は dedup 側で per-account 置換)。
  let liffId: string | null = null;
  const queuedAccountId = raw.line_account_id as string | null;
  if (queuedAccountId && broadcast.target_type !== 'multi-account-dedup') {
    const { getLineAccountById: getLA } = await import('@line-crm/db');
    const acct = await getLA(db, queuedAccountId);
    liffId = (acct as unknown as { liff_id?: string | null } | null)?.liff_id ?? null;
  }
  const sendBroadcast = { ...broadcast, message_type: finalType as Broadcast['message_type'], message_content: finalContent, messages: finalMessages };
  let messages: Message[];
  try {
    messages = buildBroadcastMessages(sendBroadcast, liffId);
  } catch (err) {
    // fail-closed: 不正な image/flex JSON や壊れた messages は送信スキップ (生 JSON を送らない / W5 T-E2)。
    // batch_offset の排他ロック (-1) を解除しつつ status は既存 rollback 流儀の 'draft' に戻す。
    // 'failed' は BroadcastStatus / CHECK 制約に無いので使わない。次 cron の doomed retry を
    // 避けるためロックは 0 に戻さず -1 のまま status のみ draft にする手もあるが、recover が
    // 拾えるよう offset は解除する (owner が draft を修正して送り直す運用)。
    if (err instanceof MessageBuildError) {
      console.error(`Queued broadcast ${broadcast.id} 送信スキップ (内容不正): ${err.message}`);
      await db.prepare('UPDATE broadcasts SET batch_offset = 0, batch_lock_at = NULL WHERE id = ?')
        .bind(broadcast.id).run();
      await updateBroadcastStatus(db, broadcast.id, 'draft');
    }
    throw err;
  }

  // multi-account-dedup: delegate to processMultiAccountDedupBroadcast.
  // dedup ループは内部で per-account に {{liff_id}} 置換 + buildMessage する。
  // auto-track で計算された finalType / finalContent を反映した broadcast を
  // 渡す (broadcast 引数の message_content をそのまま使うと auto-track 結果が
  // 落ちる)。
  if (broadcast.target_type === 'multi-account-dedup') {
    const { processMultiAccountDedupBroadcast } = await import('./dedup-broadcast.js');
    const broadcastForDedup = { ...broadcast, message_type: finalType, message_content: finalContent, messages: finalMessages };
    const result = await processMultiAccountDedupBroadcast(db, broadcastForDedup);
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcast.id, 'sent', {
      totalCount: result.totalCount,
      successCount: result.successCount,
    });
    return;
  }

  // 対象ユーザーリストを取得（アカウントで絞り込む）
  const accountId = raw.line_account_id as string | null;
  let friends: Array<{ id: string; line_user_id: string }>;
  if (broadcast.target_type === 'segment') {
    friends = await listBroadcastRecipientSnapshot(db, broadcast.id);
  } else if (segmentConditionsStr) {
    const { buildSegmentWhere } = await import('./segment-query.js');
    const condition = JSON.parse(segmentConditionsStr);
    const { clause, bindings } = buildSegmentWhere(condition);
    // アカウントフィルタを構造的に AND (line_account_idで絞り込み)。clause は複数ルールを
    // 括弧で包むので `acc AND (A OR B)` となり別アカウントへ誤送信しない (HIGH-2)。
    const wheres: string[] = [];
    const accountBindings: unknown[] = [];
    if (accountId) {
      wheres.push('f.line_account_id = ?');
      accountBindings.push(accountId);
    }
    wheres.push(clause);
    accountBindings.push(...bindings);
    const accountSql = `SELECT f.id, f.line_user_id FROM friends f WHERE ${wheres.join(' AND ')}`;
    const result = await db.prepare(accountSql).bind(...accountBindings).all<{ id: string; line_user_id: string }>();
    friends = result.results ?? [];
  } else if (broadcast.target_tag_id) {
    const { getFriendsByTag } = await import('@line-crm/db');
    const tagFriends = await getFriendsByTag(db, broadcast.target_tag_id);
    friends = tagFriends.filter(f => f.is_following).map(f => ({ id: f.id, line_user_id: f.line_user_id }));
  } else {
    // target_type='all' でキューに入ることはないが、念のため
    const { requestId } = await lineClient.broadcast(messages);
    await updateBroadcastLineRequestId(db, broadcast.id, requestId, null);
    await createBroadcastInsight(db, broadcast.id);
    await updateBroadcastStatus(db, broadcast.id, 'sent', { totalCount: 0, successCount: 0 });
    return;
  }

  // G2 authoritative gate: 実 multicast 直前に月次上限を確認する (真の送信点・Codex HIGH)。
  // friends.length = 今回予定数 (exact)。cap=null は常に通す (誤爆ゼロ)。上限超過なら送らずに
  // 初回なら status→draft。snapshot 済み条件配信の途中再開なら、既送信者への再送を防ぐため
  // status='sending' と resume offset を保ち、上限が空いた次の cron で残りだけを送る。
  {
    const remaining = friends.length - batchOffset;
    const capCheck = await checkMonthlyCap(db, accountId, remaining);
    if (accountId && !capCheck.allowed) {
      if (broadcast.target_type === 'segment' && batchOffset > 0) {
        console.warn(`[monthly-cap] conditional broadcast ${broadcast.id} paused at offset ${batchOffset}: ${capCheck.count}+${remaining} > ${capCheck.cap}.`);
        await db
          .prepare(
            `UPDATE broadcasts
             SET batch_offset = ?, batch_lock_at = NULL
             WHERE id = ? AND status = 'sending' AND batch_offset = -1`,
          )
          .bind(batchOffset, broadcast.id)
          .run();
        return;
      }
      console.warn(`[monthly-cap] queued broadcast ${broadcast.id} blocked: ${capCheck.count}+${remaining} > ${capCheck.cap}. 上限まで送らずスキップ (status→draft)。`);
      await db.prepare('UPDATE broadcasts SET batch_offset = 0, batch_lock_at = NULL WHERE id = ?').bind(broadcast.id).run();
      await updateBroadcastStatus(db, broadcast.id, 'draft');
      return;
    }
  }

  // 初回: total_count を設定
  if (batchOffset === 0) {
    await db.prepare('UPDATE broadcasts SET total_count = ? WHERE id = ?')
      .bind(friends.length, broadcast.id).run();
  }

  const now = jstNow();
  const unit = `bcast_${broadcast.id.slice(0, 8)}`;
  let currentOffset = batchOffset;
  const totalBatches = Math.ceil(friends.length / MULTICAST_BATCH_SIZE);

  // 1回のCron実行で全バッチを処理（タイムアウトしない範囲で）
  while (currentOffset < friends.length) {
    const batch = friends.slice(currentOffset, currentOffset + MULTICAST_BATCH_SIZE);
    const lineUserIds = batch.map(f => f.line_user_id);
    const batchIndex = Math.floor(currentOffset / MULTICAST_BATCH_SIZE);

    // ステルス遅延（最初のバッチ以外）
    if (batchIndex > 0) {
      const delay = calculateStaggerDelay(friends.length, batchIndex);
      await sleep(delay);
    }

    // テキスト要素のバリエーション (combo は各 text 要素のみ)
    const batchMessages = applyBatchVariation(messages, batchIndex, totalBatches);

    try {
      await lineClient.multicast(lineUserIds, batchMessages, [unit]);
    } catch (err) {
      console.error(`Queued broadcast batch ${batchIndex} send failed:`, err);
      // 送信失敗: ロック解除 + offsetを保存して次のCronで再開
      await updateBroadcastBatchProgress(db, broadcast.id, currentOffset, 0);
      return; // batch_offset が currentOffset に戻り、次の cron で再開可能
    }

    // 送信成功後のログ・進捗更新（失敗しても再送しない）
    // line_account_id は queue path lock 時の broadcast.line_account_id を使う
    // (friends.line_account_id ではなく送信元アカウントを固定で記録)。
    const queuedBroadcastAccount = (broadcast as unknown as Record<string, unknown>).line_account_id as string | null;
    try {
      const stmts = batch.map(friend =>
        db.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, 'broadcast', ?, ?)`,
        ).bind(crypto.randomUUID(), friend.id, broadcast.message_type, broadcast.message_content, broadcast.id, queuedBroadcastAccount, now),
      );
      await db.batch(stmts);
    } catch (logErr) {
      console.error(`Queued broadcast batch ${batchIndex} log failed (messages already sent):`, logErr);
    }

    currentOffset += batch.length;
    // Update success_count but keep batch_offset=-1 (locked) during processing
    await db.prepare(
      `UPDATE broadcasts SET success_count = success_count + ? WHERE id = ?`,
    ).bind(batch.length, broadcast.id).run();
  }

  // 全バッチ完了 — ロック解除 + 完了マーク
  await updateBroadcastLineRequestId(db, broadcast.id, null, unit);
  await createBroadcastInsight(db, broadcast.id);
  await updateBroadcastStatus(db, broadcast.id, 'sent');
}

/**
 * broadcasts の message_type を共通 outbound renderer 経由で LINE Message object に変換する。
 * sender は preset 解決済みの値だけを付与し、未知 type / 不正 content は fail-closed にする。
 */
export function buildMessage(
  messageType: string,
  messageContent: string,
  altText?: string,
  sender?: MessageSender,
): Message {
  return buildOutboundMessage(messageType, messageContent, { altText, sender });
}

/**
 * broadcast を LINE の messages 配列 (最大5) に変換する (combo messages / broadcast-combo-messages)。
 *
 * - `messages` 列が **NULL** のときだけ従来 single へ fallback する (現行挙動と byte 等価):
 *   `[buildMessage(message_type, renderMessageContent(message_content, liffId), alt_text)]`。
 * - `messages` が **非 NULL** なら配列送信経路: JSON.parse → 各要素 buildMessage(要素単位 render)。
 * - [codex HIGH #3] 非 NULL だが不正 (parse失敗/非配列/空/len>5/要素の未知type/unbuildable) は
 *   silent に single へ落とさず MessageBuildError を throw する。呼び側は既存 image/flex と同じ
 *   fail-closed (送信スキップ→status draft・生 JSON を送らない) で処理する。
 * - renderMessageContent ({{liff_id}} 置換) は要素単位に適用する。liffId は呼び側が解決して渡す
 *   (multi-account-dedup は per-account の liffId・single 経路は account の liffId or null)。
 */
export function buildBroadcastMessages(
  // messages は **非 optional** (string | null)。呼出元が messages を渡し忘れた projection を compiler が
  // 弾き、silent single 化を構造的に不可能にする (F1)。
  broadcast: { message_type: string; message_content: string; messages: string | null; alt_text?: string | null },
  liffId: string | null = null,
): Message[] {
  const raw = broadcast as unknown as Record<string, unknown>;
  const messagesJson = broadcast.messages;
  const altText = (raw.alt_text as string | undefined) || undefined;

  // fail-loud: fallback は messages === null のときだけ。undefined / 非文字列は throw して silent single
  // に落とさない (spec C4「fallback は messages===NULL のみ」/ success_observable「構造的に不可能」)。
  if (messagesJson === null) {
    // fallback は messages === NULL のときだけ (byte 等価な単発)。
    return [buildMessage(broadcast.message_type, renderMessageContent(broadcast.message_content, liffId), altText)];
  }
  if (typeof messagesJson !== 'string') {
    throw new MessageBuildError('messages');
  }

  let blocks: unknown;
  try {
    blocks = JSON.parse(messagesJson);
  } catch {
    throw new MessageBuildError('messages');
  }
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 5) {
    throw new MessageBuildError('messages');
  }
  return blocks.map((rawBlock) => {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
      throw new MessageBuildError('messages');
    }
    const el = rawBlock as { type?: unknown; content?: unknown; altText?: unknown };
    if (typeof el.type !== 'string' || typeof el.content !== 'string') {
      throw new MessageBuildError('messages');
    }
    const elAlt = typeof el.altText === 'string' ? el.altText : undefined;
    return buildMessage(el.type, renderMessageContent(el.content, liffId), elAlt);
  });
}

/**
 * multicast のバッチごとの stealth 揺らぎを **text 要素だけ** に適用する (非 text・要素順序は不変)。
 * broadcast/queued/dedup/segment の 4 送信経路で同一挙動。totalBatches<=1 は揺らぎ無し (byte 等価)。
 */
export function applyBatchVariation(messages: Message[], batchIndex: number, totalBatches: number): Message[] {
  if (totalBatches <= 1) return messages;
  return messages.map((m) =>
    m.type === 'text' ? { ...m, text: addMessageVariation((m as { text: string }).text, batchIndex) } : m,
  );
}

/**
 * combo messages の各要素を auto-track する (C6)。text/flex 要素内の URL を tracking link 化し
 * (media 系は passthrough)、更新後 messages(JSON)と blocks を返す。block 単位のクリック帰属は v1
 * 対象外 — 全要素のリンクが漏れなく tracking 化されることが要件 (2-5 通目のリンクも追跡される)。
 * parse 不能/非配列は changed=false + blocks=[] で返し (呼び側で無改変)、送信は buildBroadcastMessages が
 * fail-closed で確定する。
 */
async function autoTrackBroadcastMessages(
  db: D1Database,
  messagesJson: string,
  workerUrl: string,
): Promise<{ messages: string; blocks: Array<{ type: string; content: string; altText?: string }>; changed: boolean }> {
  const { autoTrackContent } = await import('./auto-track.js');
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson);
  } catch {
    return { messages: messagesJson, blocks: [], changed: false };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { messages: messagesJson, blocks: [], changed: false };
  }
  let changed = false;
  const blocks: Array<{ type: string; content: string; altText?: string }> = [];
  for (const b of parsed as Array<{ type: string; content: string; altText?: string }>) {
    const tracked = await autoTrackContent(db, b.type, b.content, workerUrl);
    if (tracked.messageType !== b.type || tracked.content !== b.content) changed = true;
    blocks.push({ ...b, type: tracked.messageType, content: tracked.content });
  }
  return { messages: JSON.stringify(blocks), blocks, changed };
}
