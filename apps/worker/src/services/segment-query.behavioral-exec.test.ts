/**
 * T-C4 / D-2 (F2 batch4 G11) — 行動 rule の EXISTS を実 SQLite で実行し、絞り込みと cross-account
 * 非漏洩・Flex postback 非混入を「実データ」で証明する (pure SQL 構造テストの上位証明)。
 *
 * seed: acc-1 に friends fA(クリック済)/fB(未)/fC(acc-1 の menu タップ済)/fD(Flex postback だが
 *       menu 非該当)/fE(フォーム開封) + acc-2 に fZ(acc-2 の menu タップ済 = 別 account)。
 * 検証: account scope (f.line_account_id = acc-1) と AND した時、acc-2 の fZ が漏れない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { buildSegmentWhere } from './segment-query.js';
import type { SegmentCondition } from './segment-query.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

const NOW = new Date('2026-07-04T03:00:00.000Z'); // JST 2026-07-04T12:00
const RECENT = '2026-07-01T10:00:00.000+09:00';   // 過去 30 日以内

/** account scope と AND 合成して friend id 集合を返す (segment-send / friends route の合成形)。 */
function matchedFriendIds(db: Database.Database, accountId: string, cond: SegmentCondition): string[] {
  const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
  const rows = db.prepare(`SELECT f.id FROM friends f WHERE f.line_account_id = ? AND ${clause}`).all(accountId, ...(bindings as never[])) as { id: string }[];
  return rows.map((r) => r.id).sort();
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  replayAll(db);
  for (const a of ['acc-1', 'acc-2']) {
    db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run(a, `ch-${a}`, a, 'tok', 'sec');
  }
  const friends: [string, string, string][] = [
    ['fA', 'uA', 'acc-1'], ['fB', 'uB', 'acc-1'], ['fC', 'uC', 'acc-1'],
    ['fD', 'uD', 'acc-1'], ['fE', 'uE', 'acc-1'], ['fZ', 'uZ', 'acc-2'],
  ];
  for (const [id, u, acc] of friends) {
    db.prepare(`INSERT INTO friends (id, line_user_id, line_account_id) VALUES (?,?,?)`).run(id, u, acc);
  }
  // click by fA (acc-1). link_clicks.friend_id 経由で account に紐付く (tracked_links は account 列なし)。
  db.prepare(`INSERT INTO tracked_links (id, name, original_url) VALUES ('tl-1','L','https://x')`).run();
  db.prepare(`INSERT INTO link_clicks (id, tracked_link_id, friend_id, clicked_at) VALUES ('lc1','tl-1','fA',?)`).run(RECENT);
  // rich menu group g1 (acc-1) with a postback area data='menu_shop'
  db.prepare(`INSERT INTO rich_menu_groups (id, account_id, name, chat_bar_text, size) VALUES ('g1','acc-1','春','メニュー','large')`).run();
  db.prepare(`INSERT INTO rich_menu_pages (id, group_id, order_index, name, alias_id) VALUES ('p1','g1',0,'P','a1')`).run();
  db.prepare(`INSERT INTO rich_menu_areas (id, page_id, bounds_x, bounds_y, bounds_width, bounds_height, action_type, action_data) VALUES ('ar1','p1',0,0,100,100,'postback',?)`).run(JSON.stringify({ type: 'postback', data: 'menu_shop' }));
  // group g2 (acc-2) with postback data='menu_shop' too (same string, different account)
  db.prepare(`INSERT INTO rich_menu_groups (id, account_id, name, chat_bar_text, size) VALUES ('g2','acc-2','別','メニュー','large')`).run();
  db.prepare(`INSERT INTO rich_menu_pages (id, group_id, order_index, name, alias_id) VALUES ('p2','g2',0,'P','a2')`).run();
  db.prepare(`INSERT INTO rich_menu_areas (id, page_id, bounds_x, bounds_y, bounds_width, bounds_height, action_type, action_data) VALUES ('ar2','p2',0,0,100,100,'postback',?)`).run(JSON.stringify({ type: 'postback', data: 'menu_shop' }));
  // fC tapped g1's menu (acc-1 postback content='menu_shop')
  db.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at) VALUES ('m1','fC','incoming','text','menu_shop','postback','acc-1',?)`).run(RECENT);
  // fD fired a Flex postback with a DIFFERENT content (not in g1's action_data) → must NOT match tapped_menu(g1)
  db.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at) VALUES ('m2','fD','incoming','text','flex_btn_xyz','postback','acc-1',?)`).run(RECENT);
  // fZ (acc-2) tapped g2's menu with content='menu_shop' under acc-2 → must NOT leak into acc-1 query
  db.prepare(`INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_account_id, created_at) VALUES ('m3','fZ','incoming','text','menu_shop','postback','acc-2',?)`).run(RECENT);
  // fE opened a form
  db.prepare(`INSERT INTO form_opens (id, form_id, friend_id, opened_at) VALUES ('fo1','form-1','fE',?)`).run(RECENT);
});

describe('clicked_link execution', () => {
  test('matches only friends who clicked within the window (account-scoped)', () => {
    const ids = matchedFriendIds(db, 'acc-1', { operator: 'AND', rules: [{ type: 'clicked_link', value: { sinceDays: 30 } }] });
    expect(ids).toEqual(['fA']);
  });
});

describe('opened_form execution', () => {
  test('matches only friends who opened a form', () => {
    const ids = matchedFriendIds(db, 'acc-1', { operator: 'AND', rules: [{ type: 'opened_form', value: { sinceDays: 30 } }] });
    expect(ids).toEqual(['fE']);
  });
});

describe('tapped_menu execution (Flex postback exclusion + cross-account non-leak)', () => {
  test('matches only friends who tapped the specific group menu (not Flex postback with other content)', () => {
    const ids = matchedFriendIds(db, 'acc-1', { operator: 'AND', rules: [{ type: 'tapped_menu', value: { groupId: 'g1', sinceDays: 30 } }] });
    expect(ids).toEqual(['fC']); // fD's flex_btn_xyz not in g1's action_data → excluded
  });

  test('acc-2 friend (fZ) with same postback content does NOT leak into acc-1 query (D-2 cross-account)', () => {
    const ids = matchedFriendIds(db, 'acc-1', { operator: 'AND', rules: [{ type: 'tapped_menu', value: { groupId: 'g1', sinceDays: 30 } }] });
    expect(ids).not.toContain('fZ');
  });

  test('querying acc-2 with acc-2 group g2 finds fZ (scope symmetric)', () => {
    const ids = matchedFriendIds(db, 'acc-2', { operator: 'AND', rules: [{ type: 'tapped_menu', value: { groupId: 'g2', sinceDays: 30 } }] });
    expect(ids).toEqual(['fZ']);
  });
});
