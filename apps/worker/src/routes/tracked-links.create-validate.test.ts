/**
 * tracked-links POST create の originalUrl server 検証 (batch2 C5 / NEW-BACKLOG-create)。
 *
 * POST /api/tracked-links が保存前に server URL 検証 (http/https + parse) を通し、
 * 不正 URL は 400 で createTrackedLink を呼ばず、正常なら 201 で作成する。
 * PATCH 側 (6562e11) と同一水準・同一関数 isValidOriginalUrl を流用。
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
  app.use('*', async (c, next) => { c.env = { DB: {} as D1Database }; await next(); });
  app.route('/', trackedLinks);
  return app;
}

function createdLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lk1', name: 'リンク', original_url: 'https://example.com', tag_id: null,
    scenario_id: null, intro_template_id: null, reward_template_id: null,
    is_active: 1, click_count: 0, created_at: '2026-07-03T00:00:00.000', updated_at: '2026-07-03T00:00:00.000',
    ...overrides,
  };
}

async function post(body: Record<string, unknown>) {
  return setupApp().request('/api/tracked-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('POST /api/tracked-links originalUrl 検証 (T-C5)', () => {
  test('正常 https URL は 201 で createTrackedLink を呼ぶ', async () => {
    dbMocks.createTrackedLink.mockResolvedValue(createdLink({ original_url: 'https://new.example.com/x' }));
    const res = await post({ name: 'x', originalUrl: 'https://new.example.com/x' });
    expect(res.status).toBe(201);
    expect(dbMocks.createTrackedLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ originalUrl: 'https://new.example.com/x' }),
    );
  });

  test('http URL も受理 (http/https 両方許可)', async () => {
    dbMocks.createTrackedLink.mockResolvedValue(createdLink({ original_url: 'http://ex.com' }));
    const res = await post({ name: 'x', originalUrl: 'http://ex.com' });
    expect(res.status).toBe(201);
  });

  test('javascript: スキームは 400 (createTrackedLink 未呼出)', async () => {
    const res = await post({ name: 'x', originalUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(dbMocks.createTrackedLink).not.toHaveBeenCalled();
  });

  test('parse 不能な URL は 400 (createTrackedLink 未呼出)', async () => {
    const res = await post({ name: 'x', originalUrl: 'not a url' });
    expect(res.status).toBe(400);
    expect(dbMocks.createTrackedLink).not.toHaveBeenCalled();
  });

  test('presence 不足は従来通り 400 (name/originalUrl 必須)', async () => {
    const noUrl = await post({ name: 'x' });
    expect(noUrl.status).toBe(400);
    const noName = await post({ originalUrl: 'https://ex.com' });
    expect(noName.status).toBe(400);
    expect(dbMocks.createTrackedLink).not.toHaveBeenCalled();
  });
});
