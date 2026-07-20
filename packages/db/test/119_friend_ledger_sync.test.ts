import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_114_PATH = join(PKG_ROOT, 'migrations', '114_sheets_connections.sql');
const MIGRATION_119_PATH = join(PKG_ROOT, 'migrations', '119_friend_ledger_sync.sql');

let raw: Database.Database;

function columns(db: Database.Database, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
}

function requireMigration119(): string {
  expect(existsSync(MIGRATION_119_PATH)).toBe(true);
  return existsSync(MIGRATION_119_PATH) ? readFileSync(MIGRATION_119_PATH, 'utf8') : '';
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      channel_access_token TEXT NOT NULL,
      channel_secret TEXT NOT NULL
    );
  `);
  raw.exec(readFileSync(MIGRATION_114_PATH, 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
  raw.prepare(`INSERT INTO sheets_connections
    (id, line_account_id, form_id, spreadsheet_id, sheet_name)
    VALUES ('connection-1', 'acc-1', 'friends', 'sheet-1', '友だち台帳')`).run();
  raw.prepare(`INSERT INTO sheets_sync_ledger
    (connection_id, connection_version, record_key, sheet_row_number, row_fingerprint,
     harness_updated_at, sheet_observed_at, last_synced_at, last_sync_direction,
     last_applied_sequence)
    VALUES ('connection-1', 1, 'friend-1', 2, 'fingerprint-before-119',
            '2026-07-21T09:00:00+09:00', '2026-07-21T09:00:01+09:00',
            '2026-07-21T09:00:02+09:00', 'to_sheets', 1)`).run();
  raw.prepare(`INSERT INTO sheets_sync_audit_log
    (id, connection_id, connection_version, apply_sequence, line_account_id, form_id,
     spreadsheet_id, sheet_name, record_key, sheet_row_number, direction, action, outcome)
    VALUES ('audit-1', 'connection-1', 1, 1, 'acc-1', 'friends',
            'sheet-1', '友だち台帳', 'friend-1', 2, 'to_sheets', 'append', 'applied')`).run();

  if (existsSync(MIGRATION_119_PATH)) raw.exec(readFileSync(MIGRATION_119_PATH, 'utf8'));
});

afterEach(() => raw.close());

describe('migration 119 — friend ledger bidirectional sync contracts', () => {
  test('is the only migration that extends the landed 114 foundation', () => {
    const sql = requireMigration119();
    const foundation = readFileSync(MIGRATION_114_PATH, 'utf8');

    for (const additiveColumn of [
      'friend_field_mappings_json',
      'last_sync_status',
      'canonical_snapshot_json',
      'sheets_sync_audit_details',
    ]) {
      expect(foundation).not.toContain(additiveColumn);
      expect(sql).toContain(additiveColumn);
    }
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i);
    expect(sql).not.toMatch(/\bRENAME\s+COLUMN\b/i);
  });

  test('adds mapping snapshots, observable status, and an expiring sync lock without breaking existing rows', () => {
    requireMigration119();

    expect(columns(raw, 'sheets_connections')).toEqual(expect.arrayContaining([
      'friend_field_mappings_json',
      'last_sync_at',
      'last_sync_status',
      'last_sync_warning',
      'last_sync_error_code',
      'sync_lock_token',
      'sync_lock_expires_at',
    ]));
    expect(raw.prepare(`SELECT friend_field_mappings_json, last_sync_at, last_sync_status,
      last_sync_warning, last_sync_error_code, sync_lock_token, sync_lock_expires_at
      FROM sheets_connections WHERE id = 'connection-1'`).get()).toEqual({
      friend_field_mappings_json: '[]',
      last_sync_at: null,
      last_sync_status: 'idle',
      last_sync_warning: null,
      last_sync_error_code: null,
      sync_lock_token: null,
      sync_lock_expires_at: null,
    });

    expect(() => raw.prepare(`UPDATE sheets_connections
      SET friend_field_mappings_json = '{}' WHERE id = 'connection-1'`).run()).toThrow(/CHECK constraint failed/i);
    expect(() => raw.prepare(`UPDATE sheets_connections
      SET last_sync_status = 'pretend-success' WHERE id = 'connection-1'`).run()).toThrow(/CHECK constraint failed/i);
  });

  test('adds a canonical object snapshot to every existing ledger row', () => {
    requireMigration119();

    expect(columns(raw, 'sheets_sync_ledger')).toContain('canonical_snapshot_json');
    expect(raw.prepare(`SELECT canonical_snapshot_json FROM sheets_sync_ledger
      WHERE connection_id = 'connection-1' AND record_key = 'friend-1'`).get())
      .toEqual({ canonical_snapshot_json: '{}' });
    expect(() => raw.prepare(`UPDATE sheets_sync_ledger SET canonical_snapshot_json = '[]'
      WHERE connection_id = 'connection-1' AND record_key = 'friend-1'`).run()).toThrow(/CHECK constraint failed/i);
  });

  test('adds append-only per-column details under the immutable audit parent', () => {
    requireMigration119();

    expect(columns(raw, 'sheets_sync_audit_details')).toEqual([
      'id',
      'audit_id',
      'actor',
      'column_name',
      'old_value',
      'new_value',
      'source',
      'change_kind',
      'created_at',
    ]);
    raw.prepare(`INSERT INTO sheets_sync_audit_details
      (id, audit_id, actor, column_name, old_value, new_value, source, change_kind)
      VALUES ('detail-1', 'audit-1', 'editor@example.com', '契約状況', '未', '済',
              'webhook', 'custom_field')`).run();
    expect(() => raw.prepare(`INSERT INTO sheets_sync_audit_details
      (id, audit_id, actor, column_name, old_value, new_value, source, change_kind)
      VALUES ('detail-identity', 'audit-1', 'system_poll', '表示名', '旧名', '新名',
              'polling', 'identity_sync')`).run()).not.toThrow();

    expect(() => raw.prepare(`UPDATE sheets_sync_audit_details SET new_value = '改ざん'
      WHERE id = 'detail-1'`).run()).toThrow(/append-only/i);
    expect(() => raw.prepare(`DELETE FROM sheets_sync_audit_details WHERE id = 'detail-1'`).run())
      .toThrow(/append-only/i);
    expect(() => raw.prepare(`INSERT OR REPLACE INTO sheets_sync_audit_details
      (id, audit_id, actor, column_name, old_value, new_value, source, change_kind)
      VALUES ('detail-1', 'audit-1', 'attacker', '契約状況', '済', '改ざん',
              'webhook', 'custom_field')`).run()).toThrow(/append-only/i);
    expect(() => raw.prepare(`INSERT INTO sheets_sync_audit_details
      (id, audit_id, actor, column_name, old_value, new_value, source, change_kind)
      VALUES ('orphan', 'missing-audit', 'system_poll', '契約状況', '未', '済',
              'polling', 'custom_field')`).run()).toThrow(/FOREIGN KEY constraint failed/i);
    expect(raw.prepare(`SELECT actor, column_name, old_value, new_value, source, change_kind
      FROM sheets_sync_audit_details WHERE id = 'detail-1'`).get()).toEqual({
      actor: 'editor@example.com',
      column_name: '契約状況',
      old_value: '未',
      new_value: '済',
      source: 'webhook',
      change_kind: 'custom_field',
    });
  });

  test('keeps schema and generated bootstrap aligned with migration 119', () => {
    requireMigration119();
    for (const file of ['schema.sql', 'bootstrap.sql']) {
      const sql = readFileSync(join(PKG_ROOT, file), 'utf8');
      expect(sql).toContain('friend_field_mappings_json');
      expect(sql).toContain('canonical_snapshot_json');
      expect(sql).toContain('sheets_sync_audit_details');
    }
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations?: string[];
    };
    expect(meta.includedMigrations).toContain('119_friend_ledger_sync.sql');
  });
});
