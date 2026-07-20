import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { faqs } from './faqs.js';

function statefulDb(initial: string | null = null) {
  let stored: string | null = initial;
  const db = {
    prepare(sql: string) {
      const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return isSelect && stored !== null ? { value: stored } : null;
            },
            async run() {
              const json = args.find((value) => typeof value === 'string' && value.startsWith('{'));
              if (json) stored = json as string;
              return { meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, current: () => stored ? JSON.parse(stored) as Record<string, unknown> : null };
}

function app(db: D1Database) {
  const instance = new Hono<{ Bindings: { DB: D1Database } }>();
  instance.use('*', async (c, next) => { c.env = { DB: db }; await next(); });
  instance.route('/', faqs);
  return instance;
}

describe('faq-bot personal context settings', () => {
  test('未保存 account の既定は ON・全custom項目・フォーム回答あり', async () => {
    const { db } = statefulDb();
    const response = await app(db).request('/api/account-settings/faq-bot?accountId=account-a');
    const body = await response.json() as { data: Record<string, unknown> };

    expect(body.data.personalContext).toEqual({
      enabled: true,
      selectedCustomFieldIds: null,
      includeFormAnswers: true,
      maxTokens: 1_200,
    });
  });

  test('ON/OFF・custom対象・フォーム回答・token上限をPUT→GETで保持する', async () => {
    const { db, current } = statefulDb();
    const response = await app(db).request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a',
        enabled: true,
        answerMode: 'draft',
        personalContext: {
          enabled: false,
          selectedCustomFieldIds: ['field-payment', 'field-payment'],
          includeFormAnswers: false,
          maxTokens: 700,
        },
      }),
    });
    expect(response.status).toBe(200);

    expect(current()).toMatchObject({
      enabled: true,
      answerMode: 'draft',
      personalContext: {
        enabled: false,
        selectedCustomFieldIds: ['field-payment'],
        includeFormAnswers: false,
        maxTokens: 700,
      },
    });
    const get = await app(db).request('/api/account-settings/faq-bot?accountId=account-a');
    const body = await get.json() as { data: Record<string, unknown> };
    expect(body.data.personalContext).toEqual({
      enabled: false,
      selectedCustomFieldIds: ['field-payment'],
      includeFormAnswers: false,
      maxTokens: 700,
    });
  });

  test('壊れたcustom対象指定は全項目へ広げず対象なしに倒す', async () => {
    const { db } = statefulDb();
    await app(db).request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a',
        personalContext: {
          enabled: true,
          selectedCustomFieldIds: 'all',
          includeFormAnswers: false,
        },
      }),
    });
    const get = await app(db).request('/api/account-settings/faq-bot?accountId=account-a');
    const body = await get.json() as { data: { personalContext: { selectedCustomFieldIds: unknown } } };
    expect(body.data.personalContext.selectedCustomFieldIds).toEqual([]);
  });

  test('旧clientのpersonalContext省略PUTは保存済みOFFを既定ONへ戻さない', async () => {
    const { db } = statefulDb();
    const instance = app(db);
    await instance.request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a',
        enabled: true,
        personalContext: {
          enabled: false,
          selectedCustomFieldIds: ['field-payment'],
          includeFormAnswers: false,
          maxTokens: 700,
        },
      }),
    });

    await instance.request('/api/account-settings/faq-bot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a',
        enabled: false,
        answerMode: 'draft',
      }),
    });

    const response = await instance.request(
      '/api/account-settings/faq-bot?accountId=account-a',
    );
    const body = await response.json() as {
      data: { personalContext: Record<string, unknown> };
    };
    expect(body.data.personalContext).toEqual({
      enabled: false,
      selectedCustomFieldIds: ['field-payment'],
      includeFormAnswers: false,
      maxTokens: 700,
    });
  });

  test('壊れた保存JSONはruntimeと同じく本人contextをfail-safe OFFで返す', async () => {
    const { db } = statefulDb('{');
    const response = await app(db).request(
      '/api/account-settings/faq-bot?accountId=account-a',
    );
    const body = await response.json() as {
      data: { personalContext: Record<string, unknown> };
    };

    expect(body.data.personalContext).toEqual({
      enabled: false,
      selectedCustomFieldIds: [],
      includeFormAnswers: false,
      maxTokens: 1_200,
    });
  });

  test('空文字の保存値も未保存扱いせずruntimeと同じくfail-safe OFFで返す', async () => {
    const { db } = statefulDb('');
    const response = await app(db).request(
      '/api/account-settings/faq-bot?accountId=account-a',
    );
    const body = await response.json() as {
      data: { personalContext: Record<string, unknown> };
    };

    expect(body.data.personalContext).toEqual({
      enabled: false,
      selectedCustomFieldIds: [],
      includeFormAnswers: false,
      maxTokens: 1_200,
    });
  });
});
