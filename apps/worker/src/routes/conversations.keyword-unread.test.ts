import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  getAllUnansweredRows: vi.fn(),
}));

vi.mock('../services/unanswered-inbox.js', () => ({
  getAllUnansweredRows: (...args: unknown[]) => mocks.getAllUnansweredRows(...args),
}));

import { conversations } from './conversations.js';

describe('GET /api/conversations — canonical unanswered rows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T12:00:00.000Z'));
    mocks.getAllUnansweredRows.mockReset();
    mocks.getAllUnansweredRows.mockResolvedValue([
      {
        friendId: 'older',
        displayName: '古い相談',
        pictureUrl: null,
        accountId: 'account-1',
        accountName: '公式アカウント',
        lastIncomingAt: '2026-07-23T10:00:00.000Z',
        lastManualAt: null,
        lastMachineAt: null,
        lastIncomingType: 'text',
        lastIncomingContent: '古い相談です',
      },
      {
        friendId: 'newer',
        displayName: '新しい相談',
        pictureUrl: null,
        accountId: 'account-1',
        accountName: '公式アカウント',
        lastIncomingAt: '2026-07-23T11:00:00.000Z',
        lastManualAt: null,
        lastMachineAt: null,
        lastIncomingType: 'text',
        lastIncomingContent: 'あ'.repeat(90),
      },
      {
        friendId: 'other-account',
        displayName: '別アカウント',
        pictureUrl: null,
        accountId: 'account-2',
        accountName: '別アカウント',
        lastIncomingAt: '2026-07-23T09:00:00.000Z',
        lastManualAt: null,
        lastMachineAt: null,
        lastIncomingType: 'image',
        lastIncomingContent: '',
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('正本だけで account・待ち時間・offset/limit を処理し、既存response shapeを保つ', async () => {
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            if (sql.includes('FROM friends f')) {
              return {
                results: [{
                  friend_id: 'newer',
                  line_user_id: 'U-newer',
                  line_account_name: '公式アカウント',
                }],
              };
            }
            if (sql.includes('FROM friend_tags')) {
              return { results: [{ friend_id: 'newer', name: '要確認' }] };
            }
            return { results: [] };
          },
          async first() {
            return null;
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const app = new Hono();
    app.route('/', conversations);

    const response = await app.request(
      '/api/conversations?lineAccountId=account-1&minHoursSince=0.5&maxHoursSince=3&limit=1&offset=1',
      undefined,
      { DB: db } as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: { total: number; items: Array<Record<string, unknown>> };
    };
    expect(body).toEqual({
      success: true,
      data: {
        total: 2,
        items: [{
          friendId: 'newer',
          lineUserId: 'U-newer',
          displayName: '新しい相談',
          lineAccountId: 'account-1',
          lineAccountName: '公式アカウント',
          lastIncomingAt: '2026-07-23T11:00:00.000Z',
          hoursSince: 1,
          lastIncomingPreview: 'あ'.repeat(80),
          lastIncomingType: 'text',
          tags: ['要確認'],
        }],
      },
    });
    expect(mocks.getAllUnansweredRows).toHaveBeenCalledOnce();
    expect(preparedSql.join('\n')).not.toContain('messages_log');
    expect(preparedSql.join('\n')).not.toContain('auto_reply');
  });
});
