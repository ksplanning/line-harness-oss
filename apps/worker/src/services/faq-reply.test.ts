import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({
  countRecentFaqReplies: vi.fn(),
  getActiveFaqsForMatch: vi.fn(),
  incrementFaqHitCount: vi.fn(),
  jstNow: vi.fn(() => '2026-07-02T12:00:00+09:00'),
  recordUnmatchedQuestion: vi.fn(),
}));

vi.mock('./step-delivery.js', () => ({
  buildMessage: vi.fn((type: string, text: string) => ({ type, text })),
}));

import {
  countRecentFaqReplies,
  getActiveFaqsForMatch,
  incrementFaqHitCount,
  recordUnmatchedQuestion,
} from '@line-crm/db';
import { buildMessage } from './step-delivery.js';
import { tryFaqReply } from './faq-reply.js';

function stmt(overrides: Partial<{
  bind: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  first: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}> = {}) {
  const s = {
    bind: vi.fn(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
  s.bind.mockReturnValue(s);
  return s;
}

function dbWithStatements(...statements: ReturnType<typeof stmt>[]) {
  return {
    prepare: vi.fn()
      .mockImplementation(() => statements.shift() ?? stmt()),
  } as unknown as D1Database;
}

const friend = { id: 'friend-1', line_account_id: 'acc-1' };
const lineClient = { replyMessage: vi.fn() };

describe('tryFaqReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 24h 上限カウントは db helper に移設 (R1-I2)。既定 0 回。
    vi.mocked(countRecentFaqReplies).mockResolvedValue(0);
    vi.mocked(getActiveFaqsForMatch).mockResolvedValue([
      {
        id: 'faq-1',
        line_account_id: 'acc-1',
        question: '営業時間は何時からですか',
        variants: JSON.stringify(['開店時間']),
        answer: '10時からです',
        is_active: 1,
        hit_count: 0,
        created_at: '2026-07-02T00:00:00+09:00',
        updated_at: '2026-07-02T00:00:00+09:00',
      },
    ]);
  });

  test('does nothing when account setting is missing or disabled', async () => {
    const db = dbWithStatements(stmt({ first: vi.fn().mockResolvedValue(null) }));

    await expect(tryFaqReply(db, lineClient, {
      friend,
      incomingText: '営業時間',
      lineAccountId: 'acc-1',
      replyToken: 'reply-token',
    })).resolves.toEqual({ replied: false, handoff: false });

    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(getActiveFaqsForMatch).not.toHaveBeenCalled();
  });

  test('hit replies with answer and notice, increments hit_count, and logs faq_bot outgoing', async () => {
    const settings = stmt({
      first: vi.fn().mockResolvedValue({
        value: JSON.stringify({
          enabled: true,
          threshold: 0.6,
          autoReplyNotice: '※自動返信です',
          handoffMessage: '担当者に引き継ぎます',
          maxRepliesPerDay: 5,
          answerMode: 'auto',
        }),
      }),
    });
    const log = stmt();
    const db = dbWithStatements(settings, log);

    await expect(tryFaqReply(db, lineClient, {
      friend,
      incomingText: '開店時間は？',
      lineAccountId: 'acc-1',
      replyToken: 'reply-token',
    })).resolves.toEqual({ replied: true, handoff: false });

    expect(buildMessage).toHaveBeenCalledWith('text', '10時からです\n※自動返信です');
    expect(lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [{ type: 'text', text: '10時からです\n※自動返信です' }]);
    expect(incrementFaqHitCount).toHaveBeenCalledWith(db, 'faq-1');
    expect(log.bind).toHaveBeenCalledWith(
      expect.any(String),
      'friend-1',
      'text',
      '10時からです\n※自動返信です',
      '2026-07-02T12:00:00+09:00',
    );
    // 24h カウントは db helper 経由 (db.prepare は経由しない)。log は 2 本目の prepare。
    expect(String((db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain("'faq_bot'");
  });

  test('miss records unmatched with top_score and sends handoff when configured', async () => {
    const settings = stmt({
      first: vi.fn().mockResolvedValue({
        value: JSON.stringify({ enabled: true, threshold: 0.95, handoffMessage: '担当者に確認します', maxRepliesPerDay: 5 }),
      }),
    });
    const log = stmt();
    const db = dbWithStatements(settings, log);

    await expect(tryFaqReply(db, lineClient, {
      friend,
      incomingText: '営業時間',
      lineAccountId: 'acc-1',
      replyToken: 'reply-token',
    })).resolves.toEqual({ replied: false, handoff: true });

    expect(recordUnmatchedQuestion).toHaveBeenCalledWith(db, {
      lineAccountId: 'acc-1',
      friendId: 'friend-1',
      question: '営業時間',
      topScore: expect.any(Number),
    });
    expect(lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [{ type: 'text', text: '担当者に確認します' }]);
    // handoff log は 2 本目の prepare (count は db helper 経由)。
    expect(String((db.prepare as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain("'faq_handoff'");
  });

  test('maxRepliesPerDay forces handoff even when FAQ would hit', async () => {
    const settings = stmt({
      first: vi.fn().mockResolvedValue({
        value: JSON.stringify({ enabled: true, threshold: 0.6, handoffMessage: '担当者に引き継ぎます', maxRepliesPerDay: 1 }),
      }),
    });
    // R1-I2: 上限到達を db helper の返り値で表現 (24h に既に 1 回返信済み・上限 1)。
    vi.mocked(countRecentFaqReplies).mockResolvedValue(1);
    const log = stmt();
    const db = dbWithStatements(settings, log);

    await expect(tryFaqReply(db, lineClient, {
      friend,
      incomingText: '営業時間は何時からですか',
      lineAccountId: 'acc-1',
      replyToken: 'reply-token',
    })).resolves.toEqual({ replied: false, handoff: true });

    expect(incrementFaqHitCount).not.toHaveBeenCalled();
    expect(recordUnmatchedQuestion).toHaveBeenCalledWith(db, expect.objectContaining({
      question: '営業時間は何時からですか',
      topScore: expect.any(Number),
    }));
  });

  test('miss with empty handoffMessage records unmatched but does not consume reply token', async () => {
    const settings = stmt({
      first: vi.fn().mockResolvedValue({
        value: JSON.stringify({ enabled: true, threshold: 0.95, handoffMessage: '', maxRepliesPerDay: 5 }),
      }),
    });
    const db = dbWithStatements(settings);

    await expect(tryFaqReply(db, lineClient, {
      friend,
      incomingText: '営業時間',
      lineAccountId: 'acc-1',
      replyToken: 'reply-token',
    })).resolves.toEqual({ replied: false, handoff: false });

    expect(recordUnmatchedQuestion).toHaveBeenCalled();
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
  });
});
