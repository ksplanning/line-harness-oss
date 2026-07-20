import { describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  countRecentFaqReplies,
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
      '', // Phase B B-2: search_text (searchText 省略 → additive default '')
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

// reviewer R1-I2/F-2: +09:00 付き実送信と suffix なし JST 草案の 24h 窓を実 SQLite で検証する。
describe('countRecentFaqReplies 24h window (real SQLite / R1-I2)', () => {
  // better-sqlite3 の同期 API を D1 の async prepare().bind().first() 形に薄くラップ。
  function d1(db: Database.Database): D1Database {
    return {
      prepare(sql: string) {
        const s = db.prepare(sql);
        let params: unknown[] = [];
        const api = {
          bind(...args: unknown[]) { params = args; return api; },
          async first<T>() { return (s.get(...params) as T) ?? null; },
          async all<T>() { return { results: s.all(...params) as T[] }; },
          async run() { s.run(...params); return {}; },
        };
        return api;
      },
    } as unknown as D1Database;
  }

  function jst(d: Date): string {
    // jstNow() と同じ形: JST の ISO 文字列 (末尾 Z を +09:00 に置換)
    return new Date(d.getTime() + 9 * 3_600_000).toISOString().replace('Z', '+09:00');
  }

  function seedDb(): Database.Database {
    const raw = new Database(':memory:');
    raw.exec(`CREATE TABLE messages_log (
      id TEXT, friend_id TEXT, direction TEXT, source TEXT, delivery_type TEXT, content TEXT, created_at TEXT
    );
    CREATE TABLE ai_faq_drafts (
      id TEXT, friend_id TEXT, created_at TEXT
    )`);
    return raw;
  }

  function insertReply(raw: Database.Database, friendId: string, createdAt: string, source = 'faq_bot', delivery = 'reply') {
    raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, source, delivery_type, content, created_at)
                 VALUES (?, ?, 'outgoing', ?, ?, 'x', ?)`)
      .run(crypto.randomUUID(), friendId, source, delivery, createdAt);
  }

  function insertDraft(raw: Database.Database, friendId: string, createdAt: string) {
    raw.prepare(`INSERT INTO ai_faq_drafts (id, friend_id, created_at) VALUES (?, ?, ?)`)
      .run(crypto.randomUUID(), friendId, createdAt);
  }

  function naiveJst(d: Date): string {
    return new Date(d.getTime() + 9 * 3_600_000).toISOString().replace('Z', '');
  }

  test('counts a reply from 23h ago (within window) and excludes one from 25h ago (JST-stored)', async () => {
    const raw = seedDb();
    const now = Date.now();
    insertReply(raw, 'f1', jst(new Date(now - 23 * 3_600_000))); // 内 (数える)
    insertReply(raw, 'f1', jst(new Date(now - 25 * 3_600_000))); // 外 (数えない)

    // 旧実装 (辞書比較) なら 2 を返して境界が壊れる。julianday 版は 1。
    await expect(countRecentFaqReplies(d1(raw), 'f1')).resolves.toBe(1);
  });

  test('excludes non-faq_bot and non-reply rows even inside the window', async () => {
    const raw = seedDb();
    const recent = jst(new Date(Date.now() - 1 * 3_600_000));
    insertReply(raw, 'f1', recent, 'faq_bot', 'reply');    // 数える
    insertReply(raw, 'f1', recent, 'faq_handoff', 'reply'); // handoff は数えない
    insertReply(raw, 'f1', recent, 'auto_reply', 'reply');  // 別 source
    insertReply(raw, 'f1', recent, 'faq_bot', 'push');      // push は数えない
    insertReply(raw, 'f2', recent, 'faq_bot', 'reply');     // 別 friend

    await expect(countRecentFaqReplies(d1(raw), 'f1')).resolves.toBe(1);
  });

  test('counts recent saved drafts but excludes old and other-friend drafts', async () => {
    const raw = seedDb();
    const now = Date.now();
    insertReply(raw, 'f1', jst(new Date(now - 1 * 3_600_000)));
    insertDraft(raw, 'f1', naiveJst(new Date(now - 23 * 3_600_000)));
    insertDraft(raw, 'f1', naiveJst(new Date(now - 25 * 3_600_000)));
    insertDraft(raw, 'f2', naiveJst(new Date(now - 1 * 3_600_000)));

    await expect(countRecentFaqReplies(d1(raw), 'f1')).resolves.toBe(2);
  });

  test('returns 0 when no recent reply or draft exists', async () => {
    const raw = seedDb();
    insertReply(raw, 'f1', jst(new Date(Date.now() - 30 * 3_600_000))); // 30h ago
    await expect(countRecentFaqReplies(d1(raw), 'f1')).resolves.toBe(0);
  });
});
