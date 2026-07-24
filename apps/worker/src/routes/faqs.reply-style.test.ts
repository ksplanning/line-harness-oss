import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { faqs } from './faqs.js';

type TestEnv = { Bindings: { DB: D1Database } };

function asD1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { params = values; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function createApp(raw: Database.Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: asD1(raw) };
    await next();
  });
  app.route('/', faqs);
  return app;
}

function put(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
) {
  return app.request('/api/account-settings/faq-bot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(
  app: ReturnType<typeof createApp>,
  accountId: string,
) {
  const response = await app.request(
    `/api/account-settings/faq-bot?accountId=${encodeURIComponent(accountId)}`,
  );
  return (await response.json()) as {
    success: boolean;
    data: { replyStyle: { instructions: string; greeting: string } };
  };
}

let raw: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE account_settings (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(line_account_id, key)
    );
  `);
  app = createApp(raw);
});

describe('FAQ bot reply style settings', () => {
  test('保存→再取得が一致し、アカウント A/B の設定を混ぜない', async () => {
    const styleA = {
      instructions: 'です・ます調で、親しみやすく簡潔に。',
      greeting: '店舗Aの◯◎です。',
    };
    const styleB = {
      instructions: '落ち着いた敬語で答える。',
      greeting: '店舗Bでございます。',
    };

    expect((await put(app, {
      accountId: 'account-a',
      enabled: true,
      answerMode: 'draft',
      replyStyle: styleA,
    })).status).toBe(200);
    expect((await get(app, 'account-a')).data.replyStyle).toEqual(styleA);
    expect((await get(app, 'account-b')).data.replyStyle).toEqual({
      instructions: '',
      greeting: '',
    });

    expect((await put(app, {
      accountId: 'account-b',
      enabled: true,
      answerMode: 'auto',
      replyStyle: styleB,
    })).status).toBe(200);
    expect((await get(app, 'account-a')).data.replyStyle).toEqual(styleA);
    expect((await get(app, 'account-b')).data.replyStyle).toEqual(styleB);
  });

  test('旧クライアントが replyStyle を省略して保存しても既存スタイルを消さない', async () => {
    const saved = {
      instructions: '一文を短くする。',
      greeting: '◯◎です。',
    };
    await put(app, {
      accountId: 'account-a',
      enabled: true,
      answerMode: 'draft',
      replyStyle: saved,
    });

    expect((await put(app, {
      accountId: 'account-a',
      enabled: false,
      answerMode: 'draft',
    })).status).toBe(200);

    expect((await get(app, 'account-a')).data.replyStyle).toEqual(saved);
  });
});
