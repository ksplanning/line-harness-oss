import { describe, expect, test, vi } from 'vitest';
import {
  createFaq,
  getActiveFaqsForMatch,
  getFaqs,
  markUnmatchedResolved,
  recordUnmatchedQuestion,
} from './faqs.js';

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

describe('FAQ DB helpers', () => {
  test('getFaqs includes account-local and global FAQs for an account', async () => {
    const s = stmt({ all: vi.fn().mockResolvedValue({ results: [{ id: 'faq-1' }] }) });
    const db = { prepare: vi.fn().mockReturnValue(s) } as unknown as D1Database;

    await expect(getFaqs(db, 'acc-1')).resolves.toEqual([{ id: 'faq-1' }]);

    expect(db.prepare).toHaveBeenCalledWith(
      `SELECT * FROM faqs WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`,
    );
    expect(s.bind).toHaveBeenCalledWith('acc-1');
  });

  test('getActiveFaqsForMatch is active-only and account scoped', async () => {
    const s = stmt();
    const db = { prepare: vi.fn().mockReturnValue(s) } as unknown as D1Database;

    await getActiveFaqsForMatch(db, 'acc-1');

    expect(db.prepare).toHaveBeenCalledWith(
      `SELECT * FROM faqs WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`,
    );
    expect(s.bind).toHaveBeenCalledWith('acc-1');
  });

  test('createFaq stores variants as JSON and returns the inserted row', async () => {
    const insert = stmt();
    const select = stmt({ first: vi.fn().mockResolvedValue({ id: 'created' }) });
    const db = {
      prepare: vi.fn()
        .mockReturnValueOnce(insert)
        .mockReturnValueOnce(select),
    } as unknown as D1Database;

    await expect(createFaq(db, {
      question: '営業時間は？',
      variants: ['何時から', '開店時間'],
      answer: '10時からです',
      lineAccountId: 'acc-1',
      isActive: false,
    })).resolves.toEqual({ id: 'created' });

    expect(insert.bind).toHaveBeenCalledWith(
      expect.any(String),
      'acc-1',
      '営業時間は？',
      JSON.stringify(['何時から', '開店時間']),
      '10時からです',
      0,
      expect.any(String),
      expect.any(String),
    );
  });

  test('unmatched question can be recorded and marked resolved', async () => {
    const insert = stmt();
    const select = stmt({ first: vi.fn().mockResolvedValue({ id: 'unmatched-1' }) });
    const update = stmt();
    const db = {
      prepare: vi.fn()
        .mockReturnValueOnce(insert)
        .mockReturnValueOnce(select)
        .mockReturnValueOnce(update),
    } as unknown as D1Database;

    await recordUnmatchedQuestion(db, {
      lineAccountId: 'acc-1',
      friendId: 'friend-1',
      question: '駐車場ある？',
      topScore: 0.42,
    });
    await markUnmatchedResolved(db, 'unmatched-1', 'faq-1');

    expect(insert.bind).toHaveBeenCalledWith(
      expect.any(String),
      'acc-1',
      'friend-1',
      '駐車場ある？',
      0.42,
    );
    expect(update.bind).toHaveBeenCalledWith('faq-1', 'unmatched-1');
  });
});
