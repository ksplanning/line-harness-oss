import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', '120_form_answer_sheet_headers.sql');

describe('migration 120 — generated form-answer header snapshots', () => {
  test('is additive and gives every existing Sheets connection an empty JSON array', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(checkMigration(sql, MIGRATION_PATH)).toEqual({ ok: true });
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);

    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      channel_access_token TEXT NOT NULL,
      channel_secret TEXT NOT NULL
    )`);
    db.exec(readFileSync(join(PKG_ROOT, 'migrations', '114_sheets_connections.sql'), 'utf8'));
    db.exec(readFileSync(join(PKG_ROOT, 'migrations', '119_friend_ledger_sync.sql'), 'utf8'));
    db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
    db.prepare(`INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, sheet_name)
      VALUES ('connection-1', 'acc-1', 'form-1', 'sheet-1', '回答')`).run();

    db.exec(sql);

    expect(db.prepare(`SELECT form_answer_headers_json FROM sheets_connections
      WHERE id='connection-1'`).get()).toEqual({ form_answer_headers_json: '[]' });
    expect(() => db.prepare(`UPDATE sheets_connections SET form_answer_headers_json='{}'
      WHERE id='connection-1'`).run()).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  test('keeps declarative schema, generated bootstrap, and migration metadata aligned', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;
    expect(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8')).toContain('form_answer_headers_json');
    expect(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8')).toContain('form_answer_headers_json');
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations?: string[];
    };
    expect(meta.includedMigrations).toContain('120_form_answer_sheet_headers.sql');
  });
});
