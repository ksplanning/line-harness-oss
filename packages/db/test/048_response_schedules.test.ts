/**
 * 048_response_schedules.sql (G28 応答時間帯) の additive 性 + スキーマ検証。
 *
 *   - checkMigration(048).ok === true (破壊操作ゼロ / additive-only 静的検査)
 *   - schema.sql replay に response_schedules 表 + 全列 + index が現れる
 *   - is_enabled 既定 0 (OFF = 非回帰) / outside_hours_mode / timezone の CHECK 制約
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION = join(PKG_ROOT, 'migrations', '048_response_schedules.sql');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

describe('048_response_schedules.sql', () => {
  it('passes the additive-only migration safety check', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(checkMigration(sql)).toEqual({ ok: true });
  });

  let db: Database.Database;
  beforeEach(() => {
    db = loadDb();
  });

  it('creates response_schedules with all 9 expected columns', () => {
    const rows = db.prepare("PRAGMA table_info('response_schedules')").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    const expected = [
      'id',
      'line_account_id',
      'is_enabled',
      'timezone',
      'outside_hours_mode',
      'away_message',
      'weekly_hours',
      'created_at',
      'updated_at',
    ].sort();
    expect(names).toEqual(expected);
  });

  it('defaults is_enabled to 0 (OFF = 非回帰) and weekly_hours to []', () => {
    db.prepare(`INSERT INTO response_schedules (id) VALUES ('rs-1')`).run();
    const row = db
      .prepare(`SELECT is_enabled, timezone, outside_hours_mode, weekly_hours FROM response_schedules WHERE id = 'rs-1'`)
      .get() as { is_enabled: number; timezone: string; outside_hours_mode: string; weekly_hours: string };
    expect(row.is_enabled).toBe(0);
    expect(row.timezone).toBe('Asia/Tokyo');
    expect(row.outside_hours_mode).toBe('auto_reply');
    expect(row.weekly_hours).toBe('[]');
  });

  it('rejects invalid outside_hours_mode via CHECK constraint', () => {
    expect(() =>
      db.prepare(`INSERT INTO response_schedules (id, outside_hours_mode) VALUES ('rs-bad', 'bogus')`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects non Asia/Tokyo timezone via CHECK constraint', () => {
    expect(() =>
      db.prepare(`INSERT INTO response_schedules (id, timezone) VALUES ('rs-tz', 'UTC')`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('creates idx_response_schedules_account index', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_response_schedules_account'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_response_schedules_account');
  });
});
