import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(__dirname, '..', 'migrations', '130_internal_form_submission_soft_delete.sql');

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE internal_form_submissions (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL,
      friend_id TEXT,
      answers_json TEXT NOT NULL DEFAULT '{}',
      submitted_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO internal_form_submissions
      (id, form_id, friend_id, answers_json, submitted_at, created_at)
    VALUES
      ('sub_existing', 'form_existing', 'friend_existing', '{"name":"existing answer"}',
       '2026-07-22T00:00:00+09:00', '2026-07-22T00:00:00+09:00');
  `);
  return db;
}

describe('migration 130 — internal form submission soft delete', () => {
  test('adds nullable deleted_at without changing an existing submission or its answers', () => {
    const db = legacyDatabase();

    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));

    const columns = db.prepare("PRAGMA table_info('internal_form_submissions')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.find((column) => column.name === 'deleted_at')).toEqual(
      expect.objectContaining({ name: 'deleted_at', notnull: 0 }),
    );
    expect(db.prepare(`
      SELECT id, form_id, friend_id, answers_json, deleted_at
      FROM internal_form_submissions
      WHERE id = 'sub_existing'
    `).get()).toEqual({
      id: 'sub_existing',
      form_id: 'form_existing',
      friend_id: 'friend_existing',
      answers_json: '{"name":"existing answer"}',
      deleted_at: null,
    });
  });

  test('is additive and contains no DROP or DELETE statement', () => {
    const executableSql = readFileSync(MIGRATION_PATH, 'utf8')
      .split('\n')
      .map((line) => {
        const commentStart = line.indexOf('--');
        return commentStart === -1 ? line : line.slice(0, commentStart);
      })
      .join('\n');

    expect(executableSql).not.toMatch(/\bDROP\b/i);
    expect(executableSql).not.toMatch(/\bDELETE\b/i);
  });

  test.each(['schema.sql', 'bootstrap.sql'])('%s gives fresh databases the nullable tombstone column', (file) => {
    const db = new Database(':memory:');
    db.exec(readFileSync(join(PKG_ROOT, file), 'utf8'));
    const deletedAt = db.prepare("PRAGMA table_info('internal_form_submissions')").all()
      .find((column) => (column as { name?: unknown }).name === 'deleted_at') as {
        name: string;
        notnull: number;
      } | undefined;
    expect(deletedAt).toEqual(expect.objectContaining({ name: 'deleted_at', notnull: 0 }));
  });
});
