/**
 * saved-searches CRUD route (G10 C9) — server 検証 + 配線。
 *
 *   - POST 作成 (201) → GET 一覧に出る
 *   - POST 不正 conditions (未知 rule type / operator 不正) を 400
 *   - POST name 空を 400
 *   - PATCH rename / DELETE
 *   - 未認証は 401
 *
 * db helper は in-memory Map で mock (実 SQL は packages/db の saved-searches.test.ts)。
 * auth は real authMiddleware + mock D1 (staff_members→null → env.API_KEY fallback)。
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const hoisted = vi.hoisted(() => ({ store: new Map<string, Record<string, unknown>>() }));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  let seq = 0;
  return {
    ...actual,
    listSavedSearches: vi.fn(async (_db: unknown, accountId: string | null) =>
      Array.from(hoisted.store.values()).filter(
        (s) => s.lineAccountId === null || !accountId || s.lineAccountId === accountId,
      ),
    ),
    getSavedSearchById: vi.fn(async (_db: unknown, id: string) => hoisted.store.get(id) ?? null),
    createSavedSearch: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      const id = `ss-${++seq}`;
      const row = {
        id,
        lineAccountId: input.lineAccountId ?? null,
        name: input.name,
        conditions: input.conditions,
        createdAt: 'now',
        updatedAt: 'now',
      };
      hoisted.store.set(id, row);
      return row;
    }),
    renameSavedSearch: vi.fn(async (_db: unknown, id: string, name: string) => {
      const row = hoisted.store.get(id);
      if (!row) return null;
      row.name = name;
      return row;
    }),
    updateSavedSearchConditions: vi.fn(async (_db: unknown, id: string, conditions: string) => {
      const row = hoisted.store.get(id);
      if (!row) return null;
      row.conditions = conditions;
      return row;
    }),
    deleteSavedSearch: vi.fn(async (_db: unknown, id: string) => {
      hoisted.store.delete(id);
    }),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { savedSearches } from './saved-searches.js';

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
  app.route('/', savedSearches);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' } };
const VALID_CONDS = { operator: 'OR', rules: [{ type: 'tag_exists', value: 'tag-a' }] };

beforeEach(() => {
  hoisted.store.clear();
});

describe('saved-searches CRUD', () => {
  test('POST creates (201) and GET lists it', async () => {
    const app = setupApp();
    const post = await app.request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', name: 'VIP', conditions: VALID_CONDS }),
    });
    expect(post.status).toBe(201);

    const list = await app.request('/api/saved-searches?accountId=acc-1', AUTH);
    const body = await list.json<{ data: Array<{ name: string }> }>();
    expect(body.data.map((s) => s.name)).toEqual(['VIP']);
  });

  test('POST with unknown rule type is 400', async () => {
    const res = await setupApp().request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', name: 'bad', conditions: { operator: 'AND', rules: [{ type: 'bogus', value: 'x' }] } }),
    });
    expect(res.status).toBe(400);
  });

  test('POST with invalid operator is 400', async () => {
    const res = await setupApp().request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', name: 'bad', conditions: { operator: 'XOR', rules: [] } }),
    });
    expect(res.status).toBe(400);
  });

  test('POST with empty name is 400', async () => {
    const res = await setupApp().request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', name: '  ', conditions: VALID_CONDS }),
    });
    expect(res.status).toBe(400);
  });

  test('PATCH renames and DELETE removes (matching account context)', async () => {
    const app = setupApp();
    const post = await app.request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', name: 'old', conditions: VALID_CONDS }),
    });
    const { data } = await post.json<{ data: { id: string } }>();

    const patch = await app.request(`/api/saved-searches/${data.id}?accountId=acc-1`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ name: 'new' }),
    });
    const patched = await patch.json<{ data: { name: string } }>();
    expect(patched.data.name).toBe('new');

    const del = await app.request(`/api/saved-searches/${data.id}?accountId=acc-1`, { method: 'DELETE', ...AUTH });
    expect(del.status).toBe(200);
    expect(hoisted.store.size).toBe(0);
  });

  test('PATCH/DELETE of an account-scoped saved search from another account is rejected 403 (reviewer R1 MED)', async () => {
    const app = setupApp();
    const post = await app.request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: 'acc-1', name: 'x', conditions: VALID_CONDS }),
    });
    const { data } = await post.json<{ data: { id: string } }>();

    const patch = await app.request(`/api/saved-searches/${data.id}?accountId=acc-2`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ name: 'hijack' }),
    });
    expect(patch.status).toBe(403);

    // request に accountId が無い場合も account-scoped 行は拒否。
    const patchNoAcc = await app.request(`/api/saved-searches/${data.id}`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ name: 'hijack' }),
    });
    expect(patchNoAcc.status).toBe(403);

    const del = await app.request(`/api/saved-searches/${data.id}?accountId=acc-2`, { method: 'DELETE', ...AUTH });
    expect(del.status).toBe(403);
    expect(hoisted.store.size).toBe(1); // 拒否されたので残る
  });

  test('global (null-account) saved search is editable from any account context', async () => {
    const app = setupApp();
    const post = await app.request('/api/saved-searches', {
      method: 'POST',
      ...AUTH,
      body: JSON.stringify({ accountId: null, name: 'g', conditions: VALID_CONDS }),
    });
    const { data } = await post.json<{ data: { id: string } }>();
    const patch = await app.request(`/api/saved-searches/${data.id}?accountId=acc-9`, {
      method: 'PATCH',
      ...AUTH,
      body: JSON.stringify({ name: 'g2' }),
    });
    expect(patch.status).toBe(200);
  });

  test('unauthenticated request is 401', async () => {
    const res = await setupApp().request('/api/saved-searches?accountId=acc-1');
    expect(res.status).toBe(401);
  });
});
