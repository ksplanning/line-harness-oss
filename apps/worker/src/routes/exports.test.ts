/**
 * CSV エクスポート endpoint 検証 (batch3 C5 / T-C3・T-C4)。
 *
 * worker テスト流儀に合わせ D1 を mock (SQL 実行のみ mock)。ただし csvResponse →
 * @line-crm/shared の toCsv (BOM/CRLF/RFC4180/injection) は **実コードが走る**ので、
 * 出力 CSV は route + 正典 csv による本物。mock は「WHERE で何行返るか」を account bind
 * で filter し、cross-account 除外 (HIGH-1) も実挙動として検証する。
 *
 *   - text/csv; charset=utf-8 + 先頭 BOM + Content-Disposition attachment (T-C3)
 *   - 列見出し・日本語 UTF-8 round-trip・タグ ; 連結・フォロー中 はい/いいえ
 *   - 未認証 401 / account 必須 400 / 上限超過 400 / form 404 (T-C4)
 *   - CSV injection (=HYPERLINK) 無害化 (HIGH-2)
 *   - form-submissions の別 account 混入なし (HIGH-1 cross-account)
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { authMiddleware } from '../middleware/auth.js';
import { csvExports } from './exports.js';
import type { Env } from '../index.js';

interface FriendRow {
  display_name: string | null;
  line_user_id: string;
  is_following: number;
  score: number;
  created_at: string;
  tag_names: string | null;
  line_account_id: string;
}
interface SubRow {
  data: string;
  created_at: string;
  friend_name: string | null;
  form_id: string;
  line_account_id: string | null;
}
interface BookingRow {
  starts_at: string;
  menu_name: string;
  staff_name: string | null;
  friend_name: string | null;
  status: string;
  created_at: string;
  line_account_id: string;
}
interface Seed {
  friends?: FriendRow[];
  forms?: Record<string, { id: string; name: string; fields: string }>;
  submissions?: SubRow[];
  bookings?: BookingRow[];
}

/** WHERE を account bind で再現する mock D1。auth 用 staff_members は常に空 (env.API_KEY fallback)。 */
function makeExportDb(seed: Seed) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ sql, binds });
          if (/FROM staff_members/i.test(sql)) return null; // auth → env.API_KEY へ
          if (/FROM forms WHERE id/i.test(sql)) {
            return (seed.forms?.[binds[0] as string] as T) ?? null;
          }
          return null;
        },
        async all<T>() {
          calls.push({ sql, binds });
          if (/FROM friends f/i.test(sql)) {
            const acc = binds[0];
            return { results: (seed.friends ?? []).filter((f) => f.line_account_id === acc) as T[] };
          }
          if (/FROM form_submissions fs/i.test(sql)) {
            const formId = binds[0];
            let rows = (seed.submissions ?? []).filter((s) => s.form_id === formId);
            if (/INNER JOIN friends/i.test(sql)) {
              const acc = binds[1];
              rows = rows.filter((s) => s.line_account_id === acc);
            }
            return { results: rows as T[] };
          }
          if (/FROM bookings b/i.test(sql)) {
            const acc = binds[0];
            let rows = (seed.bookings ?? []).filter((b) => b.line_account_id === acc);
            if (/b\.status = \?/i.test(sql)) {
              const st = binds[1];
              rows = rows.filter((b) => b.status === st);
            }
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    (c.env as unknown) = { DB: db, API_KEY: 'test-key' };
    await next();
  });
  app.use('*', authMiddleware);
  app.route('/', csvExports);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key' } };

/**
 * CSV レスポンスを raw bytes で読む。`res.text()`/TextDecoder は WHATWG 仕様で先頭
 * BOM を除去するため、BOM 実在は arrayBuffer の先頭 3 byte (EF BB BF) で検査する。
 * text は decode 後 (BOM 除去済) — 行分割はそのまま split すればよい。
 */
