/**
 * GET /api/friends の ?savedSearchId= gated apply (G10 C9 / T-B4 / HIGH-2)。
 *
 * worker では better-sqlite3 が使えないため、生成される SQL を捕捉して WHERE の形を assert:
 *   - savedSearchId 無し → 既存クエリと byte-identical (segment 条件が混ざらない)
 *   - savedSearchId 有り → 保存条件が括弧付きで AND 合成され、account 条件と共存
 *     (`f.line_account_id = ? AND (A OR B)` = 別アカウント漏れなし = HIGH-2)
 *   - 別 account の保存条件は 400 (account 一致検証) / 未存在 savedSearchId は 400
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { friends } from './friends.js';

let prepared: string[] = [];

function mockDb(savedRow: Record<string, unknown> | null): D1Database {
  return {
    prepare(sql: string) {
      prepared.push(sql);
      const api = {
        bind() {
          return api;
        },
        async first() {
          if (/FROM saved_searches/i.test(sql)) return savedRow;
          if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function setupApp(db: D1Database) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: db };
    await next();
  });
  app.route('/', friends);
  return app;
}

const OR_TWO = JSON.stringify({
  operator: 'OR',
  rules: [
    { type: 'tag_exists', value: 'tag-a' },
    { type: 'tag_exists', value: 'tag-b' },
  ],
});

function countSql(): string | undefined {
  return prepared.find((s) => /COUNT\(\*\) as count FROM friends/.test(s));
}

beforeEach(() => {
  prepared = [];
});

describe('GET /api/friends ?savedSearchId=', () => {
  test('without savedSearchId the query is byte-identical (no segment clause)', async () => {
    await setupApp(mockDb(null)).request('/api/friends?lineAccountId=acc-1');
    expect(countSql()).toBe('SELECT COUNT(*) as count FROM friends f WHERE f.line_account_id = ?');
    expect(countSql()).not.toContain('EXISTS');
  });

  test('with savedSearchId the segment is parenthesized and AND-composed with the account scope (HIGH-2)', async () => {
    const savedRow = {
      id: 'ss-1',
      line_account_id: 'acc-1',
      name: 'x',
      conditions: OR_TWO,
      created_at: 'now',
      updated_at: 'now',
    };
    await setupApp(mockDb(savedRow)).request('/api/friends?lineAccountId=acc-1&savedSearchId=ss-1');
    expect(countSql()).toBe(
      'SELECT COUNT(*) as count FROM friends f WHERE f.line_account_id = ? AND ' +
        '(EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?) OR ' +
        'EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?))',
    );
  });

  test('a saved search belonging to another account is rejected with 400', async () => {
    const savedRow = { id: 'ss-1', line_account_id: 'acc-2', name: 'x', conditions: OR_TWO, created_at: 'now', updated_at: 'now' };
    const res = await setupApp(mockDb(savedRow)).request('/api/friends?lineAccountId=acc-1&savedSearchId=ss-1');
    expect(res.status).toBe(400);
  });

  test('an account-scoped saved search WITHOUT a matching request account is rejected with 400', async () => {
    // reviewer R1 HIGH: no-account リクエストで account-scoped saved search を無スコープ適用させない。
    const savedRow = { id: 'ss-1', line_account_id: 'acc-1', name: 'x', conditions: OR_TWO, created_at: 'now', updated_at: 'now' };
    const res = await setupApp(mockDb(savedRow)).request('/api/friends?savedSearchId=ss-1');
    expect(res.status).toBe(400);
  });

  test('a global (null-account) saved search is applied even without a request account', async () => {
    const savedRow = { id: 'ss-g', line_account_id: null, name: 'global', conditions: OR_TWO, created_at: 'now', updated_at: 'now' };
    await setupApp(mockDb(savedRow)).request('/api/friends?savedSearchId=ss-g');
    expect(countSql()).toBe(
      'SELECT COUNT(*) as count FROM friends f WHERE ' +
        '(EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?) OR ' +
        'EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?))',
    );
  });

  test('an unknown savedSearchId is rejected with 400', async () => {
    const res = await setupApp(mockDb(null)).request('/api/friends?savedSearchId=nope');
    expect(res.status).toBe(400);
  });
});
