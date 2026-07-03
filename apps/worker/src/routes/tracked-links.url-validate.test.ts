/**
 * tracked-links PATCH originalUrl server 検証 (batch2 C7 / BACKLOG-tracked-link-url-edit)。
 *
 * PATCH /api/tracked-links/:id が originalUrl を受理し、保存前に server URL 検証 (http/https + parse) を
 * 通し、不正 URL は 400、正常なら db updateTrackedLink に originalUrl を渡すことを assert。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getTrackedLinks: vi.fn(),
  getTrackedLinkById: vi.fn(),
  createTrackedLink: vi.fn(),
  updateTrackedLink: vi.fn(),
  deleteTrackedLink: vi.fn(),
  recordLinkClick: vi.fn(),
  getLinkClicks: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { trackedLinks } = await import('./tracked-links.js');

type TestEnv = { Bindings: { DB: D1Database } };

function setupApp() {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database };
    await next();
  });
  app.route('/', trackedLinks);
  return app;
}

function existingLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lk1', name: 'リンク', original_url: 'https://old.example.com', tag_id: null,
    scenario_id: null, intro_template_id: null, reward_template_id: null,
    is_active: 1, click_count: 0, created_at: '2026-07-03T00:00:00.000', updated_at: '2026-07-03T00:00:00.000',
    ...overrides,
  };
}

async function patch(id: string, body: Record<string, unknown>) {
  const app = setupApp();
  return app.request(`/api/tracked-links/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('PATCH /api/tracked-links/:id originalUrl 検証 (T-U1)', () => {
  test('正常 URL を受理し db updateTrackedLink に originalUrl を渡す', async () => {
    dbMocks.updateTrackedLink.mockResolvedValue(existingLink({ original_url: 'https://new.example.com/x' }));
    const res = await patch('lk1', { name: '改名', originalUrl: 'https://new.example.com/x' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateTrackedLink).toHaveBeenCalledWith(
      expect.anything(),
      'lk1',
      expect.objectContaining({ originalUrl: 'https://new.example.com/x' }),
    );
    const b = (await res.json()) as { data: { originalUrl: string } };
    expect(b.data.originalUrl).toBe('https://new.example.com/x');
  });

  test('http URL も受理 (http/https 両方許可)', async () => {
    dbMocks.updateTrackedLink.mockResolvedValue(existingLink({ original_url: 'http://ex.com' }));
    const res = await patch('lk1', { originalUrl: 'http://ex.com' });
    expect(res.status).toBe(200);
  });

  test('parse 不能な URL は 400 (db を呼ばない)', async () => {
    const res = await patch('lk1', { originalUrl: 'not a url' });
    expect(res.status).toBe(400);
    expect(dbMocks.updateTrackedLink).not.toHaveBeenCalled();
  });

  test('http/https 以外のスキーム (javascript:) は 400', async () => {
    const res = await patch('lk1', { originalUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(dbMocks.updateTrackedLink).not.toHaveBeenCalled();
  });

  test('originalUrl 未指定なら検証せず従来通り更新 (name だけ)', async () => {
    dbMocks.updateTrackedLink.mockResolvedValue(existingLink({ name: '改名' }));
    const res = await patch('lk1', { name: '改名' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateTrackedLink).toHaveBeenCalledWith(
      expect.anything(), 'lk1', expect.objectContaining({ name: '改名' }),
    );
  });

  test('存在しない link は 404', async () => {
    dbMocks.updateTrackedLink.mockResolvedValue(null);
    const res = await patch('missing', { name: 'x' });
    expect(res.status).toBe(404);
  });
});
