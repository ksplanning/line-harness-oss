import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(
  __dirname,
  '..',
  'migrations',
  '131_sheets_form_results_row_shift_fence.sql',
);

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sheets_connections (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      form_id TEXT NOT NULL,
      spreadsheet_id TEXT NOT NULL,
      last_sync_status TEXT NOT NULL DEFAULT 'idle'
    );
    INSERT INTO sheets_connections
      (id, line_account_id, form_id, spreadsheet_id, last_sync_status)
    VALUES ('conn-existing', 'acc-existing', 'form-existing', 'sheet-existing', 'success');
  `);
  return db;
}

describe('migration 131 — form-results row-shift webhook fence', () => {
  test('adds a nullable structural-shift timestamp without changing an existing connection', () => {
    const db = legacyDatabase();

    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));

    const columns = db.prepare("PRAGMA table_info('sheets_connections')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    for (const name of [
      'form_results_row_shifted_at',
      'form_results_row_shift_pending_until',
    ]) {
      expect(columns.find((column) => column.name === name)).toEqual(
        expect.objectContaining({ name, notnull: 0 }),
      );
    }
    expect(db.prepare(`
      SELECT id, spreadsheet_id, last_sync_status,
             form_results_row_shifted_at, form_results_row_shift_pending_until
      FROM sheets_connections WHERE id = 'conn-existing'
    `).get()).toEqual({
      id: 'conn-existing',
      spreadsheet_id: 'sheet-existing',
      last_sync_status: 'success',
      form_results_row_shifted_at: null,
      form_results_row_shift_pending_until: null,
    });
  });

  test('is additive and contains no DROP or DELETE statement', () => {
    const executableSql = readFileSync(MIGRATION_PATH, 'utf8')
      .split('\n')
      .map((line) => line.split('--', 1)[0])
      .join('\n');

    expect(executableSql).not.toMatch(/\bDROP\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\b/i);
  });

  test.each(['schema.sql', 'bootstrap.sql'])('%s contains the nullable row-shift fence', (file) => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(PKG_ROOT, file), 'utf8'));
    const columns = db.prepare("PRAGMA table_info('sheets_connections')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    for (const name of [
      'form_results_row_shifted_at',
      'form_results_row_shift_pending_until',
    ]) {
      expect(columns.find((column) => column.name === name)).toEqual(expect.objectContaining({
        name,
        notnull: 0,
      }));
    }
  });
});
