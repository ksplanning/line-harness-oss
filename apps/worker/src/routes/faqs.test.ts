import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
// Phase B B-2: 各書込ルートが search_text を worker 層 helper で計算し createFaq/updateFaq に渡す
// (grep 3 段 = 全 5 呼出元が searchText を渡すことを機械 assert / T-B5-a)。
import { buildFaqSearchText } from '../services/faq-fts.js';

const dbMocks = {
  createFaq: vi.fn(),
  deleteFaq: vi.fn(),
  getFaqById: vi.fn(),
  getFaqs: vi.fn(),
  listFriendFieldDefinitions: vi.fn(),
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
  search_text: 'IDXMARKER_ONLY', // Phase B B-2: 内部索引列 (API 非露出であるべき / D-3・他フィールドに無い marker)
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

  test('D-3: search_text (内部索引列) は serializeFaq allowlist 外 = API に露出しない', async () => {
    dbMocks.getFaqs.mockResolvedValue([faqRow]); // faqRow は search_text='IDXMARKER_ONLY' を持つ
    const res = await setupApp().request('/api/faqs?accountId=acc-1');
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(res.status).toBe(200);
    expect(body.data[0]).not.toHaveProperty('searchText');
    expect(body.data[0]).not.toHaveProperty('search_text');
    expect(JSON.stringify(body.data[0])).not.toContain('IDXMARKER'); // 値も漏れない
  });

  test('GET /api/faqs/personal-context-fields はFAQ権限向けに有効な項目名だけ返す', async () => {
    dbMocks.listFriendFieldDefinitions.mockResolvedValue([{
      id: 'field-payment',
      name: '入金状態',
      defaultValue: '非公開の既定値',
      displayOrder: 1,
      isActive: true,
      createdAt: '2026-07-21T00:00:00+09:00',
      updatedAt: '2026-07-21T00:00:00+09:00',
    }]);

    const res = await setupApp().request('/api/faqs/personal-context-fields');
    const body = await res.json() as { data: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(dbMocks.listFriendFieldDefinitions).toHaveBeenCalledWith(expect.anything(), {
      activeOnly: true,
    });
    expect(body.data).toEqual([{ id: 'field-payment', name: '入金状態' }]);
    expect(JSON.stringify(body.data)).not.toContain('非公開の既定値');
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
      searchText: buildFaqSearchText('営業時間は？', ['開店時間']), // B-2: worker 計算値を渡す
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
      // B-2: question 変更 → 既存 variants(['開店時間']) と最終 question で search_text 再計算。
      searchText: buildFaqSearchText('営業日', ['開店時間']),
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
      searchText: buildFaqSearchText('駐車場ありますか', ['駐車場']), // B-2
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
    expect(String((db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain('ON CONFLICT');
    expect(stmt.bind.mock.calls[1][1]).toBe('acc-1');
    expect(JSON.parse(stmt.bind.mock.calls[1][2] as string)).toMatchObject({ enabled: true, threshold: 0.7, maxRepliesPerDay: 3 });
  });
});

// ── POST /api/faqs/bulk (A+ 一括登録) ────────────────────────────────────────
describe('POST /api/faqs/bulk', () => {
  function bulkReq(body: unknown) {
    return setupApp().request('/api/faqs/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('D-9 scope: all items are written under the request lineAccountId only', async () => {
    dbMocks.getFaqs.mockResolvedValue([]); // 既存なし
    dbMocks.createFaq.mockImplementation(async (_db: unknown, input: { question: string }) => ({
      ...faqRow,
      id: `new-${input.question}`,
      question: input.question,
    }));

    const res = await bulkReq({
      lineAccountId: 'acc-1',
      items: [
        { question: 'Q1', answer: 'A1' },
        { question: 'Q2', answer: 'A2' },
      ],
    });
    const body = (await res.json()) as { success: boolean; data: { created: number; results: Array<{ status: string }> } };

    expect(res.status).toBe(200);
    expect(body.data.created).toBe(2);
    // 全 createFaq が lineAccountId='acc-1' + search_text 計算値付きで呼ばれる (B-2 T-B5-a)。
    for (const call of dbMocks.createFaq.mock.calls) {
      const input = call[1] as { lineAccountId: string; question: string; searchText: string };
      expect(input).toMatchObject({ lineAccountId: 'acc-1' });
      expect(input.searchText).toBe(buildFaqSearchText(input.question, []));
    }
    // getFaqs も acc-1 スコープで既存を取る
    expect(dbMocks.getFaqs).toHaveBeenCalledWith(expect.anything(), 'acc-1');
  });

  test('D-10 limit: more than 500 items -> 400', async () => {
    const items = Array.from({ length: 501 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }));
    const res = await bulkReq({ lineAccountId: 'acc-1', items });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('500');
  });

  test('body with non-array items -> 400', async () => {
    const res = await bulkReq({ lineAccountId: 'acc-1', items: 'nope' });
    expect(res.status).toBe(400);
  });

  test('D-11 partial failure: one createFaq throws -> that row error, others created, overall 200', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    dbMocks.createFaq
      .mockResolvedValueOnce({ ...faqRow, id: 'ok-0' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ...faqRow, id: 'ok-2' });

    const res = await bulkReq({
      lineAccountId: 'acc-1',
      items: [
        { question: 'Q0', answer: 'A0' },
        { question: 'Q1', answer: 'A1' },
        { question: 'Q2', answer: 'A2' },
      ],
    });
    const body = (await res.json()) as {
      success: boolean;
      data: { created: number; errors: number; results: Array<{ index: number; status: string }> };
    };

    expect(res.status).toBe(200);
    expect(body.data.created).toBe(2);
    expect(body.data.errors).toBe(1);
    expect(body.data.results.find((r) => r.index === 1)?.status).toBe('error');
    expect(body.data.results.filter((r) => r.status === 'created')).toHaveLength(2);
  });

  test('D-12 create-mode duplicate against existing FAQ -> skipped (not created)', async () => {
    dbMocks.getFaqs.mockResolvedValue([{ ...faqRow, id: 'exist-1', question: '営業時間は？' }]);

    const res = await bulkReq({
      lineAccountId: 'acc-1',
      items: [{ question: '　営業時間は？　', answer: '新答え' }], // 正規化で既存と一致
    });
    const body = (await res.json()) as { success: boolean; data: { created: number; skipped: number; results: Array<{ status: string }> } };

    expect(res.status).toBe(200);
    expect(body.data.skipped).toBe(1);
    expect(body.data.created).toBe(0);
    expect(dbMocks.createFaq).not.toHaveBeenCalled();
  });

  test('D-12 overwrite mode -> updateFaq called with the existing id (same scope)', async () => {
    dbMocks.getFaqs.mockResolvedValue([{ ...faqRow, id: 'exist-1', line_account_id: 'acc-1', question: '営業時間は？' }]);
    dbMocks.getFaqById.mockResolvedValue({ ...faqRow, id: 'exist-1', line_account_id: 'acc-1' });
    dbMocks.updateFaq.mockResolvedValue({ ...faqRow, id: 'exist-1' });

    const res = await bulkReq({
      lineAccountId: 'acc-1',
      items: [{ question: '営業時間は？', answer: '新しい答え', mode: 'overwrite', overwriteId: 'exist-1' }],
    });
    const body = (await res.json()) as { success: boolean; data: { updated: number } };

    expect(res.status).toBe(200);
    expect(body.data.updated).toBe(1);
    // B-2: overwrite は target.question(='営業時間は？') + item.variants([]) で search_text 再計算。
    expect(dbMocks.updateFaq).toHaveBeenCalledWith(expect.anything(), 'exist-1', expect.objectContaining({
      answer: '新しい答え',
      searchText: buildFaqSearchText('営業時間は？', []),
    }));
  });

  test('D-18 overwriteId scope mismatch (different account) -> row error, updateFaq NOT called', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    // 対象 FAQ は別 account (acc-OTHER) に属する
    dbMocks.getFaqById.mockResolvedValue({ ...faqRow, id: 'other-1', line_account_id: 'acc-OTHER' });

    const res = await bulkReq({
      lineAccountId: 'acc-1',
      items: [{ question: 'Q', answer: 'A', mode: 'overwrite', overwriteId: 'other-1' }],
    });
    const body = (await res.json()) as { success: boolean; data: { errors: number; results: Array<{ status: string; error?: string }> } };

    expect(res.status).toBe(200);
    expect(body.data.errors).toBe(1);
    expect(body.data.results[0].status).toBe('error');
    expect(dbMocks.updateFaq).not.toHaveBeenCalled();
  });

  test('empty question/answer item -> row error', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    const res = await bulkReq({
      lineAccountId: 'acc-1',
      items: [{ question: '  ', answer: 'A' }],
    });
    const body = (await res.json()) as { success: boolean; data: { errors: number; results: Array<{ status: string }> } };
    expect(res.status).toBe(200);
    expect(body.data.errors).toBe(1);
    expect(body.data.results[0].status).toBe('error');
    expect(dbMocks.createFaq).not.toHaveBeenCalled();
  });

  test('D-9 null lineAccountId (全アカ共通) scopes existing dedup to null and writes null', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    dbMocks.createFaq.mockResolvedValue({ ...faqRow, line_account_id: null });

    const res = await bulkReq({
      lineAccountId: null,
      items: [{ question: 'Q', answer: 'A' }],
    });
    expect(res.status).toBe(200);
    expect(dbMocks.getFaqs).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(dbMocks.createFaq.mock.calls[0][1]).toMatchObject({ lineAccountId: null });
  });

  // reviewer R1-H1 (情報漏洩): 空文字/空白 lineAccountId が ?? null を通過し
  // getFaqs(db,'') の if(lineAccountId) falsy → 全アカ FAQ SELECT → 他アカ question が
  // dedup 索引に漏れる。空文字/空白/非文字列は 400 で拒否 (null は全アカ共通で許可)。
  test('R1-H1 empty-string lineAccountId -> 400 (no all-account SELECT leak)', async () => {
    const res = await bulkReq({ lineAccountId: '', items: [{ question: 'Q', answer: 'A' }] });
    expect(res.status).toBe(400);
    // getFaqs は呼ばれない (全アカ SELECT へ落ちない)。
    expect(dbMocks.getFaqs).not.toHaveBeenCalled();
  });

  test('R1-H1 whitespace-only lineAccountId -> 400', async () => {
    const res = await bulkReq({ lineAccountId: '   ', items: [{ question: 'Q', answer: 'A' }] });
    expect(res.status).toBe(400);
    expect(dbMocks.getFaqs).not.toHaveBeenCalled();
  });

  test('R1-H1 non-string lineAccountId -> 400', async () => {
    const res = await bulkReq({ lineAccountId: 123 as unknown as string, items: [{ question: 'Q', answer: 'A' }] });
    expect(res.status).toBe(400);
    expect(dbMocks.getFaqs).not.toHaveBeenCalled();
  });

  test('R1-H1 missing lineAccountId (undefined) -> 400 (must be explicit account or null)', async () => {
    const res = await bulkReq({ items: [{ question: 'Q', answer: 'A' }] });
    expect(res.status).toBe(400);
    expect(dbMocks.getFaqs).not.toHaveBeenCalled();
  });

  test('R1-H1 null lineAccountId is still accepted (全アカ共通)', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    dbMocks.createFaq.mockResolvedValue({ ...faqRow, line_account_id: null });
    const res = await bulkReq({ lineAccountId: null, items: [{ question: 'Q', answer: 'A' }] });
    expect(res.status).toBe(200);
  });

  // reviewer R1-H2 (DoS): variants に件数/長さ上限なし。件数上限 + 要素長上限を server で enforce。
  test('R1-H2 too many variants -> row error (count cap)', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    const manyVariants = Array.from({ length: 11 }, (_, i) => `v${i}`); // 上限 10 超
    const res = await bulkReq({ lineAccountId: 'acc-1', items: [{ question: 'Q', answer: 'A', variants: manyVariants }] });
    const body = (await res.json()) as { data: { errors: number; results: Array<{ status: string; error?: string }> } };
    expect(res.status).toBe(200);
    expect(body.data.errors).toBe(1);
    expect(body.data.results[0].status).toBe('error');
    expect(dbMocks.createFaq).not.toHaveBeenCalled();
  });

  test('R1-H2 variant element too long -> row error (length cap)', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    const res = await bulkReq({ lineAccountId: 'acc-1', items: [{ question: 'Q', answer: 'A', variants: ['あ'.repeat(201)] }] });
    const body = (await res.json()) as { data: { errors: number; results: Array<{ status: string }> } };
    expect(res.status).toBe(200);
    expect(body.data.errors).toBe(1);
    expect(body.data.results[0].status).toBe('error');
    expect(dbMocks.createFaq).not.toHaveBeenCalled();
  });

  test('R1-H2 within-limit variants are accepted', async () => {
    dbMocks.getFaqs.mockResolvedValue([]);
    dbMocks.createFaq.mockResolvedValue(faqRow);
    const res = await bulkReq({ lineAccountId: 'acc-1', items: [{ question: 'Q', answer: 'A', variants: ['何時から', '開店時間'] }] });
    const body = (await res.json()) as { data: { created: number } };
    expect(res.status).toBe(200);
    expect(body.data.created).toBe(1);
    expect(dbMocks.createFaq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ variants: ['何時から', '開店時間'] }));
  });
});

// D-19: UI (normalizeQuestion) と Worker (bulkNormalizeQuestion) の正規化パリティ。
// 同じフィクスチャで同一キーを返すことを両側テストで固定する。
describe('bulk normalize parity with UI normalizeQuestion', () => {
  test('server normalize matches UI normalize on shared fixtures', async () => {
    const { bulkNormalizeQuestion } = await import('./faqs.js');
    // UI 側 (apps/web) の実装をここに複製せず、同じ入力→同じ正規形になることを検証。
    // 期待値は normalize.ts の仕様 (全半角統一+大小無視+空白畳み) と一致。
    const cases: Array<[string, string]> = [
      ['  営業時間は？  ', '営業時間は？'],
      ['ＯＰＥＮ１２３', 'open123'],
      ['Open  Hours', 'open hours'],
      ['営業　時間', '営業 時間'],
    ];
    for (const [input, expected] of cases) {
      expect(bulkNormalizeQuestion(input)).toBe(bulkNormalizeQuestion(expected));
    }
    // 具体的な正規形も固定 (UI normalize.ts と同一アルゴリズム)。
    expect(bulkNormalizeQuestion('ＯＰＥＮ　Hours ')).toBe('open hours');
  });
});