async function readCsv(res: Response): Promise<{ hasBom: boolean; text: string }> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = new TextDecoder('utf-8').decode(buf);
  return { hasBom, text };
}

describe('GET /api/exports/friends.csv (T-C3)', () => {
  const friends: FriendRow[] = [
    {
      display_name: '山田, 花子', line_user_id: 'U1', is_following: 1, score: 42,
      created_at: '2026-01-01T10:00:00.000+09:00', tag_names: 'VIP;新規', line_account_id: 'acc-1',
    },
    {
      display_name: '別アカ', line_user_id: 'U2', is_following: 0, score: 0,
      created_at: '2026-01-02T10:00:00.000+09:00', tag_names: null, line_account_id: 'acc-2',
    },
  ];

  test('text/csv + BOM + Content-Disposition + 列見出し + 日本語 round-trip + cross-account 除外', async () => {
    const { db, calls } = makeExportDb({ friends });
    const res = await setupApp(db).request('/api/exports/friends.csv?lineAccountId=acc-1', AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename\*=UTF-8''/);
    const { hasBom, text } = await readCsv(res);
    expect(hasBom).toBe(true); // 先頭 BOM (raw bytes で検査)
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('表示名,ユーザーID,フォロー中,スコア,登録日,タグ');
    expect(lines[1]).toContain('"山田, 花子"'); // カンマ含み → "" 囲み
    expect(lines[1]).toContain('U1');
    expect(lines[1]).toContain('はい'); // is_following=1
    expect(lines[1]).toContain('42');
    expect(lines[1]).toContain('VIP;新規');
    expect(text).not.toContain('別アカ'); // acc-2 は除外
    // account bind が WHERE に渡っている
    const q = calls.find((c) => /FROM friends f/i.test(c.sql));
    expect(q?.binds[0]).toBe('acc-1');
  });

  test('CSV injection (=HYPERLINK) を無害化する (HIGH-2)', async () => {
    const evil: FriendRow = {
      display_name: '=HYPERLINK("http://evil","x")', line_user_id: 'U9', is_following: 1, score: 0,
      created_at: '2026-01-01T00:00:00.000+09:00', tag_names: null, line_account_id: 'acc-1',
    };
    const { db } = makeExportDb({ friends: [evil] });
    const res = await setupApp(db).request('/api/exports/friends.csv?lineAccountId=acc-1', AUTH);
    const text = await res.text();
    expect(text).toContain('"\'=HYPERLINK('); // 先頭 ' 付き + "" 囲み
  });

  test('未認証は 401', async () => {
    const { db } = makeExportDb({ friends });
    const res = await setupApp(db).request('/api/exports/friends.csv?lineAccountId=acc-1');
    expect(res.status).toBe(401);
  });

  test('lineAccountId 未指定は 400', async () => {
    const { db } = makeExportDb({ friends });
    const res = await setupApp(db).request('/api/exports/friends.csv', AUTH);
    expect(res.status).toBe(400);
  });

  test('出力行が上限 (50,000) を超えると 400', async () => {
    const many: FriendRow[] = Array.from({ length: 50_001 }, (_, i) => ({
      display_name: '友', line_user_id: `UB${i}`, is_following: 1, score: 0,
      created_at: '2026-01-01T00:00:00.000+09:00', tag_names: null, line_account_id: 'acc-1',
    }));
    const { db } = makeExportDb({ friends: many });
    const res = await setupApp(db).request('/api/exports/friends.csv?lineAccountId=acc-1', AUTH);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('5万件');
    expect(body.error).toContain('絞り込み');
  });
});

