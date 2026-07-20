import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', '114_sheets_connections.sql');

let raw: Database.Database;

function columns(db: Database.Database, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  // A real pre-114 starting point: migration 114 must create every contract itself.
  raw.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      channel_access_token TEXT NOT NULL,
      channel_secret TEXT NOT NULL
    );
    CREATE TABLE formaloo_forms (
      id TEXT PRIMARY KEY,
      gsheet_connected INTEGER NOT NULL DEFAULT 0,
      gsheet_url TEXT
    );
  `);
  if (existsSync(MIGRATION_PATH)) raw.exec(readFileSync(MIGRATION_PATH, 'utf8'));
});

afterEach(() => raw.close());

describe('migration 114 — self-hosted Google Sheets foundation', () => {
  test('114 migration exists and is additive-only', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sheets_connections/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sheets_sync_ledger/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sheets_sync_audit_log/i);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|RENAME|UPDATE|DELETE)\b/im);
    const executableSql = sql.replace(/^\s*--.*$/gm, '');
    expect(executableSql).not.toMatch(/\b113\b|internal_submissions/i);
  });

  test('creates connection settings, row ledger, and append-only audit contracts', () => {
    expect(columns(raw, 'sheets_connections')).toEqual([
      'id', 'line_account_id', 'form_id', 'spreadsheet_id', 'sheet_name',
      'sync_direction', 'conflict_policy', 'conflict_clock', 'config_version',
      'next_sync_sequence', 'is_active', 'created_at', 'updated_at', 'deleted_at',
    ]);
    expect(columns(raw, 'sheets_sync_ledger')).toEqual([
      'connection_id', 'connection_version', 'record_key', 'sheet_row_number', 'row_fingerprint',
      'harness_updated_at', 'sheet_observed_at', 'last_synced_at', 'last_sync_direction',
      'last_applied_sequence', 'version',
    ]);
    expect(columns(raw, 'sheets_sync_audit_log')).toEqual([
      'id', 'connection_id', 'connection_version', 'apply_sequence', 'line_account_id', 'form_id',
      'spreadsheet_id', 'sheet_name', 'record_key', 'sheet_row_number', 'direction',
      'action', 'outcome', 'conflict_resolution', 'harness_updated_at', 'sheet_observed_at',
      'before_fingerprint', 'after_fingerprint', 'error_code', 'created_at',
    ]);
    const auditColumns = raw.prepare('PRAGMA table_info(sheets_sync_audit_log)').all()
      .map((row) => (row as { name: string }).name);
    expect(auditColumns).not.toContain('updated_at');
  });

  test('makes audit rows immutable and keeps target snapshots after a LINE account is deleted', () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    raw.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name)
      VALUES ('connection-1', 'acc-1', 'form-1', 'sheet-1', '回答')`).run();
    raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, row_fingerprint, last_synced_at,
       last_sync_direction, last_applied_sequence)
      VALUES ('connection-1', 1, 'record-1', 'fingerprint-1', '2026-07-20T00:00:00+09:00',
              'to_sheets', 1)`).run();
    raw.prepare(`INSERT INTO sheets_sync_audit_log
      (id, connection_id, connection_version, apply_sequence, line_account_id, form_id, spreadsheet_id,
       sheet_name, direction, action, outcome)
      VALUES ('audit-1', 'connection-1', 1, 1, 'acc-1', 'form-1', 'sheet-1',
              '回答', 'to_sheets', 'append', 'applied')`).run();

    expect(() => raw.prepare(`UPDATE sheets_sync_audit_log SET outcome='failed' WHERE id='audit-1'`).run())
      .toThrow(/append-only/i);
    expect(() => raw.prepare(`DELETE FROM sheets_sync_audit_log WHERE id='audit-1'`).run())
      .toThrow(/append-only/i);
    expect(() => raw.prepare(`INSERT OR REPLACE INTO sheets_sync_audit_log
      (id, connection_id, connection_version, apply_sequence, line_account_id, form_id,
       spreadsheet_id, sheet_name, direction, action, outcome)
      VALUES ('audit-1', 'connection-1', 1, 2, 'acc-1', 'form-1',
              'tampered', '改ざん', 'to_sheets', 'update', 'failed')`).run())
      .toThrow(/append-only/i);
    expect(() => raw.prepare(`INSERT OR REPLACE INTO sheets_sync_audit_log
      (id, connection_id, connection_version, apply_sequence, line_account_id, form_id,
       spreadsheet_id, sheet_name, direction, action, outcome)
      VALUES ('audit-2', 'connection-1', 1, 1, 'acc-1', 'form-1',
              'tampered', '改ざん', 'to_sheets', 'update', 'failed')`).run())
      .toThrow(/append-only/i);
    expect(raw.prepare('SELECT id, spreadsheet_id FROM sheets_sync_audit_log').all())
      .toEqual([{ id: 'audit-1', spreadsheet_id: 'sheet-1' }]);
    expect(() => raw.prepare(`DELETE FROM line_accounts WHERE id='acc-1'`).run()).not.toThrow();
    expect(raw.prepare('SELECT line_account_id, is_active, deleted_at FROM sheets_connections WHERE id=?').get('connection-1'))
      .toMatchObject({ line_account_id: null, is_active: 0, deleted_at: expect.any(String) });
    expect(raw.prepare('SELECT spreadsheet_id, sheet_name FROM sheets_sync_audit_log WHERE id=?').get('audit-1'))
      .toEqual({ spreadsheet_id: 'sheet-1', sheet_name: '回答' });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_ledger WHERE connection_id=?').get('connection-1'))
      .toEqual({ count: 0 });
  });

  test('defines last-write-wins by server apply sequence instead of unreliable cross-system clocks', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toContain("DEFAULT 'server_sequence'");
    expect(sql).toContain('next_sync_sequence');
    expect(sql).toContain('last_applied_sequence');
    expect(sql).toContain('apply_sequence');
    expect(sql).toMatch(/observation time[\s\S]+never used as the conflict clock/i);
    expect(sql).not.toContain('sheet_timestamp_column');
  });

  test('rejects stale ledger writes whose version no longer matches the active connection', () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    raw.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name, config_version)
      VALUES ('connection-1', 'acc-1', 'form-1', 'sheet-1', '回答', 2)`).run();
    const insert = raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, row_fingerprint, last_synced_at,
       last_sync_direction, last_applied_sequence)
      VALUES ('connection-1', ?, 'record-1', 'fingerprint-1', '2026-07-20T00:00:00+09:00',
              'to_sheets', 1)`);
    expect(() => insert.run(1)).toThrow(/connection version/i);
    expect(() => insert.run(2)).not.toThrow();
    expect(() => raw.prepare(`UPDATE sheets_sync_ledger SET connection_version=1
      WHERE connection_id='connection-1' AND record_key='record-1'`).run()).toThrow(/connection version/i);
  });

  test('enforces direction and last-write-wins policy at the database boundary', () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    const insert = raw.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name, sync_direction, conflict_policy)
      VALUES (?, 'acc-1', 'form-1', 'sheet-1', '回答', ?, ?)`);
    expect(() => insert.run('bad-direction', 'sideways', 'last_write_wins')).toThrow(/CHECK constraint failed/i);
    expect(() => insert.run('bad-policy', 'bidirectional', 'manual')).toThrow(/CHECK constraint failed/i);
    insert.run('valid', 'bidirectional', 'last_write_wins');
    expect(raw.prepare('SELECT sync_direction, conflict_policy FROM sheets_connections WHERE id=?').get('valid'))
      .toEqual({ sync_direction: 'bidirectional', conflict_policy: 'last_write_wins' });
  });

  test('permits only one active connection per LINE account and form, but preserves soft-deleted history', () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    const insert = raw.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name)
      VALUES (?, 'acc-1', 'form-1', ?, '回答')`);
    insert.run('first', 'sheet-1');
    expect(() => insert.run('duplicate', 'sheet-2')).toThrow(/UNIQUE constraint failed/i);
    raw.prepare(`UPDATE sheets_connections SET is_active=0, deleted_at='2026-07-20T00:00:00+09:00' WHERE id='first'`).run();
    expect(() => insert.run('replacement', 'sheet-2')).not.toThrow();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_connections').get()).toEqual({ count: 2 });
  });

  test('does not modify the existing Formaloo-native Sheets schema', () => {
    const formalooColumns = columns(raw, 'formaloo_forms');
    expect(formalooColumns).toContain('gsheet_connected');
    expect(formalooColumns).toContain('gsheet_url');
    expect(formalooColumns).not.toContain('spreadsheet_id');
  });

  test('schema.sql and generated bootstrap expose the same three-table contract', () => {
    for (const file of ['schema.sql', 'bootstrap.sql']) {
      const sql = readFileSync(join(PKG_ROOT, file), 'utf8');
      expect(sql).toContain('sheets_connections');
      expect(sql).toContain('sheets_sync_ledger');
      expect(sql).toContain('sheets_sync_audit_log');
      expect(sql).toContain('last_write_wins');
    }
  });
});
