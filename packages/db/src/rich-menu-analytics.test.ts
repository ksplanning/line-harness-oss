/**
 * rich-menu-analytics.ts (G58 タップ数分析) の集計正しさ (real SQLite / schema replay)。
 *
 * 計測正しさ (T-C4 / A6):
 *   - DB 行単位の二重計上防止 (同一 ml.id を 1 回・COUNT DISTINCT)
 *   - JST 半開区間 (>= startT00:00 AND < nextDayT00:00・境界日/ミリ秒付きデータ)
 *   - area 帰属は選択 group 内で action_data(data) が一意な場合のみ
 *     (同一 data 複数 area / 別 group 同一 data / 非メニュー postback を誤帰属しない)
 *   - URI/message は数えない (postback系のみ)
 *   - 別 account の postback を混ぜない
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  attributeTaps,
  addOneDayJst,
  extractPostbackData,
  getRichMenuTapAnalytics,
  type TapAnalyticsArea,
} from './rich-menu-analytics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (s.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: s.all(...(params as never[])) as T[] };
        },
        async run() {
          const info = s.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

describe('addOneDayJst', () => {
  test('adds one day across month/year boundaries', () => {
    expect(addOneDayJst('2026-03-01')).toBe('2026-03-02');
    expect(addOneDayJst('2026-03-31')).toBe('2026-04-01');
    expect(addOneDayJst('2026-12-31')).toBe('2027-01-01');
    expect(addOneDayJst('2024-02-28')).toBe('2024-02-29'); // 閏年
  });
});

describe('extractPostbackData', () => {
  test('returns data string or null', () => {
    expect(extractPostbackData({ data: 'action=buy' })).toBe('action=buy');
    expect(extractPostbackData({ uri: 'https://x.com' })).toBeNull();
    expect(extractPostbackData({ data: 123 })).toBeNull();
  });
});

function area(overrides: Partial<TapAnalyticsArea> & Pick<TapAnalyticsArea, 'areaId'>): TapAnalyticsArea {
  return {
    pageId: 'pg-1',
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'postback',
    actionData: { data: 'x' },
    ...overrides,
  };
}

describe('attributeTaps (pure attribution logic)', () => {
  test('attributes taps to a uniquely-keyed postback area', () => {
    const areas = [
      area({ areaId: 'a1', actionData: { data: 'buy' } }),
      area({ areaId: 'a2', actionData: { data: 'contact' } }),
    ];
    const res = attributeTaps(areas, new Map([['buy', 5], ['contact', 3]]));
    const a1 = res.areas.find((a) => a.areaId === 'a1')!;
    expect(a1.count).toBe(5);
    expect(a1.measurable).toBe(true);
    expect(res.totalTaps).toBe(8);
    expect(res.unattributedCount).toBe(0);
  });

  test('does NOT attribute when the same data appears in multiple areas (ambiguous → 領域不明)', () => {
    const areas = [
      area({ areaId: 'a1', actionData: { data: 'same' } }),
      area({ areaId: 'a2', actionData: { data: 'same' } }),
    ];
    const res = attributeTaps(areas, new Map([['same', 10]]));
    for (const a of res.areas) {
      expect(a.count).toBeNull();
      expect(a.measurable).toBe(false);
      expect(a.unmeasurableReason).toBe('ambiguous');
    }
    // 集計主軸 (data 別) には出るが area 帰属できず全部「領域不明」。
    expect(res.totalTaps).toBe(10);
    expect(res.unattributedCount).toBe(10);
  });

  test('URI/message areas are not counted (non-postback)', () => {
    const areas = [
      area({ areaId: 'u1', actionType: 'uri', actionData: { uri: 'https://x.com' } }),
      area({ areaId: 'm1', actionType: 'message', actionData: { text: 'hi' } }),
      area({ areaId: 'p1', actionType: 'postback', actionData: { data: 'buy' } }),
    ];
    const res = attributeTaps(areas, new Map([['buy', 4]]));
    expect(res.areas.find((a) => a.areaId === 'u1')!.count).toBeNull();
    expect(res.areas.find((a) => a.areaId === 'u1')!.unmeasurableReason).toBe('non-postback');
    expect(res.areas.find((a) => a.areaId === 'm1')!.count).toBeNull();
    expect(res.areas.find((a) => a.areaId === 'p1')!.count).toBe(4);
  });
});

// ---- SQL 側 (期間フィルタ / DISTINCT / account / group 照合) ----

let raw: Database.Database;
let db: D1Database;

function seedAccountFriend(accountId: string, friendId: string, lineUserId: string) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run(accountId, `ch-${accountId}`, accountId, 'tok', 'sec');
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name) VALUES (?,?,?)`).run(friendId, lineUserId, 'F');
}

function seedGroupWithAreas(accountId: string, groupId: string, areas: Array<{ id: string; type: string; data: Record<string, unknown> }>) {
  raw.prepare(`INSERT INTO rich_menu_groups (id, account_id, name, chat_bar_text, size) VALUES (?,?,?,?,?)`).run(groupId, accountId, 'G', 'menu', 'large');
  raw.prepare(`INSERT INTO rich_menu_pages (id, group_id, order_index, name, alias_id) VALUES (?,?,?,?,?)`).run(`${groupId}-pg`, groupId, 0, 'p', `${groupId}-alias`);
  for (const a of areas) {
    raw.prepare(`INSERT INTO rich_menu_areas (id, page_id, bounds_x, bounds_y, bounds_width, bounds_height, action_type, action_data) VALUES (?,?,?,?,?,?,?,?)`)
      .run(a.id, `${groupId}-pg`, 0, 0, 100, 100, a.type, JSON.stringify(a.data));
  }
}

function seedPostbackTap(id: string, friendId: string, accountId: string, content: string, createdAt: string) {
  raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, friendId, 'incoming', 'text', content, 'postback', accountId, createdAt);
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  // schema.sql は line_account_id を broadcasts に持たないが、messages_log は既に持つ (schema.sql:180)。
  // friends は schema.sql に line_account_id を持たないので friend は line_user_id で作る。
  db = d1(raw);
});

describe('getRichMenuTapAnalytics (SQL: period / DISTINCT / account / group)', () => {
  test('counts postback taps within the JST half-open interval; excludes out-of-range', async () => {
    seedAccountFriend('acc-1', 'f-1', 'U1');
    seedGroupWithAreas('acc-1', 'g-1', [{ id: 'ar-1', type: 'postback', data: { data: 'buy' } }]);
    // 期間 2026-03-01 〜 2026-03-01 (単日) の半開区間 = [T00:00:00, 2026-03-02T00:00:00)
    seedPostbackTap('m-1', 'f-1', 'acc-1', 'buy', '2026-03-01T00:00:00.000'); // 含む (境界 start)
    seedPostbackTap('m-2', 'f-1', 'acc-1', 'buy', '2026-03-01T23:59:59.999'); // 含む (ミリ秒付き)
    seedPostbackTap('m-3', 'f-1', 'acc-1', 'buy', '2026-03-02T00:00:00.000'); // 除外 (翌日 00:00 = 上限は排他)
    seedPostbackTap('m-4', 'f-1', 'acc-1', 'buy', '2026-02-28T23:59:59.999'); // 除外 (前日)

    const res = await getRichMenuTapAnalytics(db, { groupId: 'g-1', accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-01' });
    expect(res.areas.find((a) => a.areaId === 'ar-1')!.count).toBe(2);
    expect(res.totalTaps).toBe(2);
  });

  test('does NOT double-count the same ml.id (COUNT DISTINCT) — but distinct rows count separately', async () => {
    seedAccountFriend('acc-1', 'f-1', 'U1');
    seedGroupWithAreas('acc-1', 'g-1', [{ id: 'ar-1', type: 'postback', data: { data: 'buy' } }]);
    seedPostbackTap('m-1', 'f-1', 'acc-1', 'buy', '2026-03-01T10:00:00.000');
    seedPostbackTap('m-2', 'f-1', 'acc-1', 'buy', '2026-03-01T11:00:00.000');
    const res = await getRichMenuTapAnalytics(db, { groupId: 'g-1', accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-01' });
    // 2 つの別 ml.id = 2 回 (別行の重複は保証外・DB 行単位では正しく 2)。
    expect(res.areas.find((a) => a.areaId === 'ar-1')!.count).toBe(2);
  });

  test('excludes taps from another account (no cross-account mixing)', async () => {
    seedAccountFriend('acc-1', 'f-1', 'U1');
    seedAccountFriend('acc-2', 'f-2', 'U2');
    seedGroupWithAreas('acc-1', 'g-1', [{ id: 'ar-1', type: 'postback', data: { data: 'buy' } }]);
    seedPostbackTap('m-1', 'f-1', 'acc-1', 'buy', '2026-03-01T10:00:00.000');
    seedPostbackTap('m-2', 'f-2', 'acc-2', 'buy', '2026-03-01T10:00:00.000'); // 別 account
    const res = await getRichMenuTapAnalytics(db, { groupId: 'g-1', accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-01' });
    expect(res.areas.find((a) => a.areaId === 'ar-1')!.count).toBe(1);
    expect(res.totalTaps).toBe(1);
  });

  test('does not attribute a postback whose data matches a DIFFERENT group / non-menu postback', async () => {
    seedAccountFriend('acc-1', 'f-1', 'U1');
    // group g-1 は data='buy' のみ。data='flex-btn' はメニュー外 (Flex ボタン等) の postback。
    seedGroupWithAreas('acc-1', 'g-1', [{ id: 'ar-1', type: 'postback', data: { data: 'buy' } }]);
    seedPostbackTap('m-1', 'f-1', 'acc-1', 'buy', '2026-03-01T10:00:00.000');
    seedPostbackTap('m-2', 'f-1', 'acc-1', 'flex-btn', '2026-03-01T10:05:00.000'); // group 外 data
    const res = await getRichMenuTapAnalytics(db, { groupId: 'g-1', accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-01' });
    // group の data 集合 (buy) に一致するもののみ集計 = flex-btn は入らない。
    expect(res.totalTaps).toBe(1);
    expect(res.byPostbackData).toEqual([{ data: 'buy', count: 1 }]);
  });

  test('ambiguous data (same in 2 areas of the group) goes to 領域不明, not to an area', async () => {
    seedAccountFriend('acc-1', 'f-1', 'U1');
    seedGroupWithAreas('acc-1', 'g-1', [
      { id: 'ar-1', type: 'postback', data: { data: 'same' } },
      { id: 'ar-2', type: 'postback', data: { data: 'same' } },
    ]);
    seedPostbackTap('m-1', 'f-1', 'acc-1', 'same', '2026-03-01T10:00:00.000');
    seedPostbackTap('m-2', 'f-1', 'acc-1', 'same', '2026-03-01T11:00:00.000');
    const res = await getRichMenuTapAnalytics(db, { groupId: 'g-1', accountId: 'acc-1', startDate: '2026-03-01', endDate: '2026-03-01' });
    expect(res.areas.find((a) => a.areaId === 'ar-1')!.count).toBeNull();
    expect(res.areas.find((a) => a.areaId === 'ar-2')!.count).toBeNull();
    expect(res.totalTaps).toBe(2);
    expect(res.unattributedCount).toBe(2); // どちらの area か復元不能 → 領域不明
  });
});
