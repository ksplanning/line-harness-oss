/**
 * T-C7 / D-5 (F2 batch4 G17) — 期間限定リッチメニュー切替の dark-ship 検証。
 *  - isRichMenuScheduleEnabled: 'true' のみ有効 (既定 OFF)
 *  - computeScheduledMenuChanges: 決定論 (期間内→activate / 終了後→expire)
 *  - processRichMenuSchedule: switcher 未注入 = dark (switched 0・LINE を叩かない) / 注入時のみ切替が動く
 *  - wrangler.ks.toml crons=[] byte-identical (cron 発火なし)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  isRichMenuScheduleEnabled,
  computeScheduledMenuChanges,
  processRichMenuSchedule,
  type ScheduledMenuGroupRow,
} from './rich-menu-schedule.js';

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

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

const NOW = new Date('2026-07-15T00:00:00.000+09:00');

describe('isRichMenuScheduleEnabled (default OFF)', () => {
  test("only 'true' enables; undefined/'false'/'0'/'' stay dark", () => {
    expect(isRichMenuScheduleEnabled({})).toBe(false);
    expect(isRichMenuScheduleEnabled({ RICH_MENU_SCHEDULE_ENABLED: 'false' })).toBe(false);
    expect(isRichMenuScheduleEnabled({ RICH_MENU_SCHEDULE_ENABLED: '0' })).toBe(false);
    expect(isRichMenuScheduleEnabled({ RICH_MENU_SCHEDULE_ENABLED: '' })).toBe(false);
    expect(isRichMenuScheduleEnabled({ RICH_MENU_SCHEDULE_ENABLED: 'true' })).toBe(true);
  });
});

describe('computeScheduledMenuChanges (deterministic)', () => {
  const rows: ScheduledMenuGroupRow[] = [
    { id: 'in-window-draft', account_id: 'a', status: 'draft', schedule_start: '2026-07-10T00:00:00+09:00', schedule_end: '2026-07-20T00:00:00+09:00' },
    { id: 'expired-published', account_id: 'a', status: 'published', schedule_start: '2026-06-01T00:00:00+09:00', schedule_end: '2026-07-01T00:00:00+09:00' },
    { id: 'no-schedule', account_id: 'a', status: 'draft', schedule_start: null, schedule_end: null },
    { id: 'already-published-in-window', account_id: 'a', status: 'published', schedule_start: '2026-07-10T00:00:00+09:00', schedule_end: '2026-07-20T00:00:00+09:00' },
  ];

  test('in-window unpublished → activate; ended published → expire; no-op otherwise', () => {
    const changes = computeScheduledMenuChanges(rows, NOW);
    expect(changes).toContainEqual({ groupId: 'in-window-draft', accountId: 'a', action: 'activate' });
    expect(changes).toContainEqual({ groupId: 'expired-published', accountId: 'a', action: 'expire' });
    // no-schedule と already-published-in-window は変化なし。
    expect(changes.map((c) => c.groupId)).not.toContain('no-schedule');
    expect(changes.map((c) => c.groupId)).not.toContain('already-published-in-window');
  });

  test('same input reproduces same plan (deterministic)', () => {
    expect(computeScheduledMenuChanges(rows, NOW)).toEqual(computeScheduledMenuChanges(rows, NOW));
  });
});

describe('processRichMenuSchedule dark-ship', () => {
  let raw: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    raw = new Database(':memory:');
    replayAll(raw);
    db = d1(raw);
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('a','ch','a','t','s')`).run();
    raw.prepare(`INSERT INTO rich_menu_groups (id, account_id, name, chat_bar_text, size, status, schedule_start, schedule_end) VALUES ('g1','a','春','m','large','draft','2026-07-10T00:00:00+09:00','2026-07-20T00:00:00+09:00')`).run();
  });

  test('no switcher injected → dark (computes plan but switched=0, LINE not touched)', async () => {
    const r = await processRichMenuSchedule(db, { now: NOW });
    expect(r.changes).toContainEqual({ groupId: 'g1', accountId: 'a', action: 'activate' });
    expect(r.switched).toBe(0); // dark: 実切替は呼ばない
  });

  test('with switcher injected (flag ON simulation) → switch logic runs', async () => {
    const activated: string[] = [];
    const r = await processRichMenuSchedule(db, { now: NOW, onActivate: async (id) => { activated.push(id); } });
    expect(activated).toEqual(['g1']);
    expect(r.switched).toBe(1);
  });
});

describe('wrangler.ks.toml crons byte-identical (dark-ship)', () => {
  test('KS production crons is [] (cron never fires)', () => {
    const toml = readFileSync(join(__dirname, '../../wrangler.ks.toml'), 'utf8');
    expect(toml).toMatch(/crons\s*=\s*\[\s*\]/);
  });
});
