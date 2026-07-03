import { Hono } from 'hono';
import { getRichMenuGroupById, getRichMenuTapAnalytics } from '@line-crm/db';
import type { Env } from '../index.js';

const richMenuAnalytics = new Hono<Env>();

/** 'YYYY-MM-DD' 形式かを厳密に判定 (JST 日付・不正な期間を弾く)。 */
function isValidDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime());
}

// GET /api/rich-menu-analytics/taps?accountId=&groupId=&startDate=&endDate=
//
// 選択メニューグループの postback系タップ数を期間 (JST 半開区間) で集計する (read-only)。
// account を跨がない: group が指定 account に属することを検証 (403)。
// 送信はしない (messages_log の read-only 集計のみ・LINE API を呼ばない)。
richMenuAnalytics.get('/api/rich-menu-analytics/taps', async (c) => {
  const accountId = c.req.query('accountId');
  const groupId = c.req.query('groupId');
  const startDate = c.req.query('startDate');
  const endDate = c.req.query('endDate');

  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  if (!groupId) return c.json({ success: false, error: 'groupId query param required' }, 400);
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return c.json({ success: false, error: 'startDate and endDate must be YYYY-MM-DD (JST)' }, 400);
  }
  if (endDate < startDate) {
    return c.json({ success: false, error: 'endDate must not be before startDate' }, 400);
  }

  // group の存在 + account 所有を検証 (別 account の group/タップを見せない)。
  const group = await getRichMenuGroupById(c.env.DB, groupId);
  if (!group) return c.json({ success: false, error: 'rich menu group not found' }, 404);
  if (group.account_id !== accountId) {
    return c.json({ success: false, error: 'rich menu group account mismatch' }, 403);
  }

  const analytics = await getRichMenuTapAnalytics(c.env.DB, { groupId, accountId, startDate, endDate });
  return c.json({ success: true, data: analytics });
});

export { richMenuAnalytics };
