/**
 * canned-responses CRUD route (G23 C3) — server 検証 + account-scope guard 一貫。
 *
 *   - GET が account+global を返す / 未認証 401
 *   - POST が title/content 必須 (空→400) / 正常時 accountId スコープで 201
 *   - PATCH 更新 / 別 accountId の account-scoped 行は 403 / global 許可 / 存在しない id 404
 *   - DELETE 別 accountId は 403 / global 許可
 *   - GET/POST/PATCH/DELETE 全部で account guard が一貫 (batch4 R1 FAIL 再発防止)
 *
 * db helper は in-memory Map で mock。auth は real authMiddleware + mock D1。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const hoisted = vi.hoisted(() => ({ store: new Map<string, Record<string, unknown>>() }));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  let seq = 0;
  return {
    ...actual,
    listCannedResponses: vi.fn(async (_db: unknown, accountId: string | null) =>
      Array.from(hoisted.store.values()).filter(
        (s) => s.lineAccountId === null || !accountId || s.lineAccountId === accountId,
      ),
    ),
    getCannedResponseById: vi.fn(async (_db: unknown, id: string) => hoisted.store.get(id) ?? null),
    createCannedResponse: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      const id = `cr-${++seq}`;
      const row = {
        id,
        lineAccountId: input.lineAccountId ?? null,
        title: input.title,
        content: input.content,
        createdAt: 'now',
        updatedAt: 'now',
      };
      hoisted.store.set(id, row);
      return row;
    }),
    updateCannedResponse: vi.fn(async (_db: unknown, id: string, input: Record<string, unknown>) => {
      const row = hoisted.store.get(id);
      if (!row) return null;
      if (input.title !== undefined) row.title = input.title;
      if (input.content !== undefined) row.content = input.content;
      return row;
    }),
    deleteCannedResponse: vi.fn(async (_db: unknown, id: string) => {
      hoisted.store.delete(id);
    }),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { cannedResponses } from './canned-responses.js';

const mockDb = {
  prepare() {
    return {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        return {};
      },
    };
  },
} as unknown as D1Database;

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: mockDb, API_KEY: 'test-key' };
    await next();
  });
  app.use('*', authMiddleware);
  app.route('/', cannedResponses);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' } };

beforeEach(() => {
  hoisted.store.clear();
});

describe('canned-responses CRUD', () => {
  test('POST creates (201) and GET lists it (account+global)', async () => {
    const app = setupApp();
    const post = await app.request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', title: '営業案内', content: '本日はご案内します' }),
    });
    expect(post.status).toBe(201);

    const list = await app.request('/api/canned-responses?accountId=acc-1', AUTH);
    const body = await list.json<{ data: Array<{ title: string }> }>();
    expect(body.data.map((s) => s.title)).toEqual(['営業案内']);
  });

  test('POST with empty title is 400', async () => {
    const res = await setupApp().request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', title: '  ', content: '本文' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST with empty content is 400', async () => {
    const res = await setupApp().request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', title: 'タイトル', content: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  test('PATCH updates and DELETE removes (matching account context)', async () => {
    const app = setupApp();
    const post = await app.request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', title: 'old', content: 'body' }),
    });
    const { data } = await post.json<{ data: { id: string } }>();

    const patch = await app.request(`/api/canned-responses/${data.id}?accountId=acc-1`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ title: 'new' }),
    });
    const patched = await patch.json<{ data: { title: string } }>();
    expect(patched.data.title).toBe('new');

    const del = await app.request(`/api/canned-responses/${data.id}?accountId=acc-1`, { method: 'DELETE', ...AUTH });
    expect(del.status).toBe(200);
    expect(hoisted.store.size).toBe(0);
  });

  test('PATCH with empty title is 400', async () => {
    const app = setupApp();
    const post = await app.request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', title: 'ok', content: 'body' }),
    });
    const { data } = await post.json<{ data: { id: string } }>();
    const patch = await app.request(`/api/canned-responses/${data.id}?accountId=acc-1`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ title: '   ' }),
    });
    expect(patch.status).toBe(400);
  });

  test('PATCH of a missing id is 404', async () => {
    const res = await setupApp().request('/api/canned-responses/nope?accountId=acc-1', {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  test('PATCH/DELETE of an account-scoped canned response from another account is rejected 403 (batch4 R1 lesson)', async () => {
    const app = setupApp();
    const post = await app.request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', title: 'x', content: 'body' }),
    });
    const { data } = await post.json<{ data: { id: string } }>();

    const patch = await app.request(`/api/canned-responses/${data.id}?accountId=acc-2`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ title: 'hijack' }),
    });
    expect(patch.status).toBe(403);

    // request に accountId が無い場合も account-scoped 行は拒否。
    const patchNoAcc = await app.request(`/api/canned-responses/${data.id}`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ title: 'hijack' }),
    });
    expect(patchNoAcc.status).toBe(403);

    const del = await app.request(`/api/canned-responses/${data.id}?accountId=acc-2`, { method: 'DELETE', ...AUTH });
    expect(del.status).toBe(403);
    expect(hoisted.store.size).toBe(1); // 拒否されたので残る
  });

  test('global (null-account) canned response is editable/deletable from any account context', async () => {
    const app = setupApp();
    const post = await app.request('/api/canned-responses', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: null, title: 'g', content: 'body' }),
    });
    const { data } = await post.json<{ data: { id: string } }>();
    const patch = await app.request(`/api/canned-responses/${data.id}?accountId=acc-9`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ title: 'g2' }),
    });
    expect(patch.status).toBe(200);
    const del = await app.request(`/api/canned-responses/${data.id}?accountId=acc-9`, { method: 'DELETE', ...AUTH });
    expect(del.status).toBe(200);
  });

  test('unauthenticated request is 401 (GET guard)', async () => {
    const res = await setupApp().request('/api/canned-responses?accountId=acc-1');
    expect(res.status).toBe(401);
  });
});
