import { Hono } from 'hono';
import type { Env } from '../index.js';

const accountSettings = new Hono<Env>();
const CHAT_REPLY_SENDER_NAME_KEY = 'chat_reply_sender_name';

function parseStoredFriendIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  } catch {
    return [];
  }
}

export async function loadDefaultReplyName(
  db: D1Database,
  accountId: string,
): Promise<string> {
  const row = await db.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
  ).bind(accountId, CHAT_REPLY_SENDER_NAME_KEY).first<{ value: string }>();
  return row?.value ?? '';
}

// GET /api/account-settings/chat-reply?accountId=xxx
accountSettings.get('/api/account-settings/chat-reply', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const defaultReplyName = await loadDefaultReplyName(c.env.DB, accountId);
  return c.json({ success: true, data: { defaultReplyName } });
});

// PUT /api/account-settings/chat-reply
accountSettings.put('/api/account-settings/chat-reply', async (c) => {
  let body: { accountId?: unknown; defaultReplyName?: unknown };
  try {
    body = await c.req.json<{
      accountId?: unknown;
      defaultReplyName?: unknown;
    }>();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    return c.json({ success: false, error: 'accountId required' }, 400);
  }
  if (typeof body.defaultReplyName !== 'string') {
    return c.json({ success: false, error: 'defaultReplyName must be a string' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
  ).bind(
    id,
    body.accountId,
    CHAT_REPLY_SENDER_NAME_KEY,
    body.defaultReplyName,
    now,
    now,
    body.defaultReplyName,
    now,
  ).run();

  return c.json({
    success: true,
    data: { defaultReplyName: body.defaultReplyName },
  });
});

// GET /api/account-settings/test-recipients?accountId=xxx
accountSettings.get('/api/account-settings/test-recipients', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
  ).bind(accountId).first<{ value: string }>();

  const friendIds = parseStoredFriendIds(row?.value);

  if (friendIds.length === 0) {
    return c.json({ success: true, data: [] });
  }
  const placeholders = friendIds.map(() => '?').join(',');
  const friends = await c.env.DB.prepare(
    `SELECT id, display_name, picture_url FROM friends
     WHERE line_account_id = ? AND is_following = 1 AND id IN (${placeholders})`
  ).bind(accountId, ...friendIds).all<{ id: string; display_name: string; picture_url: string | null }>();
  const byId = new Map(friends.results.map((friend) => [friend.id, friend]));

  return c.json({
    success: true,
    data: friendIds.flatMap((friendId) => {
      const f = byId.get(friendId);
      return f ? [{
      id: f.id,
      displayName: f.display_name,
      pictureUrl: f.picture_url,
      }] : [];
    }),
  });
});

// PUT /api/account-settings/test-recipients
accountSettings.put('/api/account-settings/test-recipients', async (c) => {
  let body: { accountId?: unknown; friendIds?: unknown };
  try {
    body = await c.req.json<{ accountId?: unknown; friendIds?: unknown }>();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
    return c.json({ success: false, error: 'accountId required' }, 400);
  }
  if (
    !Array.isArray(body.friendIds)
    || body.friendIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(body.friendIds).size !== body.friendIds.length
  ) {
    return c.json({ success: false, error: 'friendIds must be a unique string array' }, 400);
  }

  const friendIds = body.friendIds as string[];
  if (friendIds.length > 0) {
    const placeholders = friendIds.map(() => '?').join(',');
    const matched = await c.env.DB.prepare(
      `SELECT id FROM friends
       WHERE line_account_id = ? AND is_following = 1 AND id IN (${placeholders})`,
    ).bind(body.accountId, ...friendIds).all<{ id: string }>();
    if (matched.results.length !== friendIds.length) {
      return c.json({ success: false, error: 'All test recipients must be following friends of this LINE account' }, 400);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'test_recipients', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`
  ).bind(
    id, body.accountId, JSON.stringify(friendIds), now, now,
    JSON.stringify(friendIds), now,
  ).run();

  return c.json({ success: true });
});

export { accountSettings };
