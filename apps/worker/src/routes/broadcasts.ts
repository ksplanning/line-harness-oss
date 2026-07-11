import { Hono } from 'hono';
import {
  getBroadcasts,
  getBroadcastById,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
} from '@line-crm/db';
import type { Broadcast as DbBroadcast, BroadcastMessageType, BroadcastTargetType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { processBroadcastSend, buildMessage, processQueuedBroadcasts, countBroadcastRecipients } from '../services/broadcast.js';
import { checkMonthlyCap } from '../services/monthly-cap.js';
import { computeDedupBroadcastPreview } from '../services/dedup-broadcast.js';
import { processSegmentSend } from '../services/segment-send.js';
import type { SegmentCondition } from '../services/segment-query.js';
import { getLineAccountById, getSenderPresetById, resolveSenderForBroadcast, getAbTestById } from '@line-crm/db';
import { guardFlexContent } from '../utils/flex-persist-guard.js';
import type { Env } from '../index.js';

const broadcasts = new Hono<Env>();

/**
 * Parse a D1 JSON-array column. Returns:
 *   - null if the column is null/undefined/empty string or parse fails
 *   - the value as-is if already an array (some D1 drivers auto-parse JSON columns)
 *   - the parsed array if the JSON is a valid string-array
 *   - null if parsed JSON is not an array (e.g., object, scalar)
 */
function parseJsonArray(s: unknown): string[] | null {
  if (!s) return null;
  if (Array.isArray(s)) return s as string[];
  if (typeof s !== 'string') return null;
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function serializeBroadcast(row: DbBroadcast) {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    messageType: row.message_type,
    messageContent: row.message_content,
    targetType: row.target_type,
    targetTagId: row.target_tag_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    totalCount: row.total_count,
    successCount: row.success_count,
    lineRequestId: r.line_request_id || null,
    aggregationUnit: r.aggregation_unit || null,
    lineAccountId: r.line_account_id || null,
    accountIds: parseJsonArray(r.account_ids),
    dedupPriority: parseJsonArray(r.dedup_priority),
    failedAccountIds: parseJsonArray(r.failed_account_ids),
    senderPresetId: (r.sender_preset_id as string | null) ?? null,
    abTestId: (r.ab_test_id as string | null) ?? null,
    abVariant: (r.ab_variant as string | null) ?? null,
    messages: parseMessagesColumn(r.messages),
    createdAt: row.created_at,
  };
}

function isHttpsUrl(v: unknown): boolean {
  return typeof v === 'string' && /^https:\/\/\S+/.test(v);
}

/**
 * A/B 紐付け (abTestId/abVariant) の保存前検証 (G1・E2E CRITICAL fix)。
 *  - 紐付けなし (両方空) → OK
 *  - variant だけ (test 無し) → 孤児 variant 禁止 (400)
 *  - test だけ (variant 無し) → どの案か不明ゆえ 400
 *  - variant は 'A'|'B' のみ (migration は将来拡張で CHECK 無しだが標準 API は現行 2 案に限定)
 *  - test は account-scoped: account 未指定 or 別 account/不存在の ab_test は拒否 (既存 authz マスキング踏襲)
 * OK なら null、不正なら日本語エラー文字列。winner-draft は db 層 createBroadcast を直呼びするため本検証は通らない
 * (variant='winner' を許容する内部経路)。本検証は汎用 POST/PUT の入口のみ。
 */
async function validateAbBinding(
  db: D1Database,
  abTestId: string | null | undefined,
  abVariant: string | null | undefined,
  accountId: string | null | undefined,
): Promise<string | null> {
  const hasTest = typeof abTestId === 'string' && abTestId !== '';
  const hasVariant = typeof abVariant === 'string' && abVariant !== '';
  if (!hasTest && !hasVariant) return null;
  if (hasVariant && !hasTest) return 'A/B の案を指定するには A/B テストの指定が必要です';
  if (hasTest && !hasVariant) return 'A/B テストに紐付けるには案（A または B）を指定してください';
  if (abVariant !== 'A' && abVariant !== 'B') return 'A/B の案は A か B を指定してください';
  if (!accountId) return 'A/B テストに紐付けるにはアカウントの指定が必要です';
  const test = await getAbTestById(db, abTestId as string, accountId);
  if (!test) return '指定された A/B テストが見つかりません';
  return null;
}

/**
 * 新 type (video/audio/imagemap/richvideo) の保存前検証 (T-C5 / A1-A3)。
 * 不正なら日本語エラー文字列、OK (または対象外 type) なら null を返す。
 * text/image/flex は既存の検証 (flex は guardFlexContent) に委ねるため対象外。
 */
function validateBroadcastContent(messageType: string, messageContent: string): string | null {
  if (messageType !== 'video' && messageType !== 'audio' && messageType !== 'imagemap' && messageType !== 'richvideo') {
    return null;
  }
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(messageContent) as Record<string, unknown>;
  } catch {
    return 'メッセージ内容の形式が正しくありません';
  }
  if (messageType === 'video') {
    if (!isHttpsUrl(p.originalContentUrl) || !isHttpsUrl(p.previewImageUrl)) {
      return '動画URLとプレビュー画像URLは https で指定してください';
    }
    return null;
  }
  if (messageType === 'audio') {
    if (!isHttpsUrl(p.originalContentUrl)) return '音声URLは https で指定してください';
    if (typeof p.duration !== 'number' || !(p.duration > 0)) return '再生時間は正の数で指定してください';
    return null;
  }
  // imagemap / richvideo 共通
  if (!isHttpsUrl(p.baseUrl)) return '画像URLは https で指定してください';
  const bs = p.baseSize as { width?: unknown; height?: unknown } | undefined;
  if (!bs || typeof bs.width !== 'number' || typeof bs.height !== 'number' || bs.width <= 0 || bs.height <= 0) {
    return '画像サイズ(幅・高さ)を正しく指定してください';
  }
  if (!Array.isArray(p.actions)) return '領域リストの形式が正しくありません';
  for (const a of p.actions as Array<Record<string, unknown>>) {
    const area = a.area as Record<string, unknown> | undefined;
    if (!area || (['x', 'y', 'width', 'height'] as const).some((k) => typeof area[k] !== 'number')) {
      return '領域の座標・サイズを正しく指定してください';
    }
    if (a.type === 'uri' && !isHttpsUrl(a.linkUri)) return '領域のリンクURLは https で指定してください';
  }
  if (messageType === 'richvideo') {
    const v = p.video as Record<string, unknown> | undefined;
    if (!v || !isHttpsUrl(v.originalContentUrl) || !isHttpsUrl(v.previewImageUrl)) {
      return '動画URLとプレビュー画像URLは https で指定してください';
    }
  }
  return null;
}

