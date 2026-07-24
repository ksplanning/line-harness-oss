import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_FILE = '146_form_submission_duplicate_review.sql';
const BENIGN = /duplicate column name|already exists/i;

function applyStatements(db: Database.Database, sql: string): void {
  for (const statement of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

function replayBefore146(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < MIGRATION_FILE)
    .sort()) {
    applyStatements(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

describe('migration 146 — form submission duplicate review', () => {
  test('is additive-only and preserves existing answers with unreviewed markers', () => {
    const migrationPath = join(MIGRATIONS_DIR, MIGRATION_FILE);
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(
      /ALTER TABLE internal_form_submissions\s+ADD COLUMN duplicate_reviewed_at TEXT/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE formaloo_submissions\s+ADD COLUMN duplicate_reviewed_at TEXT/i,
    );
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE)\b/i);

    const db = new Database(':memory:');
    replayBefore146(db);
    db.prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, answers_json, submitted_at, created_at)
       VALUES ('ifs-existing', 'form-1', '{"name":"既存回答"}',
               '2026-07-24T09:00:00+09:00', '2026-07-24T09:00:00+09:00')`,
    ).run();
    db.prepare(
      `INSERT INTO formaloo_submissions
         (id, form_id, answers_json, submitted_at)
       VALUES ('fs-existing', 'form-1', '{"name":"既存Formaloo回答"}',
               '2026-07-24T09:01:00+09:00')`,
    ).run();

    applyStatements(db, sql);

    const internalColumns = db.prepare('PRAGMA table_info(internal_form_submissions)').all()
      .map((column) => (column as { name: string }).name);
    const formalooColumns = db.prepare('PRAGMA table_info(formaloo_submissions)').all()
      .map((column) => (column as { name: string }).name);
    expect(internalColumns).toContain('duplicate_reviewed_at');
    expect(formalooColumns).toContain('duplicate_reviewed_at');
    expect(db.prepare(
      `SELECT answers_json, duplicate_reviewed_at
       FROM internal_form_submissions WHERE id = 'ifs-existing'`,
    ).get()).toEqual({
      answers_json: '{"name":"既存回答"}',
      duplicate_reviewed_at: null,
    });
    expect(db.prepare(
      `SELECT answers_json, duplicate_reviewed_at
       FROM formaloo_submissions WHERE id = 'fs-existing'`,
    ).get()).toEqual({
      answers_json: '{"name":"既存Formaloo回答"}',
      duplicate_reviewed_at: null,
    });
  });
});
