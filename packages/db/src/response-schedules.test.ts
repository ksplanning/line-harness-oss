/**
 * response-schedules.ts (G28) の db helper 検証 (real SQLite / schema replay)。
 *
 *   - upsert→get で isEnabled/timezone/outsideHoursMode/awayMessage/weeklyHours(JSON) 全 round-trip
 *   - weeklyHours JSON 配列の保全
 *   - 同一 account で二度 upsert しても 1 行維持 (多重行にならない)
 *   - account 別行と NULL 既定行が分離
 *   - getEffectiveResponseSchedule = account-specific 優先・無ければ NULL 既定へ fallback
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  getResponseSchedule,
  getEffectiveResponseSchedule,
  upsertResponseSchedule,
} from './response-schedules.js';

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
          s.run(...(params as never[]));
          return {};
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db = d1(raw);
});

const WEEKLY = [
  { day: 1, closed: false, open: '09:00', close: '18:00' },
  { day: 0, closed: true, open: '', close: '' },
];

describe('response-schedules helper', () => {
  test('upsert→get round-trips every field including weeklyHours JSON', async () => {
    await upsertResponseSchedule(db, {
      lineAccountId: 'acc-1',
      isEnabled: true,
      outsideHoursMode: 'away_message',
      awayMessage: 'ただいま営業時間外です',
      weeklyHours: WEEKLY,
    });

    const got = await getResponseSchedule(db, 'acc-1');
    expect(got).not.toBeNull();
    expect(got!.lineAccountId).toBe('acc-1');
    expect(got!.isEnabled).toBe(true);
    expect(got!.timezone).toBe('Asia/Tokyo');
    expect(got!.outsideHoursMode).toBe('away_message');
    expect(got!.awayMessage).toBe('ただいま営業時間外です');
    expect(got!.weeklyHours).toEqual(WEEKLY);
  });

  test('returns null when no row exists for the account', async () => {
    expect(await getResponseSchedule(db, 'acc-x')).toBeNull();
  });

  test('twice upsert for the same account keeps exactly one row', async () => {
    await upsertResponseSchedule(db, {
      lineAccountId: 'acc-1',
      isEnabled: false,
      outsideHoursMode: 'auto_reply',
      awayMessage: null,
      weeklyHours: [],
    });
    await upsertResponseSchedule(db, {
      lineAccountId: 'acc-1',
      isEnabled: true,
      outsideHoursMode: 'none',
      awayMessage: null,
      weeklyHours: WEEKLY,
    });

    const count = raw
      .prepare(`SELECT COUNT(*) AS c FROM response_schedules WHERE line_account_id = 'acc-1'`)
      .get() as { c: number };
    expect(count.c).toBe(1);

    const got = await getResponseSchedule(db, 'acc-1');
    expect(got!.isEnabled).toBe(true);
    expect(got!.outsideHoursMode).toBe('none');
    expect(got!.weeklyHours).toEqual(WEEKLY);
  });

  test('account-specific row and NULL global row are separate', async () => {
    await upsertResponseSchedule(db, {
      lineAccountId: 'acc-1',
      isEnabled: true,
      outsideHoursMode: 'auto_reply',
      awayMessage: null,
      weeklyHours: WEEKLY,
    });
    await upsertResponseSchedule(db, {
      lineAccountId: null,
      isEnabled: false,
      outsideHoursMode: 'none',
      awayMessage: null,
      weeklyHours: [],
    });

    const acc = await getResponseSchedule(db, 'acc-1');
    const global = await getResponseSchedule(db, null);
    expect(acc!.isEnabled).toBe(true);
    expect(global!.isEnabled).toBe(false);
    expect(global!.lineAccountId).toBeNull();

    const count = raw.prepare(`SELECT COUNT(*) AS c FROM response_schedules`).get() as { c: number };
    expect(count.c).toBe(2);
  });

  test('getEffectiveResponseSchedule prefers account row, falls back to NULL global', async () => {
    await upsertResponseSchedule(db, {
      lineAccountId: null,
      isEnabled: true,
      outsideHoursMode: 'away_message',
      awayMessage: 'global away',
      weeklyHours: WEEKLY,
    });

    // No account-specific row yet → falls back to the global NULL row.
    const fallback = await getEffectiveResponseSchedule(db, 'acc-1');
    expect(fallback!.lineAccountId).toBeNull();
    expect(fallback!.awayMessage).toBe('global away');

    // Add account-specific row → it wins over the global.
    await upsertResponseSchedule(db, {
      lineAccountId: 'acc-1',
      isEnabled: true,
      outsideHoursMode: 'none',
      awayMessage: null,
      weeklyHours: [],
    });
    const specific = await getEffectiveResponseSchedule(db, 'acc-1');
    expect(specific!.lineAccountId).toBe('acc-1');
    expect(specific!.outsideHoursMode).toBe('none');
  });
});
