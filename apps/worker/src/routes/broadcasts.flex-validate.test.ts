/**
 * broadcasts server 側 Flex 検証 (batch2 C2 / BACKLOG-flex / セキュリティ)。
 *
 * POST/PUT /api/broadcasts の保存直前に validateFlex (@line-crm/shared・client と同一関数) を通し、
 * client を迂回した API 直叩きでの不正 Flex 保存を 400 でブロックすることを assert。
 * D-1: worker が @line-crm/shared の validateFlex を「実行」して解決することも本テストで確認 (import だけでなく実行)。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Mock @line-crm/db so we drive the route purely from this file (rich-menu-groups.test.ts 流儀)。
const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { broadcasts } = await import('./broadcasts.js');

type TestEnv = {
  Variables: { staff: { id: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: { DB: D1Database };
};

function makeDbStub(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      })),
    })),
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
}

function setupApp() {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', role: 'owner' });
    c.env = { DB: makeDbStub() } as never;
    await next();
  });
  app.route('/', broadcasts);
  return app;
}

// bare bubble Flex contents (正常)
const okBubble = {
  type: 'bubble',
  body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'こんにちは', wrap: true }] },
};
// 不正: 空 carousel
const emptyCarousel = { type: 'carousel', contents: [] };
// 不正: http 画像
const httpImageBubble = {
  type: 'bubble',
  body: { type: 'box', layout: 'vertical', contents: [{ type: 'image', url: 'http://ex.com/a.jpg' }] },
};
// 不正: javascript: uri
const badUriBubble = {
  type: 'bubble',
  body: {
    type: 'box',
    layout: 'vertical',
    contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label: 'go', uri: 'javascript:alert(1)' } }],
  },
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.createBroadcast.mockResolvedValue({
    id: 'b1', title: 't', message_type: 'flex', message_content: '{}', target_type: 'all',
    status: 'draft', created_at: '2026-07-03T00:00:00.000', updated_at: '2026-07-03T00:00:00.000',
  });
});

describe('POST /api/broadcasts server flex validation (T-F1)', () => {
  async function post(body: Record<string, unknown>) {
    const app = setupApp();
    return app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('正常 bare flex は 201 で保存される', async () => {
    const res = await post({ title: 'ok', messageType: 'flex', messageContent: JSON.stringify(okBubble), targetType: 'all' });
    expect(res.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledOnce();
  });

  test('不正 flex (空 carousel) は 400 で保存されない', async () => {
    const res = await post({ title: 'x', messageType: 'flex', messageContent: JSON.stringify(emptyCarousel), targetType: 'all' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
    const b = (await res.json()) as { success: boolean; error: string };
    expect(b.success).toBe(false);
    expect(b.error).not.toMatch(/[a-zA-Z]{5,}/); // 日本語エラー (英語専門語を出さない)
  });

  test('不正 flex (http 画像) は 400', async () => {
    const res = await post({ title: 'x', messageType: 'flex', messageContent: JSON.stringify(httpImageBubble), targetType: 'all' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('不正 flex (javascript: uri) は 400', async () => {
    const res = await post({ title: 'x', messageType: 'flex', messageContent: JSON.stringify(badUriBubble), targetType: 'all' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('parse 不能な messageContent (flex) は 400', async () => {
    const res = await post({ title: 'x', messageType: 'flex', messageContent: '{not json', targetType: 'all' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('altText 超過 (401 文字) は 400', async () => {
    const res = await post({
      title: 'x', messageType: 'flex', messageContent: JSON.stringify(okBubble), targetType: 'all',
      altText: 'あ'.repeat(401),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('非 flex (text) は検証をスキップし従来通り 201', async () => {
    const res = await post({ title: 't', messageType: 'text', messageContent: 'ただのテキスト', targetType: 'all' });
    expect(res.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledOnce();
  });

  test('wrapped flex ({type:flex,altText,contents}) は unwrap 後 201 (後方互換 / T-F2)', async () => {
    const wrapped = { type: 'flex', altText: 'あいさつ', contents: okBubble };
    const res = await post({ title: 'ok', messageType: 'flex', messageContent: JSON.stringify(wrapped), targetType: 'all' });
    expect(res.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledOnce();
  });

  test('wrapped flex で中身が不正なら 400 (T-F2)', async () => {
    const wrapped = { type: 'flex', altText: 'x', contents: emptyCarousel };
    const res = await post({ title: 'x', messageType: 'flex', messageContent: JSON.stringify(wrapped), targetType: 'all' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });
});

describe('PUT /api/broadcasts/:id server flex validation (T-F1/T-F2)', () => {
  function existingFlex(overrides: Record<string, unknown> = {}) {
    return {
      id: 'b1', title: 't', message_type: 'flex', message_content: JSON.stringify(okBubble),
      target_type: 'all', status: 'draft', created_at: '2026-07-03T00:00:00.000',
      updated_at: '2026-07-03T00:00:00.000', ...overrides,
    };
  }
  function existingText(overrides: Record<string, unknown> = {}) {
    return {
      id: 'b1', title: 't', message_type: 'text', message_content: 'hi',
      target_type: 'all', status: 'draft', created_at: '2026-07-03T00:00:00.000',
      updated_at: '2026-07-03T00:00:00.000', ...overrides,
    };
  }

  async function put(id: string, body: Record<string, unknown>) {
    const app = setupApp();
    return app.request(`/api/broadcasts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('messageContent 未指定 (title だけ) は検証せず後方互換 (200)', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(existingFlex());
    dbMocks.updateBroadcast.mockResolvedValue(existingFlex({ title: '新タイトル' }));
    const res = await put('b1', { title: '新タイトル' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateBroadcast).toHaveBeenCalledOnce();
  });

  test('既存 flex に不正 messageContent 上書きは 400', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(existingFlex());
    const res = await put('b1', { messageContent: JSON.stringify(emptyCarousel) });
    expect(res.status).toBe(400);
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
  });

  test('既存 flex に正常 messageContent 上書きは 200', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(existingFlex());
    dbMocks.updateBroadcast.mockResolvedValue(existingFlex());
    const res = await put('b1', { messageContent: JSON.stringify(okBubble) });
    expect(res.status).toBe(200);
    expect(dbMocks.updateBroadcast).toHaveBeenCalledOnce();
  });

  test('text→flex に messageType だけ変え不正 content は 400 (実効 type / T-F2)', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(existingText());
    const res = await put('b1', { messageType: 'flex', messageContent: JSON.stringify(httpImageBubble) });
    expect(res.status).toBe(400);
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
  });

  test('既存 flex を messageType=text に変えれば検証しない (200)', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(existingFlex());
    dbMocks.updateBroadcast.mockResolvedValue(existingText());
    const res = await put('b1', { messageType: 'text', messageContent: 'ただのテキスト' });
    expect(res.status).toBe(200);
    expect(dbMocks.updateBroadcast).toHaveBeenCalledOnce();
  });
});
