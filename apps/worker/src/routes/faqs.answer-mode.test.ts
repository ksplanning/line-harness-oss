/**
 * T-A4 (Phase B B-1) — answer_mode が faq_bot 設定 JSON に持たれ、PUT round-trip で
 * 既存キーを落とさず安全側 default='draft' を保つ検証。
 */
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { faqs } from './faqs.js';

/** account_settings を 1 行だけ持つ stateful stub (PUT で保存した value を GET が返す)。 */
function statefulDb() {
  let stored: string | null = null;
  const db = {
    prepare(sql: string) {
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return isSelect && stored ? { value: stored } : null;
            },
            async run() {
              // PUT INSERT ... の JSON 引数を捕捉 (settings value)。
              const json = args.find((a) => typeof a === 'string' && (a as string).startsWith('{'));
              if (json) stored = json as string;
              return { meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, current: () => (stored ? JSON.parse(stored) : null) };
}

function app(db: D1Database) {
  const a = new Hono<{ Bindings: { DB: D1Database } }>();
  a.use('*', async (c, next) => { c.env = { DB: db }; await next(); });
  a.route('/', faqs);
  return a;
}

describe('faq-bot settings answer_mode (T-A4)', () => {
  test('default は draft (未保存アカウントの GET)', async () => {
    const { db } = statefulDb();
    const res = await app(db).request('/api/account-settings/faq-bot?accountId=acc-1');
    const body = (await res.json()) as { data: { answerMode: string } };
    expect(body.data.answerMode).toBe('draft');
  });

  test('PUT answerMode=draft → GET で draft・既存キー (threshold 等) を落とさない', async () => {
    const { db } = statefulDb();
    const putRes = await app(db).request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acc-1',
        enabled: true,
        threshold: 0.75,
        handoffMessage: '担当者に代わります',
        maxRepliesPerDay: 3,
        answerMode: 'draft',
      }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await app(db).request('/api/account-settings/faq-bot?accountId=acc-1');
    const body = (await getRes.json()) as { data: Record<string, unknown> };
    expect(body.data.answerMode).toBe('draft');
    // round-trip で既存キーが保持される
    expect(body.data.enabled).toBe(true);
    expect(body.data.threshold).toBe(0.75);
    expect(body.data.handoffMessage).toBe('担当者に代わります');
    expect(body.data.maxRepliesPerDay).toBe(3);
  });

  test('PUT answerMode=auto → GET で auto を維持', async () => {
    const { db } = statefulDb();
    await app(db).request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1', enabled: true, answerMode: 'auto' }),
    });
    const getRes = await app(db).request('/api/account-settings/faq-bot?accountId=acc-1');
    const body = (await getRes.json()) as { data: { answerMode: string } };
    expect(body.data.answerMode).toBe('auto');
  });

  test('不正な answerMode は draft に正規化', async () => {
    const { db } = statefulDb();
    await app(db).request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc-1', answerMode: 'nonsense' }),
    });
    const getRes = await app(db).request('/api/account-settings/faq-bot?accountId=acc-1');
    const body = (await getRes.json()) as { data: { answerMode: string } };
    expect(body.data.answerMode).toBe('draft');
  });
});
