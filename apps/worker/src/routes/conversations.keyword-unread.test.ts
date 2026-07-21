import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { conversations } from './conversations.js';

describe('GET /api/conversations — registered keyword alignment', () => {
  test('[d] future handled markers are excluded from list and count SQL', async () => {
    const sqls: string[] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        const statement = {
          bind() { return statement; },
          async all() { return { results: [] }; },
          async first() { return { total: 0 }; },
        };
        return statement;
      },
    } as unknown as D1Database;
    const app = new Hono();
    app.route('/', conversations);

    const response = await app.request('/api/conversations', undefined, { DB: db } as never);

    expect(response.status).toBe(200);
    expect(sqls).toHaveLength(2);
    const handledSources = /source NOT IN \('postback', 'auto_reply_keyword', 'auto_reply_handled'\)/g;
    expect(sqls[0].match(handledSources)).toHaveLength(3);
    expect(sqls[1].match(handledSources)).toHaveLength(1);
    expect(sqls.join('\n')).not.toContain("source != 'postback'");
  });
});
