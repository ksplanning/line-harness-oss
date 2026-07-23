import { Hono } from 'hono';
import type { Env } from '../index.js';
import { getAllUnansweredRows } from '../services/unanswered-inbox.js';

const conversations = new Hono<Env>();

// GET /api/conversations?lineAccountId=&minHoursSince=&maxHoursSince=&limit=&offset=
conversations.get('/api/conversations', async (c) => {
  try {
    const url = new URL(c.req.url);
    const accountId = url.searchParams.get('lineAccountId') ?? undefined;
    const minHoursSince = Number(url.searchParams.get('minHoursSince') ?? '0');
    const maxHoursSinceParam = url.searchParams.get('maxHoursSince');
    const maxHoursSince = maxHoursSinceParam !== null ? Number(maxHoursSinceParam) : null;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const offset = Number(url.searchParams.get('offset') ?? '0');

    const now = Date.now();
    const filteredRows = (await getAllUnansweredRows(c.env.DB))
      .filter((row) => !accountId || row.accountId === accountId)
      .map((row) => ({
        row,
        hoursSince: (now - new Date(row.lastIncomingAt).getTime()) / 3_600_000,
      }))
      .filter(({ hoursSince }) => (
        hoursSince >= minHoursSince
        && (maxHoursSince === null || hoursSince <= maxHoursSince)
      ))
      .sort((a, b) => a.row.lastIncomingAt.localeCompare(b.row.lastIncomingAt));

    const total = filteredRows.length;
    const pageRows = filteredRows.slice(offset, offset + limit);
    const friendIds = pageRows.map(({ row }) => row.friendId);

    const friendMetadata = new Map<string, {
      line_user_id: string;
      line_account_name: string | null;
    }>();
    const tagMap: Record<string, string[]> = {};
    if (friendIds.length > 0) {
      const placeholders = friendIds.map(() => '?').join(',');
      const friendRows = await c.env.DB.prepare(
        `SELECT f.id AS friend_id, f.line_user_id, la.name AS line_account_name
         FROM friends f
         LEFT JOIN line_accounts la ON la.id = f.line_account_id
         WHERE f.id IN (${placeholders})`,
      )
        .bind(...friendIds)
        .all<{
          friend_id: string;
          line_user_id: string;
          line_account_name: string | null;
        }>();
      for (const row of friendRows.results) {
        friendMetadata.set(row.friend_id, row);
      }

      const tagRows = await c.env.DB.prepare(
        `SELECT ft.friend_id, t.name FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.friend_id IN (${placeholders})`,
      )
        .bind(...friendIds)
        .all<{ friend_id: string; name: string }>();
      for (const row of tagRows.results) {
        (tagMap[row.friend_id] ??= []).push(row.name);
      }
    }

    const items = pageRows.map(({ row, hoursSince }) => {
      const metadata = friendMetadata.get(row.friendId);
      return {
        friendId: row.friendId,
        lineUserId: metadata?.line_user_id ?? '',
        displayName: row.displayName,
        lineAccountId: row.accountId,
        lineAccountName: metadata?.line_account_name ?? null,
        lastIncomingAt: row.lastIncomingAt,
        hoursSince: Math.round(hoursSince * 10) / 10,
        lastIncomingPreview: Array.from(row.lastIncomingContent).slice(0, 80).join(''),
        lastIncomingType: row.lastIncomingType,
        tags: tagMap[row.friendId] ?? [],
      };
    });

    return c.json({ success: true, data: { total, items } });
  } catch (err) {
    console.error('GET /api/conversations error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

// GET /api/conversations/:friendId?limit=&before=
conversations.get('/api/conversations/:friendId', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const url = new URL(c.req.url);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const before = url.searchParams.get('before');

    const friend = await c.env.DB.prepare(
      `SELECT f.id, f.line_user_id, f.display_name, f.is_following, f.line_account_id, la.name AS line_account_name
       FROM friends f LEFT JOIN line_accounts la ON la.id = f.line_account_id WHERE f.id = ?`,
    )
      .bind(friendId)
      .first<{
        id: string;
        line_user_id: string;
        display_name: string | null;
        is_following: number;
        line_account_id: string | null;
        line_account_name: string | null;
      }>();

    if (!friend) {
      return c.json({ success: false, error: 'friend not found' }, 404);
    }

    const tagRows = await c.env.DB.prepare(
      `SELECT t.name FROM friend_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.friend_id = ?`,
    )
      .bind(friendId)
      .all<{ name: string }>();
    const tags = tagRows.results.map((r) => r.name);

    // Normalize the `before` cursor via julianday() so sub-second precision
    // is preserved and cursors in any ISO 8601 timezone form (Z, +09:00) sort
    // correctly against stored `+09:00` timestamps. strftime('%s', ...) would
    // truncate to whole seconds and drop messages that share a second.
    const msgSql = before
      ? `SELECT id, direction, message_type, content, delivery_type, source, broadcast_id, scenario_step_id, created_at
         FROM messages_log WHERE friend_id = ? AND julianday(created_at) < julianday(?)
         ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, direction, message_type, content, delivery_type, source, broadcast_id, scenario_step_id, created_at
         FROM messages_log WHERE friend_id = ?
         ORDER BY created_at DESC LIMIT ?`;
    const bindings: (string | number)[] = before ? [friendId, before, limit] : [friendId, limit];
    const msgResult = await c.env.DB.prepare(msgSql)
      .bind(...bindings)
      .all<{
        id: string;
        direction: 'incoming' | 'outgoing';
        message_type: string;
        content: string;
        delivery_type: string | null;
        source: string | null;
        broadcast_id: string | null;
        scenario_step_id: string | null;
        created_at: string;
      }>();

    const messages = msgResult.results.reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      messageType: m.message_type,
      content: m.content,
      deliveryType: m.delivery_type,
      // Infer source from associated foreign keys / delivery_type when missing.
      // Historically some writers (incl. orphan deploys before migration 028)
      // left source NULL on scenario/broadcast/auto_reply outgoings. Mirrors
      // the backfill rules in migrations/028_messages_log_source.sql so the
      // dashboard does not misclassify automated messages as operator replies.
      source: m.source ?? (
        m.direction === 'incoming' ? 'user'
          : m.scenario_step_id ? 'scenario'
          : (m.broadcast_id || m.delivery_type === 'test') ? 'broadcast'
          : m.delivery_type === 'reply' ? 'auto_reply'
          : 'manual'
      ),
      createdAt: m.created_at,
    }));

    return c.json({
      success: true,
      data: {
        friend: {
          friendId: friend.id,
          lineUserId: friend.line_user_id,
          displayName: friend.display_name,
          lineAccountId: friend.line_account_id,
          lineAccountName: friend.line_account_name,
          isFollowing: friend.is_following === 1,
          tags,
        },
        messages,
      },
    });
  } catch (err) {
    console.error('GET /api/conversations/:friendId error:', err);
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export { conversations };
