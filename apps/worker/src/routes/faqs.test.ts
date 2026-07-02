import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  createFaq: vi.fn(),
  deleteFaq: vi.fn(),
  getFaqById: vi.fn(),
  getFaqs: vi.fn(),
  getUnmatchedById: vi.fn(),
  getUnmatchedQuestions: vi.fn(),
  markUnmatchedResolved: vi.fn(),
  updateFaq: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);

const { faqs } = await import('./faqs.js');

function setupApp(db: D1Database = { prepare: vi.fn() } as unknown as D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    await next();
  });
  app.route('/', faqs);
  return app;
}

const faqRow = {
  id: 'faq-1',
  line_account_id: 'acc-1',
  question: '営業時間は？',
  variants: JSON.stringify(['開店時間']),
  answer: '10時からです',
  is_active: 1,
  hit_count: 3,
  created_at: '2026-07-02T00:00:00+09:00',
  updated_at: '2026-07-02T00:00:00+09:00',
};

const unmatchedRow = {
  id: 'unmatched-1',
  line_account_id: 'acc-1',
  friend_id: 'friend-1',
  question: '駐車場ありますか',
  top_score: 0.42,
  resolved_faq_id: null,
  created_at: '2026-07-02T00:00:00+09:00',
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('FAQ routes', () => {
  test('GET /api/faqs forwards accountId and serializes variants/camelCase', async () => {
    dbMocks.getFaqs.mockResolvedValue([faqRow, { ...faqRow, id: 'faq-global', line_account_id: null }]);

    const res = await setupApp().request('/api/faqs?accountId=acc-1');
    const body = (await res.json()) as { success: boolean; data: Array<{ id: string; variants: string[]; lineAccountId: string | null; hitCount: number }> };

    expect(res.status).toBe(200);
    expect(dbMocks.getFaqs).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    expect(body.data.map((r) => r.id)).toEqual(['faq-1', 'faq-global']);
    expect(body.data[0]).toMatchObject({ variants: ['開店時間'], lineAccountId: 'acc-1', hitCount: 3 });
    expect(body.data[1].lineAccountId).toBeNull();
  });

  test('POST /api/faqs validates required fields and creates FAQ', async () => {
    dbMocks.createFaq.mockResolvedValue(faqRow);

    const res = await setupApp().request('/api/faqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: '営業時間は？',
        answer: '10時からです',
        variants: ['開店時間'],
        lineAccountId: 'acc-1',
        isActive: true,
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createFaq).toHaveBeenCalledWith(expect.anything(), {
      question: '営業時間は？',
      answer: '10時からです',
      variants: ['開店時間'],
      lineAccountId: 'acc-1',
      isActive: true,
    });
  });

  test('PUT and DELETE /api/faqs/:id update and delete FAQ', async () => {
    dbMocks.updateFaq.mockResolvedValue({ ...faqRow, is_active: 0 });
    dbMocks.getFaqById.mockResolvedValue(faqRow);
    dbMocks.deleteFaq.mockResolvedValue(undefined);

    const put = await setupApp().request('/api/faqs/faq-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '営業日', isActive: false }),
    });
    expect(put.status).toBe(200);
    expect(dbMocks.updateFaq).toHaveBeenCalledWith(expect.anything(), 'faq-1', {
      question: '営業日',
      isActive: false,
    });

    const del = await setupApp().request('/api/faqs/faq-1', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(dbMocks.deleteFaq).toHaveBeenCalledWith(expect.anything(), 'faq-1');
  });

  test('GET /api/faqs/unmatched serializes unresolved questions', async () => {
    dbMocks.getUnmatchedQuestions.mockResolvedValue([unmatchedRow]);

    const res = await setupApp().request('/api/faqs/unmatched?accountId=acc-1');
    const body = (await res.json()) as { success: boolean; data: Array<{ topScore: number; resolvedFaqId: string | null }> };

    expect(res.status).toBe(200);
    expect(dbMocks.getUnmatchedQuestions).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    expect(body.data[0]).toMatchObject({ topScore: 0.42, resolvedFaqId: null });
  });

  test('POST /api/faqs/from-unmatched/:id creates FAQ and marks question resolved', async () => {
    dbMocks.getUnmatchedById.mockResolvedValue(unmatchedRow);
    dbMocks.createFaq.mockResolvedValue(faqRow);

    const res = await setupApp().request('/api/faqs/from-unmatched/unmatched-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '近くに提携駐車場があります', variants: ['駐車場'], lineAccountId: 'acc-1' }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createFaq).toHaveBeenCalledWith(expect.anything(), {
      question: '駐車場ありますか',
      answer: '近くに提携駐車場があります',
      variants: ['駐車場'],
      lineAccountId: 'acc-1',
      isActive: true,
    });
    expect(dbMocks.markUnmatchedResolved).toHaveBeenCalledWith(expect.anything(), 'unmatched-1', 'faq-1');
  });

  test('POST /api/faqs/from-unmatched/:id honors isActive:false (promotes as disabled FAQ)', async () => {
    // reviewer R1-I1: 未マッチ質問を「無効」で昇格したのに有効 FAQ が作られると
    // flag ON アカウントで意図せぬ自動返信の入口になる (spec F1 違反)。
    dbMocks.getUnmatchedById.mockResolvedValue(unmatchedRow);
    dbMocks.createFaq.mockResolvedValue({ ...faqRow, is_active: 0 });

    const res = await setupApp().request('/api/faqs/from-unmatched/unmatched-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '近くに提携駐車場があります', isActive: false }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createFaq).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isActive: false }),
    );
  });

  test('POST /api/faqs/from-unmatched/:id defaults isActive to true when omitted', async () => {
    dbMocks.getUnmatchedById.mockResolvedValue(unmatchedRow);
    dbMocks.createFaq.mockResolvedValue(faqRow);

    const res = await setupApp().request('/api/faqs/from-unmatched/unmatched-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '近くに提携駐車場があります' }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createFaq).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isActive: true }),
    );
  });
});

describe('FAQ bot account settings routes', () => {
  function settingsDb(firstResult: { value: string } | null = null) {
    const stmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue(firstResult),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
    return { db, stmt };
  }

  test('GET /api/account-settings/faq-bot returns defaults when missing', async () => {
    const { db } = settingsDb(null);

    const res = await setupApp(db).request('/api/account-settings/faq-bot?accountId=acc-1');
    const body = (await res.json()) as { success: boolean; data: { enabled: boolean; threshold: number; maxRepliesPerDay: number } };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ enabled: false, threshold: 0.6, maxRepliesPerDay: 5 });
  });

  test('PUT /api/account-settings/faq-bot upserts settings JSON', async () => {
    const { db, stmt } = settingsDb(null);

    const res = await setupApp(db).request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acc-1',
        enabled: true,
        threshold: 0.7,
        handoffMessage: '担当者に引き継ぎます',
        autoReplyNotice: '自動返信です',
        maxRepliesPerDay: 3,
      }),
    });

    expect(res.status).toBe(200);
    expect(String((db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('ON CONFLICT');
    expect(stmt.bind.mock.calls[0][1]).toBe('acc-1');
    expect(JSON.parse(stmt.bind.mock.calls[0][2] as string)).toMatchObject({ enabled: true, threshold: 0.7, maxRepliesPerDay: 3 });
  });
});
