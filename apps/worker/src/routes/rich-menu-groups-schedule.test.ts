/**
 * T-C7 / A6 (F2 batch4 G17) — schedule PATCH route の account guard + 日時検証。
 *  - accountId 必須 (400) / 別 account の group は 403 (cross-account 非漏洩)
 *  - 開始 >= 終了は 400 / 不正日時は 400 / null で解除
 */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getRichMenuGroups: vi.fn(),
  getRichMenuGroupById: vi.fn(),
  getRichMenuGroupWithPages: vi.fn(),
  createRichMenuGroup: vi.fn(),
  updateRichMenuGroupMeta: vi.fn(),
  updateRichMenuGroupSchedule: vi.fn(),
  replaceRichMenuPages: vi.fn(),
  deleteRichMenuGroup: vi.fn(),
  setRichMenuPageImage: vi.fn(),
  pageBelongsToGroup: vi.fn(),
  acquirePublishLock: vi.fn(),
  releasePublishLock: vi.fn(),
  setPageRichMenuId: vi.fn(),
  markRichMenuGroupPublished: vi.fn(),
  markRichMenuGroupUnpublished: vi.fn(),
  getLineAccountById: vi.fn(),
  getFollowingLineUserIdsByTag: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { richMenuGroups } = await import('./rich-menu-groups.js');

type TestEnv = { Bindings: { DB: D1Database; IMAGES: unknown } };

function app() {
  const a = new Hono<TestEnv>();
  a.use('*', async (c, next) => { c.env = { DB: {} as D1Database, IMAGES: {} } as never; await next(); });
  a.route('/', richMenuGroups);
  return a;
}

const GROUP = { id: 'g1', account_id: 'acc-1', name: '春', chat_bar_text: 'm', size: 'large', status: 'draft', schedule_start: null, schedule_end: null, default_page_id: null, is_default_for_all: 0, publishing_at: null, created_at: 'x', updated_at: 'x' };

describe('PATCH /schedule account guard + validation', () => {
  test('missing accountId → 400', async () => {
    const res = await app().request('/api/rich-menu-groups/g1/schedule', { method: 'PATCH', body: '{}' });
    expect(res.status).toBe(400);
  });

  test('foreign account → 403 (cross-account non-leak)', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValueOnce(GROUP);
    const res = await app().request('/api/rich-menu-groups/g1/schedule?accountId=acc-2', { method: 'PATCH', body: JSON.stringify({ scheduleStart: '2026-07-10T00:00:00+09:00' }) });
    expect(res.status).toBe(403);
  });

  test('start >= end → 400', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValueOnce(GROUP);
    const res = await app().request('/api/rich-menu-groups/g1/schedule?accountId=acc-1', { method: 'PATCH', body: JSON.stringify({ scheduleStart: '2026-07-20T00:00:00+09:00', scheduleEnd: '2026-07-10T00:00:00+09:00' }) });
    expect(res.status).toBe(400);
  });

  test('invalid datetime → 400', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValueOnce(GROUP);
    const res = await app().request('/api/rich-menu-groups/g1/schedule?accountId=acc-1', { method: 'PATCH', body: JSON.stringify({ scheduleStart: 'not-a-date' }) });
    expect(res.status).toBe(400);
  });

  test('valid window → updates schedule (account-scoped)', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValueOnce(GROUP);
    dbMocks.getRichMenuGroupWithPages.mockResolvedValueOnce({ ...GROUP, schedule_start: '2026-07-10T00:00:00+09:00', schedule_end: '2026-07-20T00:00:00+09:00', pages: [] });
    const res = await app().request('/api/rich-menu-groups/g1/schedule?accountId=acc-1', { method: 'PATCH', body: JSON.stringify({ scheduleStart: '2026-07-10T00:00:00+09:00', scheduleEnd: '2026-07-20T00:00:00+09:00' }) });
    expect(res.status).toBe(200);
    expect(dbMocks.updateRichMenuGroupSchedule).toHaveBeenCalledWith(expect.anything(), 'g1', 'acc-1', { scheduleStart: '2026-07-10T00:00:00+09:00', scheduleEnd: '2026-07-20T00:00:00+09:00' });
  });

  test('null clears schedule', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValueOnce({ ...GROUP, schedule_start: '2026-07-10T00:00:00+09:00', schedule_end: '2026-07-20T00:00:00+09:00' });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValueOnce({ ...GROUP, pages: [] });
    const res = await app().request('/api/rich-menu-groups/g1/schedule?accountId=acc-1', { method: 'PATCH', body: JSON.stringify({ scheduleStart: null, scheduleEnd: null }) });
    expect(res.status).toBe(200);
    expect(dbMocks.updateRichMenuGroupSchedule).toHaveBeenCalledWith(expect.anything(), 'g1', 'acc-1', { scheduleStart: null, scheduleEnd: null });
  });
});
