import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '126_sheets_sync_jobs.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_NAME);

function migrationSql(): string | null {
  expect(existsSync(MIGRATION_PATH)).toBe(true);
  return existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : null;
}

function createSheetsFoundation(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE line_accounts (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    channel_access_token TEXT NOT NULL,
    channel_secret TEXT NOT NULL
  )`);
  for (const migration of [
    '114_sheets_connections.sql',
    '119_friend_ledger_sync.sql',
    '120_form_answer_sheet_headers.sql',
    '125_sheets_connection_field_selection.sql',
  ]) {
    db.exec(readFileSync(join(PKG_ROOT, 'migrations', migration), 'utf8'));
  }
  db.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
  db.prepare(`INSERT INTO sheets_connections
    (id, line_account_id, form_id, spreadsheet_id, sheet_name,
     sync_direction, conflict_policy, conflict_clock, config_version,
     friend_ledger_enabled, last_sync_status)
    VALUES ('connection-1', 'acc-1', 'form-1', 'sheet-1', '友だち台帳',
            'bidirectional', 'last_write_wins', 'server_sequence', 1, 1, 'success')`).run();
  db.prepare(`INSERT INTO sheets_sync_ledger
    (connection_id, connection_version, record_key, sheet_row_number,
     row_fingerprint, last_synced_at, last_sync_direction,
     last_applied_sequence, canonical_snapshot_json)
    VALUES ('connection-1', 1, 'friend-0001', 2,
            'fingerprint-before-126', '2026-07-22T10:00:00.000+09:00',
            'to_sheets', 1, '{"name":"既存"}')`).run();
  return db;
}

describe('migration 126 — resumable Sheets sync jobs', () => {
  test('is additive and leaves existing connection and fingerprint-ledger rows unchanged', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(checkMigration(sql, MIGRATION_PATH)).toEqual({ ok: true });
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);

    const db = createSheetsFoundation();
    const connectionBefore = db.prepare(
      `SELECT * FROM sheets_connections WHERE id = 'connection-1'`,
    ).get();
    const ledgerBefore = db.prepare(
      `SELECT * FROM sheets_sync_ledger
       WHERE connection_id = 'connection-1' AND record_key = 'friend-0001'`,
    ).get();

    db.exec(sql);

    expect(db.prepare(
      `SELECT * FROM sheets_connections WHERE id = 'connection-1'`,
    ).get()).toEqual(connectionBefore);
    expect(db.prepare(
      `SELECT * FROM sheets_sync_ledger
       WHERE connection_id = 'connection-1' AND record_key = 'friend-0001'`,
    ).get()).toEqual(ledgerBefore);
    db.close();
  });

  test('stores durable progress, cursor, result state, safe diagnostics, and lease CAS data', () => {
    const sql = migrationSql();
    if (!sql) return;
    const db = createSheetsFoundation();
    db.exec(sql);

    const columns = (db.prepare('PRAGMA table_info(sheets_sync_jobs)').all() as Array<{
      name: string;
    }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'id',
      'connection_id',
      'line_account_id',
      'config_version',
      'source',
      'actor',
      'status',
      'total_count',
      'processed_count',
      'last_record_key',
      'warning_message',
      'error_code',
      'error_message',
      'lock_token',
      'locked_until',
      'created_at',
      'updated_at',
      'completed_at',
    ]));

    db.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, status,
       total_count, processed_count, last_record_key, lock_token, locked_until)
      VALUES ('job-running', 'connection-1', 'acc-1', 1, 'manual', 'staff-1', 'running',
              1450, 400, 'friend-0400', 'lease-current', '2026-07-22T11:15:00.000+09:00')`).run();

    expect(db.prepare(`SELECT status, total_count, processed_count, last_record_key,
      warning_message, error_code, error_message, lock_token, locked_until
      FROM sheets_sync_jobs WHERE id = 'job-running'`).get()).toEqual({
      status: 'running',
      total_count: 1450,
      processed_count: 400,
      last_record_key: 'friend-0400',
      warning_message: null,
      error_code: null,
      error_message: null,
      lock_token: 'lease-current',
      locked_until: '2026-07-22T11:15:00.000+09:00',
    });

    const advanced = db.prepare(`UPDATE sheets_sync_jobs
      SET processed_count = 800, last_record_key = 'friend-0800',
          lock_token = NULL, locked_until = NULL
      WHERE id = 'job-running' AND status = 'running'
        AND processed_count = 400 AND last_record_key = 'friend-0400'
        AND lock_token = 'lease-current'`).run();
    expect(advanced.changes).toBe(1);
    const staleAdvance = db.prepare(`UPDATE sheets_sync_jobs
      SET processed_count = 1000, last_record_key = 'friend-1000'
      WHERE id = 'job-running' AND status = 'running'
        AND processed_count = 400 AND last_record_key = 'friend-0400'
        AND lock_token = 'lease-current'`).run();
    expect(staleAdvance.changes).toBe(0);
    expect(db.prepare(`SELECT processed_count, last_record_key
      FROM sheets_sync_jobs WHERE id = 'job-running'`).get()).toEqual({
      processed_count: 800,
      last_record_key: 'friend-0800',
    });

    const insertTerminal = db.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, status,
       total_count, processed_count, last_record_key,
       warning_message, error_code, error_message, completed_at)
      VALUES (?, 'connection-1', 'acc-1', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertTerminal.run(
      'job-completed', 'polling', 'system_poll', 'completed',
      1450, 1450, 'friend-1450', null, null, null, '2026-07-22T11:20:00.000+09:00',
    );
    insertTerminal.run(
      'job-warning', 'manual', 'staff-1', 'warning',
      1450, 1450, 'friend-1450', '一部の列は安全のため同期しませんでした', null, null,
      '2026-07-22T11:21:00.000+09:00',
    );
    insertTerminal.run(
      'job-failed', 'webhook', 'google-sheet', 'failed',
      1450, 800, 'friend-0800', null, 'google_sheets_unavailable', 'シートへの接続に失敗しました',
      '2026-07-22T11:22:00.000+09:00',
    );
    expect(db.prepare(`SELECT id, source, status, processed_count, warning_message,
      error_code, error_message FROM sheets_sync_jobs
      WHERE id IN ('job-completed', 'job-warning', 'job-failed') ORDER BY id`).all())
      .toEqual([
        {
          id: 'job-completed', source: 'polling', status: 'completed', processed_count: 1450,
          warning_message: null, error_code: null, error_message: null,
        },
        {
          id: 'job-failed', source: 'webhook', status: 'failed', processed_count: 800,
          warning_message: null, error_code: 'google_sheets_unavailable',
          error_message: 'シートへの接続に失敗しました',
        },
        {
          id: 'job-warning', source: 'manual', status: 'warning', processed_count: 1450,
          warning_message: '一部の列は安全のため同期しませんでした',
          error_code: null, error_message: null,
        },
      ]);

    expect(() => db.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, status,
       total_count, processed_count)
      VALUES ('job-running-duplicate', 'connection-1', 'acc-1', 1,
              'manual', 'staff-2', 'running', 1450, 0)`).run()).toThrow(/UNIQUE constraint failed/i);
    expect(() => db.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, status,
       total_count, processed_count, warning_message, completed_at)
      VALUES ('job-unsafe-warning', 'connection-1', 'acc-1', 1,
              'manual', 'staff-2', 'warning', 1, 1, ?,
              '2026-07-22T11:23:00.000+09:00')`).run('x'.repeat(501)))
      .toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, status,
       total_count, processed_count, error_code, error_message, completed_at)
      VALUES ('job-unsafe-error', 'connection-1', 'acc-1', 1,
              'manual', 'staff-2', 'failed', 1, 0, 'unsafe', ?,
              '2026-07-22T11:24:00.000+09:00')`).run('x'.repeat(501)))
      .toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`UPDATE sheets_sync_jobs
      SET processed_count = total_count + 1 WHERE id = 'job-running'`).run())
      .toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`UPDATE sheets_sync_jobs
      SET lock_token = 'orphan-lock', locked_until = NULL WHERE id = 'job-running'`).run())
      .toThrow(/CHECK constraint failed/i);

    const indexes = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'sheets_sync_jobs'`).all() as Array<{
        name: string;
        sql: string | null;
      }>;
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_sheets_sync_jobs_one_running' }),
    ]));
    expect(indexes.find((index) => index.name === 'idx_sheets_sync_jobs_one_running')?.sql)
      .toMatch(/UNIQUE[\s\S]*connection_id[\s\S]*WHERE\s+status\s*=\s*'running'/i);
    db.close();
  });

  test('keeps declarative schema, generated bootstrap, and migration metadata aligned', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sheets_sync_jobs/i);
    expect(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'))
      .toMatch(/CREATE TABLE IF NOT EXISTS sheets_sync_jobs/i);
    expect(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'))
      .toMatch(/CREATE TABLE sheets_sync_jobs/i);
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations?: string[];
      migrationCount?: number;
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
    expect(meta.migrationCount).toBe(meta.includedMigrations?.length);
  });
});