describe('GET /api/exports/form-submissions.csv (T-C4)', () => {
  const forms = {
    'form-1': {
      id: 'form-1', name: '問診',
      fields: JSON.stringify([{ name: 'q1', label: 'お名前' }, { name: 'q2', label: 'ご要望' }]),
    },
  };
  const submissions: SubRow[] = [
    { data: JSON.stringify({ q1: '田中', q2: '=HYPERLINK("x")' }), created_at: '2026-02-01T00:00:00.000+09:00', friend_name: '田中', form_id: 'form-1', line_account_id: 'acc-1' },
    { data: JSON.stringify({ q1: '佐藤', q2: '無し' }), created_at: '2026-02-02T00:00:00.000+09:00', friend_name: '佐藤', form_id: 'form-1', line_account_id: 'acc-2' },
  ];

  test('BOM付き text/csv + 設問ラベル列展開 + injection 無害化 (account 未指定は全件)', async () => {
    const { db } = makeExportDb({ forms, submissions });
    const res = await setupApp(db).request('/api/exports/form-submissions.csv?formId=form-1', AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    const { hasBom, text } = await readCsv(res);
    expect(hasBom).toBe(true);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('回答日時,友だち表示名,お名前,ご要望');
    expect(text).toContain("'=HYPERLINK"); // injection 無害化
    expect(text).toContain('田中');
    expect(text).toContain('佐藤'); // account 未指定 → 両方
  });

  test('formId 未指定は 400', async () => {
    const { db } = makeExportDb({ forms, submissions });
    const res = await setupApp(db).request('/api/exports/form-submissions.csv', AUTH);
    expect(res.status).toBe(400);
  });

  test('存在しない formId は 404', async () => {
    const { db } = makeExportDb({ forms, submissions });
    const res = await setupApp(db).request('/api/exports/form-submissions.csv?formId=nope', AUTH);
    expect(res.status).toBe(404);
  });

  test('lineAccountId 指定で別 account の回答が混ざらない (HIGH-1 cross-account)', async () => {
    const { db, calls } = makeExportDb({ forms, submissions });
    const res = await setupApp(db).request('/api/exports/form-submissions.csv?formId=form-1&lineAccountId=acc-1', AUTH);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('田中'); // acc-1
    expect(text).not.toContain('佐藤'); // acc-2 除外
    const q = calls.find((c) => /FROM form_submissions fs/i.test(c.sql));
    expect(q?.sql).toMatch(/INNER JOIN friends/); // account scope は INNER JOIN
    expect(q?.binds).toContain('acc-1');
  });
});

describe('GET /api/exports/bookings.csv (T-C4)', () => {
  const bookings: BookingRow[] = [
    {
      starts_at: '2026-03-01T10:00:00Z', menu_name: 'カット', staff_name: '担当田中',
      friend_name: '山本', status: 'requested', created_at: '2026-02-28T00:00:00Z', line_account_id: 'acc-1',
    },
  ];

  test('BOM付き text/csv + 列見出し + ステータス日本語', async () => {
    const { db } = makeExportDb({ bookings });
    const res = await setupApp(db).request('/api/exports/bookings.csv?account_id=acc-1', AUTH);
    expect(res.status).toBe(200);
    const { hasBom, text } = await readCsv(res);
    expect(hasBom).toBe(true);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('予約日時,メニュー名,スタッフ名,友だち名,ステータス,作成日時');
    expect(lines[1]).toContain('カット');
    expect(lines[1]).toContain('担当田中');
    expect(lines[1]).toContain('山本');
    expect(lines[1]).toContain('承認待ち'); // requested → 日本語
  });

  test('account_id 未指定は 400', async () => {
    const { db } = makeExportDb({ bookings });
    const res = await setupApp(db).request('/api/exports/bookings.csv', AUTH);
    expect(res.status).toBe(400);
  });

  test('status で絞り込める', async () => {
    const { db } = makeExportDb({ bookings });
    const res = await setupApp(db).request('/api/exports/bookings.csv?account_id=acc-1&status=confirmed', AUTH);
    const { text } = await readCsv(res);
    const lines = text.split('\r\n').filter(Boolean);
    expect(lines.length).toBe(1); // header のみ (requested は confirmed で除外)
  });
});
