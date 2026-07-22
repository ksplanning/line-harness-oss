import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '125_sheets_connection_field_selection.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_NAME);

function applySheetsFoundation(db: Database.Database): void {
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
  ]) {
    db.exec(readFileSync(join(PKG_ROOT, 'migrations', migration), 'utf8'));
  }
}

describe('migration 125 — form field selection for Sheets connections', () => {
  test('is additive and keeps NULL as legacy/all while arrays store an explicit selection', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(checkMigration(sql, MIGRATION_PATH)).toEqual({ ok: true });
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);

    const db = new Database(':memory:');
    applySheetsFoundation(db);
    db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    db.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name)
      VALUES ('legacy', 'acc-1', 'form-1', 'sheet-1', '回答')`).run();

    db.exec(sql);

    const column = db.prepare(`PRAGMA table_info(sheets_connections)`).all()
      .find((entry) => (entry as { name: string }).name === 'selected_form_field_ids_json') as {
        notnull: number;
        dflt_value: string | null;
      } | undefined;
    expect(column).toMatchObject({ notnull: 0, dflt_value: null });
    expect(db.prepare(`SELECT selected_form_field_ids_json FROM sheets_connections
      WHERE id = 'legacy'`).get()).toEqual({ selected_form_field_ids_json: null });

    db.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name, selected_form_field_ids_json)
      VALUES ('explicit', 'acc-1', 'form-2', 'sheet-2', '回答', ?)`).run(
      JSON.stringify(['field-name', 'field-email']),
    );
    expect(db.prepare(`SELECT selected_form_field_ids_json FROM sheets_connections
      WHERE id = 'explicit'`).get()).toEqual({
      selected_form_field_ids_json: '["field-name","field-email"]',
    });
    db.prepare(`UPDATE sheets_connections
      SET selected_form_field_ids_json = '[]' WHERE id = 'explicit'`).run();
    expect(db.prepare(`SELECT selected_form_field_ids_json FROM sheets_connections
      WHERE id = 'explicit'`).get()).toEqual({ selected_form_field_ids_json: '[]' });

    expect(() => db.prepare(`UPDATE sheets_connections
      SET selected_form_field_ids_json = '{}' WHERE id = 'explicit'`).run())
      .toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(`UPDATE sheets_connections
      SET selected_form_field_ids_json = 'not-json' WHERE id = 'explicit'`).run())
      .toThrow(/CHECK constraint failed|malformed JSON/i);
    db.close();
  });

  test('keeps declarative schema, generated bootstrap, and migration metadata aligned', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    expect(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'))
      .toContain('selected_form_field_ids_json');
    expect(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'))
      .toContain('selected_form_field_ids_json');
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations?: string[];
      migrationCount?: number;
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
    expect(meta.migrationCount).toBe(meta.includedMigrations?.length);
  });
});