// ---- combo messages (broadcast-combo-messages Batch 1) ----
const ALLOWED_MESSAGE_TYPES: readonly string[] = ['text', 'image', 'flex', 'video', 'audio', 'imagemap', 'richvideo'];

/** 保存/更新 payload の 1 メッセージブロック (先頭ミラーの正典・messages[0] が message_type/content/alt_text)。 */
interface MessageBlock {
  type: BroadcastMessageType;
  content: string;
  altText?: string | null;
}

/**
 * messages 配列の保存前検証 (C3 / codex HIGH #4)。配列・len 1..5・各要素 buildable を確認し、
 * 不正なら日本語エラー文字列 (400 用) を、OK なら null を返す。fail-loud: 壊れた要素は送信 builder
 * (buildMessage) が確定してから弾く (image の壊れ JSON 等を silent に通さない)。
 */
function validateMessagesArray(input: unknown): string | null {
  if (!Array.isArray(input)) return 'messages は配列で指定してください';
  if (input.length < 1) return 'メッセージを1件以上指定してください';
  if (input.length > 5) return 'メッセージは最大5件までです';
  for (const rawBlock of input) {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return 'メッセージの形式が正しくありません';
    const b = rawBlock as { type?: unknown; content?: unknown; altText?: unknown };
    if (typeof b.type !== 'string' || !ALLOWED_MESSAGE_TYPES.includes(b.type)) return 'メッセージの種別が不正です';
    if (typeof b.content !== 'string' || b.content.length === 0) return 'メッセージ内容が空です';
    if (b.altText !== undefined && b.altText !== null && typeof b.altText !== 'string') return 'altText の形式が正しくありません';
    const altText = typeof b.altText === 'string' ? b.altText : undefined;
    // 既存 single POST と同一の検証チェーンを要素ごとに適用。
    if (b.type === 'flex') {
      const guard = guardFlexContent(b.content, altText);
      if (!guard.ok) return guard.messageJa;
    }
    const contentErr = validateBroadcastContent(b.type, b.content);
    if (contentErr) return contentErr;
    // buildability の最終ゲート (validateBroadcastContent が拾わない image 等も送信 builder で確定)。
    try {
      buildMessage(b.type, b.content, altText);
    } catch {
      return 'メッセージ内容の形式が正しくありません';
    }
  }
  return null;
}

/** serializeBroadcast 用: 保存済み messages JSON を配列へ復元 (壊れていれば null にフォールバックせず null 返す)。 */
function parseMessagesColumn(value: unknown): MessageBlock[] | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as MessageBlock[]) : null;
  } catch {
    return null;
  }
}

