import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_127 = join(PKG_ROOT, 'migrations', '127_form_results_sync.sql');
const MIGRATION_128 = join(PKG_ROOT, 'migrations', '128_sheets_sync_jobs_target.sql');

let raw: Database.Database;

function migration(name: string): string {
  const path = join(PKG_ROOT, 'migrations', name);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function columns(table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE line_accounts (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    channel_access_token TEXT NOT NULL,
    channel_secret TEXT NOT NULL
  )`);
  for (const name of [
    '114_sheets_connections.sql',
    '119_friend_ledger_sync.sql',
    '120_form_answer_sheet_headers.sql',
    '125_sheets_connection_field_selection.sql',
    '126_sheets_sync_jobs.sql',
  ]) {
    raw.exec(migration(name));
  }
  raw.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
  raw.prepare(`INSERT INTO sheets_connections
    (id, line_account_id, form_id, spreadsheet_id, sheet_name,
     sync_direction, friend_ledger_enabled)
    VALUES ('connection-1', 'acc-1', 'form-1', 'sheet-1', '友だち台帳',
            'bidirectional', 1)`).run();
  raw.prepare(`INSERT INTO sheets_sync_ledger
    (connection_id, connection_version, record_key, sheet_row_number,
     row_fingerprint, last_synced_at, last_sync_direction,
     last_applied_sequence, canonical_snapshot_json)
    VALUES ('connection-1', 1, 'friend-1', 2, 'friend-fp',
            '2026-07-22T10:00:00.000+09:00', 'to_sheets', 1, '{}')`).run();
  raw.prepare(`INSERT INTO sheets_sync_webhook_events
    (connection_id, line_account_id, connection_version, event_id, actor, actor_kind,
     occurred_at, payload_json, available_at, received_at)
    VALUES ('connection-1', 'acc-1', 1, 'event-before-127', 'owner@example.test',
            'google_email', '2026-07-22T10:00:00.000+09:00', '{}',
            '2026-07-22T10:00:00.000+09:00', '2026-07-22T10:00:00.000+09:00')`).run();
  raw.prepare(`INSERT INTO sheets_sync_jobs
    (id, connection_id, line_account_id, config_version, source, actor)
    VALUES ('job-before-128', 'connection-1', 'acc-1', 1, 'manual', 'owner')`).run();
});

afterEach(() => raw.close());

describe('migrations 127 and 128 — split form results sheet', () => {
  test('upgrade from migration 126 preserves existing rows with legacy-safe defaults', () => {
    const connectionBefore = raw.prepare(
      `SELECT id, spreadsheet_id, sheet_name, friend_ledger_enabled
       FROM sheets_connections WHERE id = 'connection-1'`,
    ).get();
    const ledgerBefore = raw.prepare(
      `SELECT record_key, sheet_row_number, row_fingerprint
       FROM sheets_sync_ledger WHERE connection_id = 'connection-1'`,
    ).get();

    raw.exec(readFileSync(MIGRATION_127, 'utf8'));
    raw.exec(readFileSync(MIGRATION_128, 'utf8'));

    expect(columns('sheets_connections')).toEqual(expect.arrayContaining([
      'form_results_enabled',
      'form_results_sheet_name',
      'form_results_headers_json',
    ]));
    expect(columns('sheets_sync_webhook_events')).toContain('target');
    expect(columns('sheets_sync_jobs')).toContain('target');
    expect(raw.prepare(
      `SELECT id, spreadsheet_id, sheet_name, friend_ledger_enabled
       FROM sheets_connections WHERE id = 'connection-1'`,
    ).get()).toEqual(connectionBefore);
    expect(raw.prepare(
      `SELECT record_key, sheet_row_number, row_fingerprint
       FROM sheets_sync_ledger WHERE connection_id = 'connection-1'`,
    ).get()).toEqual(ledgerBefore);
    expect(raw.prepare(`SELECT form_results_enabled, form_results_sheet_name,
      form_results_headers_json FROM sheets_connections WHERE id = 'connection-1'`).get())
      .toEqual({
        form_results_enabled: 0,
        form_results_sheet_name: null,
        form_results_headers_json: '[]',
      });
    expect(raw.prepare(
      `SELECT target FROM sheets_sync_webhook_events WHERE event_id = 'event-before-127'`,
    ).get()).toEqual({ target: 'ledger' });
    expect(raw.prepare(
      `SELECT target FROM sheets_sync_jobs WHERE id = 'job-before-128'`,
    ).get()).toEqual({ target: 'ledger' });
  });

  test('keeps row numbers and one-running jobs unique inside each target', () => {
    raw.exec(readFileSync(MIGRATION_127, 'utf8'));
    raw.exec(readFileSync(MIGRATION_128, 'utf8'));

    expect(() => raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, sheet_row_number,
       row_fingerprint, last_synced_at, last_sync_direction,
       last_applied_sequence, canonical_snapshot_json)
      VALUES ('connection-1', 1, 'sub:submission-1', 2, 'submission-fp',
              '2026-07-22T10:01:00.000+09:00', 'to_sheets', 2, '{}')`).run())
      .not.toThrow();
    expect(() => raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, sheet_row_number,
       row_fingerprint, last_synced_at, last_sync_direction,
       last_applied_sequence, canonical_snapshot_json)
      VALUES ('connection-1', 1, 'sub:submission-2', 2, 'submission-fp-2',
              '2026-07-22T10:02:00.000+09:00', 'to_sheets', 3, '{}')`).run())
      .toThrow(/UNIQUE constraint failed/i);

    expect(() => raw.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, target)
      VALUES ('job-results', 'connection-1', 'acc-1', 1, 'manual', 'owner', 'form_results')`).run())
      .not.toThrow();
    expect(() => raw.prepare(`INSERT INTO sheets_sync_jobs
      (id, connection_id, line_account_id, config_version, source, actor, target)
      VALUES ('job-ledger-duplicate', 'connection-1', 'acc-1', 1, 'manual', 'owner', 'ledger')`).run())
      .toThrow(/UNIQUE constraint failed/i);
  });

  test('keeps additive safety, schema, bootstrap, and metadata aligned', () => {
    expect(checkMigration(readFileSync(MIGRATION_127, 'utf8'), MIGRATION_127)).toEqual({ ok: true });
    expect(checkMigration(readFileSync(MIGRATION_128, 'utf8'), MIGRATION_128)).toEqual({ ok: true });
    for (const file of ['schema.sql', 'bootstrap.sql']) {
      const sql = readFileSync(join(PKG_ROOT, file), 'utf8');
      expect(sql).toContain('form_results_enabled');
      expect(sql).toContain('form_results_sheet_name');
      expect(sql).toContain("target                     TEXT NOT NULL DEFAULT 'ledger'");
    }
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations?: string[];
      migrationCount?: number;
    };
    expect(meta.includedMigrations).toEqual(expect.arrayContaining([
      '127_form_results_sync.sql',
      '128_sheets_sync_jobs_target.sql',
    ]));
    expect(meta.migrationCount).toBe(meta.includedMigrations?.length);
  });
});
