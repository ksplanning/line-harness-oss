import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { buildFriendMetadataPredicate } from '../services/friend-metadata-condition.js';
import { friends } from './friends.js';

interface PreparedCall {
  sql: string;
  bindings: unknown[];
}

function setupApp() {
  const calls: PreparedCall[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] };
      calls.push(call);
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return statement;
        },
        async first() {
          return /COUNT\(\*\)/i.test(sql) ? { count: 0 } : null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: db };
    await next();
  });
  app.route('/', friends);
  return { app, calls };
}

describe('GET /api/friends metadata.* effective-value filter', () => {
  test('uses the same indexed/default-aware predicate as saved segments', async () => {
    const { app, calls } = setupApp();
    const response = await app.request(
      '/api/friends?metadata.%E5%85%A5%E9%87%91%E7%A2%BA%E8%AA%8D=%E6%9C%AA&includeTags=false',
    );
    expect(response.status).toBe(200);

    const expected = buildFriendMetadataPredicate('入金確認', '未', 'equals');
    const count = calls.find((call) => /COUNT\(\*\) as count FROM friends f/i.test(call.sql));
    expect(count?.sql).toBe(`SELECT COUNT(*) as count FROM friends f WHERE ${expected.sql}`);
    expect(count?.bindings).toEqual(expected.bindings);
  });
});