// GET /api/broadcasts - list all
broadcasts.get('/api/broadcasts', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const items = await getBroadcasts(c.env.DB, lineAccountId || undefined);
    return c.json({ success: true, data: items.map(serializeBroadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id - get single
broadcasts.get('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);

    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/preview-count — 送信前の対象人数を計算する。
// draft 状態の broadcast に対し、send 確認モーダルで「対象 X人」を表示するために使う。
// target_type ごとに使う SQL を切り替える。total_count は send 後にしか入らないので、
// このエンドポイントが「送ったらこの人数」を返す唯一の手段。
broadcasts.get('/api/broadcasts/:id/preview-count', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);
    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    const raw = broadcast as unknown as Record<string, unknown>;
    let count = 0;
    let perAccount: Array<{ accountId: string; sendCount: number }> | undefined;

    if (broadcast.target_type === 'multi-account-dedup') {
      const accountIds = parseJsonArray(raw.account_ids) ?? [];
      const dedupPriority = parseJsonArray(raw.dedup_priority) ?? [];
      const preview = await computeDedupBroadcastPreview(
        c.env.DB,
        accountIds,
        dedupPriority,
        broadcast.target_tag_id ?? null,
      );
      // /send パスと同じく inactive/missing アカウントを除外して、実送信数の見積りを返す。
      // 同時に per-account breakdown も返して confirm modal に表示できるようにする。
      const { getLineAccountById } = await import('@line-crm/db');
      let active = 0;
      const breakdown: Array<{ accountId: string; sendCount: number }> = [];
      for (const a of preview.perAccount) {
        const account = await getLineAccountById(c.env.DB, a.accountId);
        if (account && account.is_active) {
          active += a.recipients.length;
          breakdown.push({ accountId: a.accountId, sendCount: a.recipients.length });
        }
      }
      count = active;
      perAccount = breakdown;
    } else if (broadcast.target_type === 'tag' && broadcast.target_tag_id) {
      // 注: ここは inline send パス (broadcast.ts:61 getFriendsByTag) が
      // line_account_id でフィルタしないので、preview もアカウント横断で数える。
      // 実際の送信先と modal 表示を一致させるための整合性。
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM friends f
           INNER JOIN friend_tags ft ON ft.friend_id = f.id
           WHERE ft.tag_id = ? AND f.is_following = 1`,
      ).bind(broadcast.target_tag_id).first<{ cnt: number }>();
      count = row?.cnt ?? 0;
    } else if (broadcast.target_type === 'all') {
      const accountId = (raw.line_account_id as string | null) || null;
      const sql = accountId
        ? `SELECT COUNT(*) AS cnt FROM friends WHERE is_following = 1 AND line_account_id = ?`
        : `SELECT COUNT(*) AS cnt FROM friends WHERE is_following = 1`;
      const binds: unknown[] = accountId ? [accountId] : [];
      const row = await c.env.DB.prepare(sql).bind(...binds).first<{ cnt: number }>();
      count = row?.cnt ?? 0;
    }

    return c.json({ success: true, data: { count, perAccount } });
  } catch (err) {
    console.error('GET /api/broadcasts/:id/preview-count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/per-account-stats — multi-account-dedup などで
// アカウント別の配信数 + insight 内訳を返す。
//
// 返り値:
//   data: [{
//     accountId, accountName,
//     sent: number,                    // messages_log での実送信数
//     uniqueImpression: number | null, // LINE Insight (アカ token で個別 fetch)
//     uniqueClick: number | null,
//   }]
//
// insight は live で各アカウントの token を使って LINE API を叩く (sent and aggregation_unit 必須)。
// キャッシュしない (broadcast_insights は集計値しか持たない設計のため)。
broadcasts.get('/api/broadcasts/:id/per-account-stats', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);
    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    const raw = broadcast as unknown as Record<string, unknown>;
    const aggregationUnit = (raw.aggregation_unit as string | null) || null;

    // 対象アカウントリスト: dedup なら account_ids JSON、それ以外なら line_account_id 単独
    let accountIds: string[];
    if (broadcast.target_type === 'multi-account-dedup') {
      accountIds = parseJsonArray(raw.account_ids) ?? [];
    } else {
      const single = (raw.line_account_id as string | null) || null;
      accountIds = single ? [single] : [];
    }

    if (accountIds.length === 0) {
      return c.json({ success: true, data: [] });
    }

    // sent 数: messages_log の line_account_id (送信時固定) で GROUP BY する。
    // 旧データ (032 migration 前) は ml.line_account_id=NULL なので、その場合だけ
    // friends.line_account_id にフォールバックする (best-effort、現在のアカウント帰属で集計)。
    const placeholders = accountIds.map(() => '?').join(',');
    const sentRes = await c.env.DB.prepare(
      `SELECT COALESCE(ml.line_account_id, f.line_account_id) AS account_id, COUNT(*) AS sent
       FROM messages_log ml
       INNER JOIN friends f ON f.id = ml.friend_id
       WHERE ml.broadcast_id = ? AND ml.direction = 'outgoing'
         AND COALESCE(ml.line_account_id, f.line_account_id) IN (${placeholders})
       GROUP BY COALESCE(ml.line_account_id, f.line_account_id)`,
    ).bind(id, ...accountIds).all<{ account_id: string; sent: number }>();
    const sentMap = new Map<string, number>();
    for (const r of sentRes.results ?? []) sentMap.set(r.account_id, r.sent);

    // アカウント名
    const metaRes = await c.env.DB.prepare(
      `SELECT id, name FROM line_accounts WHERE id IN (${placeholders})`,
    ).bind(...accountIds).all<{ id: string; name: string }>();
    const nameMap = new Map<string, string>();
    for (const r of metaRes.results ?? []) nameMap.set(r.id, r.name);

    // insight: status='sent' かつ aggregation_unit がある場合だけ live fetch する。
    // 各アカウントの LINE API call は 3-5 秒かかるので、Promise.all で並列化して
    // 4 アカ夢中なら ~5 秒、シリアルだと ~20 秒の差。Worker / browser timeout 回避用。
    const insightMap = new Map<string, { uniqueImpression: number | null; uniqueClick: number | null }>();
    if (broadcast.status === 'sent' && aggregationUnit && broadcast.sent_at) {
      const sentDate = broadcast.sent_at.slice(0, 10).replace(/-/g, '');
      const { getLineAccountById } = await import('@line-crm/db');
      await Promise.all(
        accountIds.map(async (aid) => {
          const account = await getLineAccountById(c.env.DB, aid);
          if (!account) return;
          try {
            const client = new LineClient(account.channel_access_token);
            const response = await client.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
            const messages = response.messages as Array<Record<string, unknown>> | undefined;
            const overview = messages?.[0] || {};
            insightMap.set(aid, {
              uniqueImpression: (overview.uniqueImpression as number) ?? null,
              uniqueClick: (overview.uniqueClick as number) ?? null,
            });
          } catch (err) {
            console.error(`[per-account-stats] account ${aid} insight failed:`, err);
          }
        }),
      );
    }

    const result = accountIds.map((aid) => ({
      accountId: aid,
      accountName: nameMap.get(aid) ?? aid,
      sent: sentMap.get(aid) ?? 0,
      uniqueImpression: insightMap.get(aid)?.uniqueImpression ?? null,
      uniqueClick: insightMap.get(aid)?.uniqueClick ?? null,
    }));

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/broadcasts/:id/per-account-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts - create
broadcasts.post('/api/broadcasts', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      messageType: BroadcastMessageType;
      messageContent: string;
      targetType: BroadcastTargetType;
      targetTagId?: string | null;
      scheduledAt?: string | null;
      lineAccountId?: string | null;
      altText?: string | null;
      accountIds?: string[];
      dedupPriority?: string[];
      senderPresetId?: string | null;
      abTestId?: string | null;
      abVariant?: string | null;
      messages?: MessageBlock[];
    }>();

    // combo: messages が来たら検証し、先頭を message_type/message_content/alt_text に server-authoritative
    // でミラーする (先頭ミラー不変条件)。単発 POST は comboMessages=undefined で従来経路 (byte 等価)。
    let comboMessages: string | undefined;
    if (body.messages !== undefined) {
      const mErr = validateMessagesArray(body.messages);
      if (mErr) return c.json({ success: false, error: mErr }, 400);
      const blocks = body.messages as MessageBlock[];
      comboMessages = JSON.stringify(blocks);
      body.messageType = blocks[0].type;
      body.messageContent = blocks[0].content;
      body.altText = blocks[0].altText ?? body.altText ?? null;
    }

    if (!body.title || !body.messageType || !body.messageContent || !body.targetType) {
      return c.json(
        { success: false, error: 'title, messageType, messageContent, and targetType are required' },
        400,
      );
    }

    // server 側 Flex 検証 (BACKLOG-flex / セキュリティ): client を迂回した API 直叩きでの
    // 不正 Flex 保存を保存前に 400 でブロック。client と同一の validateFlex (@line-crm/shared)。
    if (body.messageType === 'flex') {
      const guard = guardFlexContent(body.messageContent, body.altText);
      if (!guard.ok) {
        return c.json({ success: false, error: guard.messageJa }, 400);
      }
    }

    // 新 type (video/audio/imagemap/richvideo) の保存前検証 (不正 URL/欠損は 400)。
    const contentErr = validateBroadcastContent(body.messageType, body.messageContent);
    if (contentErr) return c.json({ success: false, error: contentErr }, 400);

    // sender は preset id 参照のみ受理 (生 name/iconUrl は body から読まない = なりすまし防止)。
    // 渡された senderPresetId が request account の実在 preset か server で照合し、別 account/不存在は 400。
    if (body.senderPresetId) {
      if (!body.lineAccountId) {
        return c.json({ success: false, error: '送信者プリセットを使うにはアカウントの指定が必要です' }, 400);
      }
      const preset = await getSenderPresetById(c.env.DB, body.senderPresetId, body.lineAccountId);
      if (!preset) {
        return c.json({ success: false, error: '指定された送信者プリセットが見つかりません' }, 400);
      }
    }

    if (body.targetType === 'tag' && !body.targetTagId) {
      return c.json(
        { success: false, error: 'targetTagId is required when targetType is "tag"' },
        400,
      );
    }

    // A/B 紐付け検証 (case account = body.lineAccountId・別 account/不正 variant は 400)。
    const abErr = await validateAbBinding(c.env.DB, body.abTestId, body.abVariant, body.lineAccountId);
    if (abErr) return c.json({ success: false, error: abErr }, 400);

    if (body.targetType === 'multi-account-dedup') {
      if (!Array.isArray(body.accountIds) || body.accountIds.length < 1) {
        return c.json({ success: false, error: 'accountIds (length >= 1) required for multi-account-dedup' }, 400);
      }
      if (!Array.isArray(body.dedupPriority)) {
        return c.json({ success: false, error: 'dedupPriority (array, may be empty) required for multi-account-dedup' }, 400);
      }
      // Defense in depth: drop priority entries not in accountIds before persisting.
      body.dedupPriority = body.dedupPriority.filter((id: unknown) =>
        typeof id === 'string' && body.accountIds!.includes(id));
    }

    const broadcast = await createBroadcast(c.env.DB, {
      title: body.title,
      messageType: body.messageType,
      messageContent: body.messageContent,
      targetType: body.targetType,
      targetTagId: body.targetTagId ?? null,
      scheduledAt: body.scheduledAt ?? null,
      accountIds: body.accountIds,
      dedupPriority: body.dedupPriority,
      senderPresetId: body.senderPresetId ?? null,
      abTestId: body.abTestId ?? null,
      abVariant: body.abVariant ?? null,
      messages: comboMessages,
    });

    // Save line_account_id and alt_text if provided
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (body.lineAccountId) { updates.push('line_account_id = ?'); binds.push(body.lineAccountId); }
    if (body.altText) { updates.push('alt_text = ?'); binds.push(body.altText); }
    if (updates.length > 0) {
      binds.push(broadcast.id);
      await c.env.DB.prepare(`UPDATE broadcasts SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...binds).run();
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) }, 201);
  } catch (err) {
    console.error('POST /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/broadcasts/:id - update draft
broadcasts.put('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'scheduled') {
      return c.json({ success: false, error: 'Only draft or scheduled broadcasts can be updated' }, 400);
    }

    const body = await c.req.json<{
      title?: string;
      messageType?: BroadcastMessageType;
      messageContent?: string;
      targetType?: BroadcastTargetType;
      targetTagId?: string | null;
      scheduledAt?: string | null;
      senderPresetId?: string | null;
      abTestId?: string | null;
      abVariant?: string | null;
      messages?: MessageBlock[];
    }>();

    // combo 真理値表 (codex HIGH #4 / plan §5 R-12)。
    const existingIsCombo = ((existing as unknown as { messages?: string | null }).messages ?? null) !== null;
    // combo 行への単一フィールド更新 (messages 省略で messageType/messageContent を更新) は先頭だけ書換わり
    // messages と不整合になる silent 事故 → fail-loud で 400。
    if (
      body.messages === undefined &&
      existingIsCombo &&
      (body.messageType !== undefined || body.messageContent !== undefined)
    ) {
      return c.json(
        { success: false, error: 'この配信は組み合わせメッセージです。メッセージは messages 配列で更新してください' },
        400,
      );
    }
    // messages 配列が来たら検証し、先頭ミラー用の更新値を組む (原子的に同一 UPDATE で反映)。
    let comboUpdate:
      | { messages: string; message_type: BroadcastMessageType; message_content: string; alt_text: string | null }
      | undefined;
    if (body.messages !== undefined) {
      const mErr = validateMessagesArray(body.messages);
      if (mErr) return c.json({ success: false, error: mErr }, 400);
      const blocks = body.messages as MessageBlock[];
      comboUpdate = {
        messages: JSON.stringify(blocks),
        message_type: blocks[0].type,
        message_content: blocks[0].content,
        alt_text: blocks[0].altText ?? null,
      };
    }

    // server 側 Flex 検証 (BACKLOG-flex): 更新後の実効 messageType が flex で、かつ
    // messageContent が body に present のときだけ検証する。messageType 未指定なら既存 type を採用。
    // → title だけの更新 (messageContent 未指定) は検証しない = 保存済み Flex が後方非互換で落ちない。
    // → text→flex に messageType だけ変える更新でも content を検証する (実効 type 判定)。
    const effectiveMessageType = body.messageType ?? existing.message_type;
    if (effectiveMessageType === 'flex' && body.messageContent !== undefined) {
      const guard = guardFlexContent(body.messageContent);
      if (!guard.ok) {
        return c.json({ success: false, error: guard.messageJa }, 400);
      }
    }

    // 新 type の保存前検証 (content 未指定の title-only 更新は検証しない = 後方互換)。
    if (body.messageContent !== undefined) {
      const contentErr = validateBroadcastContent(effectiveMessageType, body.messageContent);
      if (contentErr) return c.json({ success: false, error: contentErr }, 400);
    }

    // sender は preset id 参照のみ受理。既存配信の account に属する実在 preset か照合し、別 account/不存在は 400。
    if (body.senderPresetId) {
      const acc = (existing as unknown as Record<string, unknown>).line_account_id as string | null;
      if (!acc) {
        return c.json({ success: false, error: '送信者プリセットを使うにはアカウントの指定が必要です' }, 400);
      }
      const preset = await getSenderPresetById(c.env.DB, body.senderPresetId, acc);
      if (!preset) {
        return c.json({ success: false, error: '指定された送信者プリセットが見つかりません' }, 400);
      }
    }

    // A/B 紐付け更新の検証: body に abTestId/abVariant があれば実効値 (未指定は既存継承) で検証する。
    const existingRaw = existing as unknown as Record<string, unknown>;
    if (body.abTestId !== undefined || body.abVariant !== undefined) {
      const effTestId = body.abTestId !== undefined ? body.abTestId : (existingRaw.ab_test_id as string | null);
      const effVariant = body.abVariant !== undefined ? body.abVariant : (existingRaw.ab_variant as string | null);
      const abErr = await validateAbBinding(c.env.DB, effTestId, effVariant, existingRaw.line_account_id as string | null);
      if (abErr) return c.json({ success: false, error: abErr }, 400);
    }

    // Keep status in sync with scheduledAt changes
    let statusUpdate: 'draft' | 'scheduled' | undefined;
    if (body.scheduledAt !== undefined) {
      statusUpdate = body.scheduledAt ? 'scheduled' : 'draft';
    }

    const updated = await updateBroadcast(c.env.DB, id, {
      title: body.title,
      // combo 更新時は先頭ミラー値で message_type/message_content を上書き (server-authoritative)。
      message_type: comboUpdate ? comboUpdate.message_type : body.messageType,
      message_content: comboUpdate ? comboUpdate.message_content : body.messageContent,
      target_type: body.targetType,
      target_tag_id: body.targetTagId,
      scheduled_at: body.scheduledAt,
      sender_preset_id: body.senderPresetId,
      ...(comboUpdate ? { messages: comboUpdate.messages, alt_text: comboUpdate.alt_text } : {}),
      ...(body.abTestId !== undefined ? { ab_test_id: body.abTestId } : {}),
      ...(body.abVariant !== undefined ? { ab_variant: body.abVariant } : {}),
      ...(statusUpdate !== undefined ? { status: statusUpdate } : {}),
    });

    // 失敗 partial dedup broadcast を draft に戻して編集 → 再送するケースで、
    // 残っていた resume 用 state を全部クリアして fresh campaign として送り直せる
    // ようにする。
    // - dedup_progress: 残すと過去 partial を skip して mixed delivery 事故
    // - success_count: 残すと recover 経路の `success_count > 0 + dedup_progress=NULL`
    //   排除条件にひっかかって永久に stuck になる (再 lock 後 crash で復旧不可)
    // - failed_account_ids: 過去 attempt の失敗 mark を継承するのは misleading
    // - batch_lock_at: stale lock 跡を残さない
    // - sent_at: 念のため NULL に戻す。getQueuedBroadcasts / recoverStalledBroadcasts は
    //   `sent_at IS NULL` を要求するので、過去 sent 値が残ると永久 stuck の元
    // - aggregation_unit / line_request_id: 過去送信の insight 集計参照を残さない
    await c.env.DB.prepare(
      `UPDATE broadcasts SET
         dedup_progress = NULL,
         batch_lock_at = NULL,
         success_count = 0,
         failed_account_ids = NULL,
         sent_at = NULL,
         aggregation_unit = NULL,
         line_request_id = NULL
       WHERE id = ?`,
    ).bind(id).run();

    // 過去 send の insight 行を削除する。createBroadcastInsight は idempotent で
    // 既存行があれば skip する設計のため、削除しないと再送時に新しい pending
    // insight が作られず getPendingInsights / GET /insight が古い metrics を返し続ける。
    await c.env.DB.prepare(
      `DELETE FROM broadcast_insights WHERE broadcast_id = ?`,
    ).bind(id).run();

    return c.json({ success: true, data: updated ? serializeBroadcast(updated) : null });
  } catch (err) {
    console.error('PUT /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/broadcasts/:id - delete
broadcasts.delete('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteBroadcast(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send - send now (tag配信で500人超はキュー方式)
//
// Atomic UPDATE-WHERE で多重起動を防ぐ。check-then-act の TOCTOU race だと、
// 並列リクエストが同時に status='draft' を読んで両方が processBroadcastSend に
// 進入しうる (2026-04-10 19:50 の重複配信事故 broadcast 0069eb9f / 57c9667d)。
// 既存の lock 修正 (a27ad9f / bffcdf8 / 3ac2fec) は cron / scheduled 経路を
// 守ったが、API direct 経路は未対応のままだった。
broadcasts.post('/api/broadcasts/:id/send', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    // G2 entry pre-check: 送信入口で月次上限を即時確認 (UX 拒否)。真の送信点 (executor) にも
    // authoritative gate があるが、ここで早く弾いて owner に伝える。cap=null は常に通す (誤爆ゼロ)。
    // test-send はこの route を通らないため免除。実 multicast は一切叩かずに 429 で止める。
    {
      const entryAccountId = (existing as unknown as Record<string, unknown>).line_account_id as string | null;
      const pending = await countBroadcastRecipients(c.env.DB, existing);
      if (entryAccountId && pending !== null) {
        const cap = await checkMonthlyCap(c.env.DB, entryAccountId, pending);
        if (!cap.allowed) {
          return c.json({
            success: false,
            error: `今月の配信上限に達しています (今月${cap.count} / 上限${cap.cap} 通)。上限を変えるか来月までお待ちください。テスト送信は上限の対象外です。`,
            capBlocked: true,
            cap: { count: cap.count, cap: cap.cap, pending },
          }, 429);
        }
      }
    }

    // multi-account-dedup は常にキュー方式 — Worker の30秒制限を超えるため
    if (existing.target_type === 'multi-account-dedup') {
      // Always queue — never run inline. The executor walks per-account multicast
      // loops which can exceed the Worker's 30 s wall-clock if invoked synchronously.
      // Use status='sending' + batch_offset=0 to signal queued; processed by cron
      // via processQueuedBroadcasts (schema CHECK allows only draft/scheduled/sending/sent).
      //
      // total_count を同期計算して書く: progress polling が 0/0 のまま固まらないように。
      // computeDedupBroadcastPreview は単一SQL (ROW_NUMBER OVER) なので軽量。
      const rawExisting = existing as unknown as Record<string, unknown>;
      const accountIds = parseJsonArray(rawExisting.account_ids) ?? [];
      const dedupPriority = parseJsonArray(rawExisting.dedup_priority) ?? [];
      const preview = await computeDedupBroadcastPreview(
        c.env.DB,
        accountIds,
        dedupPriority,
        existing.target_tag_id ?? null,
      );

      // executor (processMultiAccountDedupBroadcast) は inactive/missing
      // アカウントを skip するので、total_count もそれに揃える。preview は
      // inactive 分も含めた全件を返すため、ここでアカウント状態を引き直して
      // active 分だけ集計する。これで confirm/progress UI と実送信数が一致する。
      let projectedTotal = 0;
      const { getLineAccountById } = await import('@line-crm/db');
      for (const a of preview.perAccount) {
        const account = await getLineAccountById(c.env.DB, a.accountId);
        if (account && account.is_active) projectedTotal += a.recipients.length;
      }

      const lockResult = await c.env.DB.prepare(
        `UPDATE broadcasts SET status = 'sending', batch_offset = 0, total_count = ? WHERE id = ? AND status IN ('draft','scheduled')`
      ).bind(projectedTotal, id).run();
      if (!lockResult.meta.changes) {
        return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
      }

      // cron (5min) を待たず即時にバックグラウンド処理を起動する。waitUntil なら
      // レスポンス返却後も Worker が処理を続行できる。失敗しても cron が拾うので
      // 二重で安全。processQueuedBroadcasts 内の楽観ロック (batch_offset=-1) が
      // 並走を防ぐ。
      try {
        const ctx = c.executionCtx as ExecutionContext;
        const defaultClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        ctx.waitUntil(
          processQueuedBroadcasts(c.env.DB, defaultClient, c.env.WORKER_URL).catch((err) => {
            console.error('[multi-account-dedup] background queue processing failed:', err);
          }),
        );
      } catch (kickErr) {
        // ExecutionContext 未利用環境 (test 等) — cron 経由にフォールバック
        console.warn('[multi-account-dedup] waitUntil unavailable, falling back to cron:', kickErr);
      }

      return c.json({
        success: true,
        data: { id, status: 'sending', totalCount: projectedTotal },
        queued: true,
        message: 'Broadcast queued for immediate background processing',
      }, 202);
    }

    // target_type='tag' で対象が多い場合はキュー方式
    if (existing.target_type === 'tag' && existing.target_tag_id) {
      const { getFriendsByTag } = await import('@line-crm/db');
      const friends = await getFriendsByTag(c.env.DB, existing.target_tag_id);
      const followingCount = friends.filter(f => f.is_following).length;

      if (followingCount > 500) {
        // Atomic lock: status='draft'|'scheduled' のときだけ status='sending' に遷移
        const tagMarker = JSON.stringify({ operator: 'AND', rules: [{ type: 'tag_exists', value: existing.target_tag_id }] });
        const lockResult = await c.env.DB.prepare(
          `UPDATE broadcasts SET status = 'sending', batch_offset = 0, segment_conditions = ? WHERE id = ? AND status IN ('draft','scheduled')`
        ).bind(tagMarker, id).run();
        if (!lockResult.meta.changes) {
          return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
        }
        const result = await getBroadcastById(c.env.DB, id);
        return c.json({ success: true, data: result ? serializeBroadcast(result) : null, queued: true, message: 'Broadcast queued for batch processing by Cron' }, 202);
      }
    }

    // 500人以下またはtarget_type='all'は即時送信
    // accessToken 解決は lock 前に行う (setup 失敗時に status='sending' で stuck しないため、
    // 即時送信パスには recoverStalledBroadcasts がない)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const broadcastAccountId = (existing as unknown as Record<string, unknown>).line_account_id;
    if (broadcastAccountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(c.env.DB, broadcastAccountId as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);

    // atomic lock — 'draft' と 'scheduled' を分けて単一 UPDATE で claim する。
    // 各 UPDATE は単一 write statement なので read-then-write transaction の
    // SQLITE_BUSY_SNAPSHOT を引き起こさず、claim 成功時の status も WHERE 句から
    // 一意に確定する (rollback 時の status 復元に使用)。
    let claimedStatus: 'draft' | 'scheduled' | null = null;
    const draftClaim = await c.env.DB.prepare(
      `UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'draft'`
    ).bind(id).run();
    if (draftClaim.meta.changes) {
      claimedStatus = 'draft';
    } else {
      const schedClaim = await c.env.DB.prepare(
        `UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'scheduled'`
      ).bind(id).run();
      if (schedClaim.meta.changes) {
        claimedStatus = 'scheduled';
      }
    }
    if (!claimedStatus) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    // processBroadcastSend は内部の try/catch で multicast 失敗を 'draft' に戻すが、
    // 冒頭 (updateBroadcastStatus / getBroadcastById / autoTrackContent / buildMessage) で
    // 失敗した場合は内部 catch の対象外。lock を外側で必ず rollback する。
    try {
      await processBroadcastSend(c.env.DB, lineClient, id, c.env.WORKER_URL);
    } catch (err) {
      await c.env.DB.prepare(
        `UPDATE broadcasts SET status = ? WHERE id = ? AND status = 'sending'`
      ).bind(claimedStatus, id).run();
      throw err;
    }

    const result = await getBroadcastById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send-segment - send to a filtered segment (常にキュー方式)
broadcasts.post('/api/broadcasts/:id/send-segment', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    const body = await c.req.json<{ conditions: SegmentCondition }>();

    if (!body.conditions || !body.conditions.operator || !Array.isArray(body.conditions.rules)) {
      return c.json(
        { success: false, error: 'conditions with operator and rules array is required' },
        400,
      );
    }

    // G2 entry pre-check: segment 送信の予定数 (conditions を account scope と AND した件数) で上限確認。
    // cap=null は常に通す (誤爆ゼロ)。上限超過なら 429 で止め multicast を叩かない。
    {
      const segAccountId = (existing as unknown as Record<string, unknown>).line_account_id as string | null;
      if (segAccountId) {
        const { buildSegmentWhere } = await import('../services/segment-query.js');
        const { clause, bindings } = buildSegmentWhere(body.conditions);
        const cnt = await c.env.DB.prepare(
          `SELECT COUNT(*) as c FROM friends f WHERE f.line_account_id = ? AND ${clause}`,
        ).bind(segAccountId, ...bindings).first<{ c: number }>();
        const pending = cnt?.c ?? 0;
        const cap = await checkMonthlyCap(c.env.DB, segAccountId, pending);
        if (!cap.allowed) {
          return c.json({
            success: false,
            error: `今月の配信上限に達しています (今月${cap.count} / 上限${cap.cap} 通)。上限を変えるか来月までお待ちください。テスト送信は上限の対象外です。`,
            capBlocked: true,
            cap: { count: cap.count, cap: cap.cap, pending },
          }, 429);
        }
      }
    }

    // Atomic lock: status='draft'|'scheduled' のときだけ status='sending' に遷移
    const lockResult = await c.env.DB.prepare(
      `UPDATE broadcasts SET status = 'sending', batch_offset = 0, segment_conditions = ? WHERE id = ? AND status IN ('draft','scheduled')`
    ).bind(JSON.stringify(body.conditions), id).run();
    if (!lockResult.meta.changes) {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 409);
    }

    const result = await getBroadcastById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null, queued: true, message: 'Broadcast queued for batch processing by Cron' }, 202);
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send-segment error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/insight — インサイト（開封率・クリック率）取得
broadcasts.get('/api/broadcasts/:id/insight', async (c) => {
  try {
    const id = c.req.param('id');
    const insight = await c.env.DB.prepare(
      'SELECT * FROM broadcast_insights WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(id).first<Record<string, unknown>>();

    if (!insight) {
      return c.json({ success: true, data: null, message: 'Insight not yet available' });
    }

    return c.json({
      success: true,
      data: {
        broadcastId: insight.broadcast_id,
        delivered: insight.delivered,
        uniqueImpression: insight.unique_impression,
        uniqueClick: insight.unique_click,
        uniqueMediaPlayed: insight.unique_media_played,
        openRate: insight.open_rate,
        clickRate: insight.click_rate,
        status: insight.status,
        fetchedAt: insight.fetched_at,
      },
    });
  } catch (err) {
    console.error('GET /api/broadcasts/:id/insight error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/fetch-insight — LINE APIからインサイトを即時取得
broadcasts.post('/api/broadcasts/:id/fetch-insight', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);
    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }
    if (broadcast.status !== 'sent') {
      return c.json({ success: false, error: 'Broadcast has not been sent yet' }, 400);
    }

    // DBから直接取得してline_request_id/aggregation_unit/account_ids/failed_account_idsを確実に読む
    const rawBroadcast = await c.env.DB.prepare(
      'SELECT line_request_id, aggregation_unit, line_account_id, target_type, account_ids, failed_account_ids FROM broadcasts WHERE id = ?',
    ).bind(id).first<Record<string, string | null>>();
    const lineRequestId = rawBroadcast?.line_request_id || null;
    const aggregationUnit = rawBroadcast?.aggregation_unit || null;
    const targetType = rawBroadcast?.target_type || null;

    if (!lineRequestId && !aggregationUnit) {
      return c.json({ success: false, error: 'No line_request_id or aggregation_unit available for this broadcast' }, 400);
    }

    let delivered: number | null = null;
    let uniqueImpression: number | null = null;
    let uniqueClick: number | null = null;
    let uniqueMediaPlayed: number | null = null;
    let rawResponse: string = '{}';

    const sentDate = broadcast.sent_at!.slice(0, 10).replace(/-/g, '');

    if (lineRequestId) {
      // broadcast API ('all') 経由の insight: 単一 lineRequestId で取れる
      const accountId = rawBroadcast?.line_account_id || null;
      let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(c.env.DB, accountId);
        if (account) accessToken = account.channel_access_token;
      }
      const lineClient = new LineClient(accessToken);
      const response = await lineClient.getMessageEventInsight(lineRequestId) as Record<string, unknown>;
      const overview = response.overview as Record<string, unknown> | undefined;
      delivered = (overview?.delivered as number) ?? null;
      uniqueImpression = (overview?.uniqueImpression as number) ?? null;
      uniqueClick = (overview?.uniqueClick as number) ?? null;
      uniqueMediaPlayed = (overview?.uniqueMediaPlayed as number) ?? null;
      rawResponse = JSON.stringify(response);
    } else if (aggregationUnit && targetType === 'multi-account-dedup') {
      // 多アカ dedup: 同じ unit 名を全アカウントの multicast で共有しているが、
      // LINE 側のカウントはチャネルごとに独立しているため、各アカウントの
      // channel_access_token で getUnitInsight を呼んで合算する。
      // failed_account_ids は除外しない: アカウントは途中バッチで例外を出しても
      // それ以前のバッチは送信成功している可能性があるため、部分配信の insight も
      // 拾うべき。
      const accountIds = parseJsonArray(rawBroadcast?.account_ids) ?? [];

      const { getLineAccountById } = await import('@line-crm/db');
      const responses: Array<{ accountId: string; data: Record<string, unknown> }> = [];

      let aggImpression = 0;
      let aggClick = 0;
      let aggMedia = 0;
      let hasAnyData = false;
      let allCallsFailed = true;

      for (const aid of accountIds) {
        // is_active は意図的にチェックしない: 送信時にアクティブだったアカウントが
        // insight 取得時に deactivate されてる可能性がある。token があれば LINE
        // API は叩けるので、過去配信の集計を欠損させない。
        const account = await getLineAccountById(c.env.DB, aid);
        if (!account) continue;
        const client = new LineClient(account.channel_access_token);
        try {
          const response = await client.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
          responses.push({ accountId: aid, data: response });
          allCallsFailed = false;
          const messages = response.messages as Array<Record<string, unknown>> | undefined;
          const overview = messages?.[0] || {};
          aggImpression += (overview.uniqueImpression as number) ?? 0;
          aggClick += (overview.uniqueClick as number) ?? 0;
          aggMedia += (overview.uniqueMediaPlayed as number) ?? 0;
          if (messages && messages.length > 0) hasAnyData = true;
        } catch (err) {
          console.error(`[fetch-insight] dedup account ${aid} failed:`, err);
          responses.push({ accountId: aid, data: { error: String(err) } });
        }
      }

      if (allCallsFailed && accountIds.length > 0) {
        // 全アカウントの API 呼び出しが失敗した場合、blank insight を保存して
        // retry ボタンを潰さないように 502 を返す (ユーザーが再試行できる状態)。
        return c.json({
          success: false,
          error: 'All account insight fetches failed; please retry later',
        }, 502);
      }

      if (hasAnyData) {
        uniqueImpression = aggImpression;
        uniqueClick = aggClick;
        uniqueMediaPlayed = aggMedia;
      }
      // delivered は unit insight には含まれない (LINE 仕様)。dedup の場合は
      // broadcasts.success_count を delivered として採用する (送達数の近似値)。
      delivered = (broadcast as unknown as Record<string, number | null>).success_count ?? null;
      rawResponse = JSON.stringify({ perAccount: responses });
    } else if (aggregationUnit) {
      // tag broadcast (単一アカ): 既存パス
      const accountId = rawBroadcast?.line_account_id || null;
      let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (accountId) {
        const { getLineAccountById } = await import('@line-crm/db');
        const account = await getLineAccountById(c.env.DB, accountId);
        if (account) accessToken = account.channel_access_token;
      }
      const lineClient = new LineClient(accessToken);
      const response = await lineClient.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
      const messages = response.messages as Array<Record<string, unknown>> | undefined;
      const overview = messages?.[0] || {};
      uniqueImpression = (overview.uniqueImpression as number) ?? null;
      uniqueClick = (overview.uniqueClick as number) ?? null;
      uniqueMediaPlayed = (overview.uniqueMediaPlayed as number) ?? null;
      rawResponse = JSON.stringify(response);
    }

    const openRate = (delivered && uniqueImpression) ? uniqueImpression / delivered : null;
    const clickRate = (delivered && uniqueClick) ? uniqueClick / delivered : null;

    // 旧コードの `ON CONFLICT(broadcast_id)` は broadcast_insights.broadcast_id に
    // UNIQUE 制約がないため D1 が `SQLITE_ERROR: ON CONFLICT clause does not match
    // any PRIMARY KEY or UNIQUE constraint` を返して 500 化していた。
    // SELECT で既存の pending 行を探して UPDATE、なければ INSERT する明示的 upsert に置き換え。
    const { jstNow } = await import('@line-crm/db');
    const now = jstNow();
    const existing = await c.env.DB.prepare(
      'SELECT id FROM broadcast_insights WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 1',
    ).bind(id).first<{ id: string }>();

    if (existing) {
      await c.env.DB.prepare(
        `UPDATE broadcast_insights SET
           delivered = ?, unique_impression = ?, unique_click = ?, unique_media_played = ?,
           open_rate = ?, click_rate = ?, raw_response = ?, status = 'ready', fetched_at = ?
         WHERE id = ?`,
      ).bind(delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate, rawResponse, now, existing.id).run();
    } else {
      const insightId = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO broadcast_insights (id, broadcast_id, delivered, unique_impression, unique_click, unique_media_played, open_rate, click_rate, raw_response, status, fetched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      ).bind(insightId, id, delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate, rawResponse, now, now).run();
    }

    return c.json({
      success: true,
      data: { delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate },
    });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/fetch-insight error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/test-send — send to test recipients with 【テスト配信】 label
broadcasts.post('/api/broadcasts/:id/test-send', async (c) => {
  const id = c.req.param('id');
  try {
    const broadcast = await getBroadcastById(c.env.DB, id);
    if (!broadcast) return c.json({ success: false, error: 'Broadcast not found' }, 404);
    if (broadcast.status !== 'draft') {
      return c.json({ success: false, error: 'Only draft broadcasts can be test-sent' }, 400);
    }

    const raw = broadcast as unknown as Record<string, unknown>;
    const accountId = raw.line_account_id as string | null;
    if (!accountId) return c.json({ success: false, error: 'Broadcast has no line_account_id' }, 400);

    // Get test recipients
    const setting = await c.env.DB.prepare(
      `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
    ).bind(accountId).first<{ value: string }>();
    if (!setting) return c.json({ success: false, error: 'No test recipients configured' }, 400);

    const friendIds: string[] = JSON.parse(setting.value);
    if (friendIds.length === 0) return c.json({ success: false, error: 'No test recipients configured' }, 400);

    const placeholders = friendIds.map(() => '?').join(',');
    const friends = await c.env.DB.prepare(
      `SELECT id, line_user_id FROM friends WHERE id IN (${placeholders})`
    ).bind(...friendIds).all<{ id: string; line_user_id: string }>();

    const account = await getLineAccountById(c.env.DB, accountId);
    if (!account) return c.json({ success: false, error: 'LINE account not found' }, 400);
    const lineClient = new LineClient(account.channel_access_token);

    // Build message with test label
    let messageContent = broadcast.message_content;
    if (broadcast.message_type === 'text') {
      messageContent = `【テスト配信】\n${messageContent}`;
    }

    // Auto-track URLs
    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(c.env.DB, broadcast.message_type, messageContent, c.env.WORKER_URL);

    const { extractFlexAltText } = await import('../utils/flex-alt-text.js');
    const altText = raw.alt_text as string || (tracked.messageType === 'flex' ? extractFlexAltText(tracked.content) : undefined);
    // 送信時に sender_preset_id → sender_presets (account-scoped) から name/iconUrl を解決して付与。
    // client の生 sender は一切信用しない (なりすまし防止・G25)。
    const sender = await resolveSenderForBroadcast(c.env.DB, raw.sender_preset_id as string | null, accountId);
    const message = buildMessage(tracked.messageType, tracked.content, altText, sender);

    let sent = 0;
    let failed = 0;
    const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

    for (const friend of friends.results) {
      try {
        await lineClient.pushMessage(friend.line_user_id, [message]);
        sent++;
        await c.env.DB.prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, delivery_type, source, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, 'test', 'broadcast', ?)`
        ).bind(crypto.randomUUID(), friend.id, broadcast.message_type, messageContent, now).run();
      } catch (err) {
        console.error(`Test send to ${friend.id} failed:`, err);
        failed++;
      }
    }

    return c.json({ success: true, sent, failed });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/test-send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id/progress — batch send progress
broadcasts.get('/api/broadcasts/:id/progress', async (c) => {
  const id = c.req.param('id');
  const broadcast = await getBroadcastById(c.env.DB, id);
  if (!broadcast) return c.json({ success: false, error: 'Not found' }, 404);

  const raw = broadcast as unknown as Record<string, unknown>;
  return c.json({
    success: true,
    data: {
      status: broadcast.status,
      totalCount: broadcast.total_count,
      successCount: broadcast.success_count,
      batchOffset: raw.batch_offset as number,
    },
  });
});

// POST /api/segments/count — count friends matching segment conditions
broadcasts.post('/api/segments/count', async (c) => {
  const body = await c.req.json<{ conditions: unknown; accountId?: string }>();
  try {
    const { buildSegmentWhere } = await import('../services/segment-query.js');
    const { clause, bindings } = buildSegmentWhere(body.conditions as SegmentCondition);

    // account 条件を構造的に AND (文字列 replace をやめる)。clause は複数ルールを括弧で
    // 包むので `f.line_account_id = ? AND (A OR B)` となり別アカウントが漏れない (HIGH-2)。
    const wheres: string[] = [];
    const binds: unknown[] = [];
    if (body.accountId) {
      wheres.push('f.line_account_id = ?');
      binds.push(body.accountId);
    }
    wheres.push(clause);
    binds.push(...bindings);

    const countSql = `SELECT COUNT(*) as count FROM friends f WHERE ${wheres.join(' AND ')}`;
    const result = await c.env.DB.prepare(countSql).bind(...binds).first<{ count: number }>();

    return c.json({ success: true, count: result?.count ?? 0 });
  } catch (err) {
    console.error('POST /api/segments/count error:', err);
    return c.json({ success: false, error: 'Invalid segment conditions' }, 400);
  }
});

export { broadcasts };
