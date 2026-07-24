import { Hono } from 'hono';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getOperators,
  getOperatorById,
  createOperator,
  updateOperator,
  deleteOperator,
  getChats,
  getChatById,
  createChat,
  getFriendById,
  getLineAccountById,
  getStaffById,
  setStaffReplySignatureEnabled,
  claimChatForStaff,
  completeChat,
  updateChat,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import {
  approveAiFaqDraft,
  discardAiFaqDraft,
  editAiFaqDraft,
  FaqDraftReviewError,
  listInlineAiFaqDrafts,
} from '../services/faq-draft-review.js';
import { getUnansweredFriendIds } from '../services/unanswered-inbox.js';
import { loadDefaultReplyName } from './account-settings.js';

const chats = new Hono<Env>();

function clampLoadingSeconds(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 5;
  return Math.min(60, Math.max(5, n));
}

async function startLoadingAnimation(
  accessToken: string,
  chatId: string,
  loadingSeconds: number,
): Promise<void> {
  const response = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ chatId, loadingSeconds }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail
        ? `LINE API error: ${response.status} - ${detail}`
        : `LINE API error: ${response.status}`,
    );
  }
}

type ChatLike = {
  id: string;
  friend_id: string;
  operator_id: string | null;
  assigned_staff_id: string | null;
  status: string;
  notes: string | null;
  read_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

// id は chats.id もしくは friend.id のどちらか。friend.id のときは chats 行を遅延作成する。
// push / broadcast / scenario 配信だけを受けた友だちもチャット画面に現れるため、ここで lazy create が必要。
// 新規作成する場合は status='resolved' にし、last_message_at は messages_log の実際の最終時刻を使う
// （jstNow を入れると一覧並び順が壊れるため）。
async function resolveOrCreateChat(db: D1Database, id: string): Promise<ChatLike | null> {
  const existing = await getChatById(db, id);
  if (existing) return existing as ChatLike;
  const friend = await getFriendById(db, id);
  if (!friend) return null;
  const byFriend = await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>();
  if (byFriend) return byFriend;

  const lastMsg = await db
    .prepare(
      `SELECT created_at AS last, direction
         FROM messages_log
        WHERE friend_id = ?
          AND (delivery_type IS NULL OR delivery_type != 'test')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(friend.id)
    .first<{ last: string; direction: string }>();
  const newId = crypto.randomUUID();
  const now = jstNow();
  const lastMessageAt = lastMsg?.last ?? null;
  const initialStatus = lastMsg?.direction === 'incoming' ? 'unread' : 'resolved';
  // 同時実行で二重挿入されないように WHERE NOT EXISTS で原子挿入。挿入結果に関わらず最古行を返して収束。
  await db
    .prepare(
      `INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM chats WHERE friend_id = ?)`,
    )
    .bind(newId, friend.id, initialStatus, lastMessageAt, now, now, friend.id)
    .run();
  return (await db
    .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(friend.id)
    .first<ChatLike>())!;
}

async function resolveFriendAndAccessToken(
  db: D1Database,
  friendId: string,
  defaultAccessToken: string,
) {
  const friend = await getFriendById(db, friendId);
  if (!friend) {
    return { friend: null, accessToken: null, accountName: null };
  }

  if (!friend.line_account_id) {
    return { friend, accessToken: defaultAccessToken, accountName: null };
  }

  const account = await getLineAccountById(db, friend.line_account_id);
  if (!account || !account.is_active) {
    return { friend, accessToken: null, accountName: null };
  }

  return {
    friend,
    accessToken: account.channel_access_token,
    accountName: account.name,
  };
}

// ========== オペレーターCRUD ==========

chats.get('/api/operators', async (c) => {
  try {
    const items = await getOperators(c.env.DB);
    return c.json({
      success: true,
      data: items.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        role: o.role,
        isActive: Boolean(o.is_active),
        createdAt: o.created_at,
        updatedAt: o.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/operators error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/operators', async (c) => {
  try {
    const body = await c.req.json<{ name: string; email: string; role?: string }>();
    if (!body.name || !body.email) return c.json({ success: false, error: 'name and email are required' }, 400);
    const item = await createOperator(c.env.DB, body);
    return c.json({ success: true, data: { id: item.id, name: item.name, email: item.email, role: item.role } }, 201);
  } catch (err) {
    console.error('POST /api/operators error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.put('/api/operators/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateOperator(c.env.DB, id, body);
    const updated = await getOperatorById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error('PUT /api/operators/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.delete('/api/operators/:id', async (c) => {
  try {
    await deleteOperator(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/operators/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== チャットCRUD ==========

chats.get('/api/chats', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const operatorId = c.req.query('operatorId') ?? undefined;
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const unansweredOnly =
      c.req.query('unansweredOnly') === 'true' || c.req.query('unansweredOnly') === '1';

    const unansweredIds = await getUnansweredFriendIds(c.env.DB);
    if (unansweredOnly) {
      // 空 Set のとき = 未対応ゼロ。早期 return で空配列を返す。
      if (unansweredIds.size === 0) {
        return c.json({ success: true, data: [] });
      }
    }

    // List everyone who has any message history (incoming or outgoing — push/broadcast/scenario included)
    // PLUS any chats row that exists even before any messages_log entry is written.
    // Source = messages_log ∪ chats.friend_id; chats は status/operator/notes 用に LEFT JOIN で最新1件だけ採用。
    //
    // recent_msg CTE で friend_id ごとに最新の messages_log 行をひとつ取得し、本文 preview と
    // direction (incoming/outgoing) を一覧に出す。
    //
    // パフォーマンス対策:
    //   1. lineAccountId 指定時は scoped_friends CTE で先に対象 friend を絞ってから messages_log
    //      を ranking する (アカ別 inbox が他アカの履歴をスキャンしないように)。
    //   2. content は text のみ先頭 200 文字まで切り詰めて返す (flex/image など raw JSON を返すと
    //      broadcast 後の rows で multi-MB レスポンスになる)。
    const accountFilterSql = lineAccountId
      ? `friend_id IN (SELECT id FROM friends WHERE line_account_id = ?)`
      : `1=1`;
    let sql = `
      WITH activity AS (
        SELECT friend_id, MAX(created_at) AS last_message_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
        GROUP BY friend_id
        UNION ALL
        SELECT friend_id, last_message_at
        FROM chats
        WHERE ${accountFilterSql}
      ),
      deduped AS (
        SELECT friend_id, MAX(last_message_at) AS last_message_at
        FROM activity
        GROUP BY friend_id
      ),
      -- preview は **最新の incoming (ユーザー発)** を優先する。auto_reply / scenario 等の
      -- outbound が直後に書き込まれて preview を上書きすると「ユーザーが何と言ったか」が
      -- 一覧から見えなくなる (operator triage の主目的が損なわれる)。
      -- incoming が無い (broadcast push など outbound only) chat は最新 outbound にフォールバック。
      -- text 以外 (flex/image/sticker 等) は content を NULL にして payload size を抑える
      -- (フロントは type で 📋 Flex / 📷 画像 等のラベルを出すので content は不要)。
      -- preview は **常に最新メッセージ** を表示する。postback (rich menu tap) も含む。
      -- preview text と displayed time を揃えるための単純化 (deprioritize すると
      -- 「最新は postback だが preview は古い text」の time mismatch が起きるため)。
      -- 注: postback.data が opaque な JSON token だと一覧で人間には読めない値が出るが、
      -- それは admin が rich menu の postback.data を人間向け文言にすべき config 問題。
      -- (LINE 仕様: postback.displayText は admin が設定可能、それを data に揃えるのが推奨)
      ranked_in AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type, created_at,
          ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
        FROM messages_log
        WHERE direction = 'incoming'
          AND (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
      ),
      ranked_any AS (
        SELECT friend_id,
          CASE WHEN message_type = 'text' THEN SUBSTR(content, 1, 200) ELSE NULL END AS content,
          direction, message_type, created_at,
          ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND ${accountFilterSql}
      ),
      -- ra (any direction の最新) を master にして、ri (incoming の最新) を LEFT JOIN。
      -- COALESCE で ri 優先 → incoming があればそれ、無ければ outbound にフォールバック。
      -- created_at も preview の元メッセージに合わせて返す (一覧の時刻と preview text が
      -- 別メッセージを指して mismatch する事故を防ぐ)。
      recent_msg AS (
        SELECT
          ra.friend_id,
          COALESCE(ri.content, ra.content) AS content,
          COALESCE(ri.direction, ra.direction) AS direction,
          COALESCE(ri.message_type, ra.message_type) AS message_type,
          COALESCE(ri.created_at, ra.created_at) AS preview_at
        FROM (SELECT * FROM ranked_any WHERE rn = 1) ra
        LEFT JOIN (SELECT * FROM ranked_in WHERE rn = 1) ri ON ra.friend_id = ri.friend_id
      )
      SELECT
        f.id AS id,
        f.id AS friend_id,
        f.display_name,
        f.picture_url,
        f.line_user_id,
        f.line_account_id,
        c.operator_id,
        COALESCE(c.status, 'resolved') AS status,
        c.notes,
        -- last_message_at は preview メッセージの時刻に揃える (一覧 row の時刻表示と preview が
        -- 別メッセージを指す mismatch を防ぐ)。preview が無い (chats 行のみ存在) ケースは
        -- d.last_message_at にフォールバック。
        COALESCE(rm.preview_at, d.last_message_at) AS last_message_at,
        rm.content AS last_message_content,
        rm.direction AS last_message_direction,
        rm.message_type AS last_message_type,
        COALESCE(c.created_at, d.last_message_at) AS created_at,
        COALESCE(c.updated_at, d.last_message_at) AS updated_at
      FROM deduped d
      INNER JOIN friends f ON f.id = d.friend_id
      LEFT JOIN chats c ON c.id = (
        SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN recent_msg rm ON rm.friend_id = f.id
    `;
    // accountFilterSql に '?' が複数 (4 箇所) あるので、bindings は事前に積んでおく。
    const ctePrebindings: unknown[] = lineAccountId
      ? [lineAccountId, lineAccountId, lineAccountId, lineAccountId]
      : [];
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (status) {
      conditions.push(`COALESCE(c.status, 'resolved') = ?`);
      bindings.push(status);
    }
    if (operatorId) {
      conditions.push('c.operator_id = ?');
      bindings.push(operatorId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      bindings.push(lineAccountId);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY d.last_message_at DESC';

    // CTE 内 placeholder (4 個) → 外側 WHERE placeholder の順に bind する
    const allBindings = [...ctePrebindings, ...bindings];
    const stmt = allBindings.length > 0
      ? c.env.DB.prepare(sql).bind(...allBindings)
      : c.env.DB.prepare(sql);
    const result = await stmt.all();

    let data = result.results.map((ch: Record<string, unknown>) => ({
      id: ch.id as string,
      friendId: ch.friend_id,
      friendName: ch.display_name || '名前なし',
      friendPictureUrl: ch.picture_url || null,
      operatorId: ch.operator_id,
      status: ch.status,
      notes: ch.notes,
      isUnanswered: unansweredIds.has(ch.friend_id as string),
      lastMessageAt: ch.last_message_at,
      lastMessageContent: ch.last_message_content || null,
      lastMessageDirection: ch.last_message_direction || null,
      lastMessageType: ch.last_message_type || null,
      createdAt: ch.created_at,
      updatedAt: ch.updated_at,
    }));

    if (unansweredOnly) {
      data = data.filter((row) => unansweredIds.has(row.friendId as string));
    }

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

async function loadChatDetail(db: D1Database, rawId: string) {
  // id は chats.id または friend.id のどちらでもOK。
  let chatRow = await getChatById(db, rawId);
  let friendId: string | null = null;

  if (!chatRow) {
    const friendRow = await getFriendById(db, rawId);
    if (!friendRow) return null;
    friendId = friendRow.id;
    chatRow = await db
      .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(friendRow.id)
      .first<Awaited<ReturnType<typeof getChatById>>>();
  }

  const resolvedFriendId = chatRow?.friend_id ?? friendId!;
  const assignedStaffId = chatRow?.assigned_staff_id ?? null;
  const [friend, assignedStaff, messages, pendingDrafts, unansweredIds] = await Promise.all([
    db
      .prepare(
        `SELECT f.display_name, f.picture_url, f.line_user_id,
                f.line_account_id, la.name AS line_account_name
           FROM friends f
           LEFT JOIN line_accounts la ON la.id = f.line_account_id
          WHERE f.id = ?`,
      )
      .bind(resolvedFriendId)
      .first<{
        display_name: string | null;
        picture_url: string | null;
        line_user_id: string;
        line_account_id: string | null;
        line_account_name: string | null;
      }>(),
    assignedStaffId ? getStaffById(db, assignedStaffId) : Promise.resolve(null),
    db
      .prepare(
        `SELECT ml.id, ml.friend_id, ml.direction, ml.message_type, ml.content,
                ml.staff_member_id, sm.name AS staff_member_name, ml.created_at
           FROM messages_log ml
           LEFT JOIN staff_members sm ON sm.id = ml.staff_member_id
          WHERE ml.friend_id = ?
            AND (ml.delivery_type IS NULL OR ml.delivery_type != 'test')
          ORDER BY ml.created_at DESC
          LIMIT 1000`,
      )
      .bind(resolvedFriendId)
      .all<Record<string, unknown>>(),
    listInlineAiFaqDrafts(db, resolvedFriendId),
    getUnansweredFriendIds(db),
  ]);

  return {
    id: resolvedFriendId,
    friendId: resolvedFriendId,
    friendName: friend?.display_name || '名前なし',
    friendPictureUrl: friend?.picture_url || null,
    lineAccountId: friend?.line_account_id ?? null,
    lineAccountName: friend?.line_account_name ?? null,
    operatorId: chatRow?.operator_id ?? null,
    assignedStaffId,
    assignedStaffName: assignedStaff?.name
      ?? (assignedStaffId === 'env-owner' ? 'Owner' : null),
    status: chatRow?.status ?? 'resolved',
    isUnanswered: unansweredIds.has(resolvedFriendId),
    notes: chatRow?.notes ?? null,
    readAt: chatRow?.read_at ?? null,
    lastMessageAt: chatRow?.last_message_at ?? null,
    createdAt: chatRow?.created_at ?? null,
    messages: (messages.results ?? []).reverse().map((message) => ({
      id: message.id,
      direction: message.direction,
      messageType: message.message_type,
      content: message.content,
      staffMemberId: message.staff_member_id ?? null,
      staffMemberName: message.staff_member_name ?? null,
      createdAt: message.created_at,
    })),
    pendingDrafts,
  };
}

async function loadInquiryPreferences(
  db: D1Database,
  actor: { id: string; name: string },
) {
  const staff = await getStaffById(db, actor.id);
  return {
    staffId: actor.id,
    staffName: actor.name,
    replySignatureEnabled: staff?.reply_signature_enabled !== 0,
    canUpdate: staff !== null,
  };
}

chats.get('/api/chats/inquiry/preferences', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  try {
    return c.json({
      success: true,
      data: await loadInquiryPreferences(c.env.DB, actor),
    });
  } catch (err) {
    console.error('GET /api/chats/inquiry/preferences error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.patch('/api/chats/inquiry/preferences', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  let body: { replySignatureEnabled?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  if (typeof body.replySignatureEnabled !== 'boolean') {
    return c.json({
      success: false,
      error: 'replySignatureEnabled must be a boolean',
    }, 400);
  }
  try {
    const staff = await setStaffReplySignatureEnabled(
      c.env.DB,
      actor.id,
      body.replySignatureEnabled,
    );
    if (!staff) {
      return c.json({
        success: false,
        error: 'This session does not have a staff preference record',
      }, 409);
    }
    return c.json({
      success: true,
      data: await loadInquiryPreferences(c.env.DB, actor),
    });
  } catch (err) {
    console.error('PATCH /api/chats/inquiry/preferences error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.get('/api/chats/:id', async (c) => {
  try {
    const data = await loadChatDetail(c.env.DB, c.req.param('id'));
    if (!data) return c.json({ success: false, error: 'Chat not found' }, 404);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

function isAssignedToAnotherStaff(chat: ChatLike, staffId: string): boolean {
  return chat.status === 'in_progress'
    && chat.assigned_staff_id !== null
    && chat.assigned_staff_id !== staffId;
}

chats.post('/api/chats/:id/inquiry/open', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  try {
    const chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    await claimChatForStaff(c.env.DB, chat.id, actor.id);
    const data = await loadChatDetail(c.env.DB, chat.friend_id);
    if (!data) return c.json({ success: false, error: 'Chat not found' }, 404);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('POST /api/chats/:id/inquiry/open error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

chats.post('/api/chats/:id/complete', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  try {
    let chat = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    if (isAssignedToAnotherStaff(chat, actor.id)) {
      return c.json({ success: false, error: 'Another staff member is handling this inquiry' }, 409);
    }
    if (chat.status === 'unread') {
      chat = (await claimChatForStaff(c.env.DB, chat.id, actor.id)) as ChatLike;
    } else if (chat.status === 'in_progress' && chat.assigned_staff_id === null) {
      await updateChat(c.env.DB, chat.id, {
        assignedStaffId: actor.id,
        readAt: jstNow(),
      });
    }
    await completeChat(c.env.DB, chat.id);
    const data = await loadChatDetail(c.env.DB, chat.friend_id);
    if (!data) return c.json({ success: false, error: 'Chat not found' }, 404);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('POST /api/chats/:id/complete error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

function draftReviewFailure(error: unknown): {
  message: string;
  status: 400 | 403 | 404 | 409 | 500 | 502;
} {
  if (error instanceof FaqDraftReviewError) {
    return { message: error.message, status: error.status };
  }
  console.error('AI FAQ draft review error:', error instanceof Error ? error.name : 'unknown');
  return { message: 'Internal server error', status: 500 };
}

async function resolveDraftReviewFriendId(db: D1Database, id: string): Promise<string | null> {
  const chat = await getChatById(db, id);
  if (chat) return chat.friend_id;
  const friend = await getFriendById(db, id);
  return friend?.id ?? null;
}

// 同じ review service を編集・破棄・承認の唯一経路として使う。friend id を path に含め、
// draft id だけを知る別チャットからの cross-friend 操作を拒否する。
chats.patch('/api/chats/:id/drafts/:draftId', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  let body: { draftAnswer?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  if (typeof body.draftAnswer !== 'string') {
    return c.json({ success: false, error: 'draftAnswer is required' }, 400);
  }
  try {
    const friendId = await resolveDraftReviewFriendId(c.env.DB, c.req.param('id'));
    if (!friendId) return c.json({ success: false, error: 'Chat not found' }, 404);
    const data = await editAiFaqDraft({
      db: c.env.DB,
      draftId: c.req.param('draftId'),
      friendId,
      actorStaffId: actor.id,
      draftAnswer: body.draftAnswer,
    });
    return c.json({ success: true, data });
  } catch (error) {
    const failure = draftReviewFailure(error);
    return c.json({ success: false, error: failure.message }, failure.status);
  }
});

chats.delete('/api/chats/:id/drafts/:draftId', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  try {
    const friendId = await resolveDraftReviewFriendId(c.env.DB, c.req.param('id'));
    if (!friendId) return c.json({ success: false, error: 'Chat not found' }, 404);
    const data = await discardAiFaqDraft({
      db: c.env.DB,
      draftId: c.req.param('draftId'),
      friendId,
      actorStaffId: actor.id,
    });
    return c.json({ success: true, data });
  } catch (error) {
    const failure = draftReviewFailure(error);
    return c.json({ success: false, error: failure.message }, failure.status);
  }
});

chats.post('/api/chats/:id/drafts/:draftId/approve', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  let addToFaq = false;
  const rawBody = await c.req.text();
  if (rawBody) {
    try {
      const body = JSON.parse(rawBody) as { addToFaq?: unknown };
      if (body.addToFaq !== undefined && typeof body.addToFaq !== 'boolean') {
        return c.json({ success: false, error: 'addToFaq must be a boolean' }, 400);
      }
      addToFaq = body.addToFaq === true;
    } catch {
      return c.json({ success: false, error: 'JSON body required' }, 400);
    }
  }
  try {
    const friendId = await resolveDraftReviewFriendId(c.env.DB, c.req.param('id'));
    if (!friendId) return c.json({ success: false, error: 'Chat not found' }, 404);
    const data = await approveAiFaqDraft({
      db: c.env.DB,
      draftId: c.req.param('draftId'),
      friendId,
      actorStaffId: actor.id,
      addToFaq,
    });
    return c.json({ success: true, data });
  } catch (error) {
    const failure = draftReviewFailure(error);
    return c.json({ success: false, error: failure.message }, failure.status);
  }
});

chats.post('/api/chats', async (c) => {
  try {
    const body = await c.req.json<{ friendId: string; operatorId?: string; lineAccountId?: string | null }>();
    if (!body.friendId) return c.json({ success: false, error: 'friendId is required' }, 400);
    const item = await createChat(c.env.DB, body);
    // Save line_account_id if provided
    if (body.lineAccountId) {
      await c.env.DB.prepare(`UPDATE chats SET line_account_id = ? WHERE id = ?`)
        .bind(body.lineAccountId, item.id).run();
    }
    return c.json({ success: true, data: { id: item.id, friendId: item.friend_id, status: item.status } }, 201);
  } catch (err) {
    console.error('POST /api/chats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// チャットのアサイン/ステータス更新/ノート更新
chats.put('/api/chats/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const resolved = await resolveOrCreateChat(c.env.DB, id);
    if (!resolved) return c.json({ success: false, error: 'Not found' }, 404);
    const body = await c.req.json<{ operatorId?: string | null; status?: string; notes?: string }>();
    await updateChat(c.env.DB, resolved.id, body);
    const updated = await getChatById(c.env.DB, resolved.id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      // 公開 ID は friend_id に統一
      data: { id: updated.friend_id, friendId: updated.friend_id, operatorId: updated.operator_id, status: updated.status, notes: updated.notes },
    });
  } catch (err) {
    console.error('PUT /api/chats/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// オペレーター入力中のローディング表示を開始
chats.post('/api/chats/:id/loading', async (c) => {
  try {
    const chatId = c.req.param('id');
    const chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);

    let loadingSecondsInput: number | undefined;
    try {
      const body = await c.req.json<{ loadingSeconds?: number }>();
      loadingSecondsInput = body.loadingSeconds;
    } catch {
      loadingSecondsInput = undefined;
    }
    const loadingSeconds = clampLoadingSeconds(loadingSecondsInput);

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    if (!accessToken) {
      return c.json({ success: false, error: 'LINE account is unavailable' }, 409);
    }

    await startLoadingAnimation(
      accessToken,
      friend.line_user_id,
      loadingSeconds,
    );

    return c.json({ success: true, data: { started: true, loadingSeconds } });
  } catch (err) {
    console.error('POST /api/chats/:id/loading error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return c.json({ success: false, error: message }, 500);
  }
});

// オペレーターからメッセージ送信
chats.post('/api/chats/:id/send', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  try {
    const chatId = c.req.param('id');
    let chat = await resolveOrCreateChat(c.env.DB, chatId);
    if (!chat) return c.json({ success: false, error: 'Chat not found' }, 404);
    if (chat.status === 'unread') {
      chat = (await claimChatForStaff(c.env.DB, chat.id, actor.id)) as ChatLike;
    } else if (chat.status === 'in_progress' && chat.assigned_staff_id === null) {
      await updateChat(c.env.DB, chat.id, {
        assignedStaffId: actor.id,
        readAt: jstNow(),
      });
      chat = (await getChatById(c.env.DB, chat.id)) as ChatLike;
    } else if (chat.status === 'resolved') {
      await updateChat(c.env.DB, chat.id, {
        status: 'in_progress',
        assignedStaffId: actor.id,
        readAt: jstNow(),
      });
      chat = (await getChatById(c.env.DB, chat.id)) as ChatLike;
    }
    if (isAssignedToAnotherStaff(chat, actor.id)) {
      return c.json({ success: false, error: 'Another staff member is handling this inquiry' }, 409);
    }

    const body = await c.req.json<{ messageType?: string; content: string }>();
    if (!body.content) return c.json({ success: false, error: 'content is required' }, 400);

    const { friend, accessToken } = await resolveFriendAndAccessToken(
      c.env.DB,
      chat.friend_id,
      c.env.LINE_CHANNEL_ACCESS_TOKEN,
    );
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    if (!accessToken) {
      return c.json({ success: false, error: 'LINE account is unavailable' }, 409);
    }

    // LINE APIでメッセージ送信
    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken);
    const messageType = body.messageType ?? 'text';
    const defaultReplyName = messageType === 'text' && friend.line_account_id
      ? await loadDefaultReplyName(c.env.DB, friend.line_account_id)
      : '';
    const deliveredContent = messageType === 'text' && defaultReplyName
      ? `担当: ${defaultReplyName}\n${body.content}`
      : body.content;

    if (messageType === 'text') {
      await lineClient.pushTextMessage(friend.line_user_id, deliveredContent);
    } else if (messageType === 'flex') {
      const contents = JSON.parse(deliveredContent);
      await lineClient.pushFlexMessage(friend.line_user_id, extractFlexAltText(contents), contents);
    } else if (messageType === 'image') {
      const parsed = JSON.parse(deliveredContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      await lineClient.pushImageMessage(
        friend.line_user_id,
        parsed.originalContentUrl,
        parsed.previewImageUrl,
      );
    }

    // メッセージログに記録
    const logId = crypto.randomUUID();
    const sentAt = jstNow();
    await c.env.DB
      .prepare(
        `INSERT INTO messages_log
          (id, friend_id, direction, message_type, content, delivery_type,
           source, line_account_id, staff_member_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, 'push', 'manual', ?, ?, ?)`,
      )
      .bind(
        logId,
        friend.id,
        messageType,
        deliveredContent,
        friend.line_account_id,
        actor.id,
        sentAt,
      )
      .run();

    // チャットの最終メッセージ日時を更新（chat.id を直接使う — friend_id で呼ばれても resolveOrCreateChat 済み）
    await updateChat(c.env.DB, chat.id, {
      status: 'in_progress',
      assignedStaffId: actor.id,
      readAt: sentAt,
      lastMessageAt: sentAt,
    });

    return c.json({
      success: true,
      data: {
        sent: true,
        messageId: logId,
        message: {
          id: logId,
          direction: 'outgoing',
          messageType,
          content: deliveredContent,
          staffMemberId: actor.id,
          staffMemberName: actor.name,
          createdAt: sentAt,
        },
      },
    });
  } catch (err) {
    console.error('POST /api/chats/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { chats };
