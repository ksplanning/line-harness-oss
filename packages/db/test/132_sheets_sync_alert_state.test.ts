import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '132_sheets_sync_alert_state.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_NAME);

function migrationSql(): string | null {
  expect(existsSync(MIGRATION_PATH)).toBe(true);
  return existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : null;
}

describe('migration 132 — durable Sheets sync alert state', () => {
  test('is additive-only and preserves existing last-write-wins settings', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(checkMigration(sql, MIGRATION_PATH)).toEqual({ ok: true });
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);
    expect(sql.match(/ALTER TABLE sheets_connections\s+ADD COLUMN/gi)).toHaveLength(4);

    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sheets_connections (
      id TEXT PRIMARY KEY,
      conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins',
      conflict_clock TEXT NOT NULL DEFAULT 'server_sequence',
      last_sync_status TEXT NOT NULL DEFAULT 'idle'
    )`);
    db.prepare(`INSERT INTO sheets_connections
      (id, conflict_policy, conflict_clock, last_sync_status)
      VALUES ('connection-1', 'last_write_wins', 'server_sequence', 'error')`).run();

    db.exec(sql);

    expect(db.prepare(`SELECT id, conflict_policy, conflict_clock, last_sync_status,
      sync_error_started_at, sync_alerted_at,
      sync_alert_claimed_at, sync_recovery_pending_at
      FROM sheets_connections WHERE id = 'connection-1'`).get()).toEqual({
      id: 'connection-1',
      conflict_policy: 'last_write_wins',
      conflict_clock: 'server_sequence',
      last_sync_status: 'error',
      sync_error_started_at: null,
      sync_alerted_at: null,
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: null,
    });
    db.close();
  });

  test('keeps declarative schema, generated bootstrap, and migration metadata aligned', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(sql).toMatch(/ADD COLUMN sync_error_started_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN sync_alerted_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN sync_alert_claimed_at TEXT/i);
    expect(sql).toMatch(/ADD COLUMN sync_recovery_pending_at TEXT/i);
    for (const file of ['schema.sql', 'bootstrap.sql']) {
      const contents = readFileSync(join(PKG_ROOT, file), 'utf8');
      expect(contents).toContain('sync_error_started_at');
      expect(contents).toContain('sync_alerted_at');
      expect(contents).toContain('sync_alert_claimed_at');
      expect(contents).toContain('sync_recovery_pending_at');
    }
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations?: string[];
      migrationCount?: number;
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
    expect(meta.migrationCount).toBe(meta.includedMigrations?.length);
  });
});
