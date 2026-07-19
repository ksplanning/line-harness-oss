import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { friends } from './friends.js';

function setupApp() {
  let updates = 0;
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      const api = {
        bind() { return api; },
        async first() {
          if (/FROM friends/i.test(sql)) {
            return {
              id: 'fr_1', line_user_id: 'U1', display_name: 'Test', metadata: '{}',
              is_following: 1, created_at: '2026-07-19', updated_at: '2026-07-19',
            };
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() { updates += 1; return { meta: { changes: 1 } }; },
      };
      return api;
    },
  } as unknown as D1Database;
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: db };
    await next();
  });
  app.route('/', friends);
  return { app, updates: () => updates, prepared };
}

describe('PUT /api/friends/:id/metadata — reserved key protection', () => {
  test.each(['__formaloo_friend_metadata_sync', '__proto__', 'prototype', 'constructor'])(
    '%s を 400 で拒否し DB を書かない',
    async (key) => {
      const { app, updates } = setupApp();
      const response = await app.request('/api/friends/fr_1/metadata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: 'overwrite' }),
      });
      expect(response.status).toBe(400);
      expect(updates()).toBe(0);
    },
  );

  test('通常キーは DB 側 CAS で merge し、並行した自動更新を巻き戻さない', async () => {
    const { app, updates, prepared } = setupApp();
    const response = await app.request('/api/friends/fr_1/metadata', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '備考': '手動値' }),
    });
    expect(response.status).toBe(200);
    expect(updates()).toBe(1);
    expect(prepared.find((sql) => /^UPDATE friends/i.test(sql))).toMatch(/AND metadata IS \?/i);
  });
});
