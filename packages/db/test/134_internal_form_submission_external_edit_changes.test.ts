import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_FILE = '134_internal_form_submission_external_edit_changes.sql';
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

function replayBefore134(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < MIGRATION_FILE)
    .sort()) {
    applyStatements(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

describe('migration 134 — internal submission external edit changes', () => {
  test('adds one nullable snapshot column without rewriting existing answers', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
    expect(sql).toMatch(
      /ALTER TABLE internal_form_submissions ADD COLUMN external_edit_changes_json TEXT/i,
    );
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE)\b/i);

    const db = new Database(':memory:');
    replayBefore134(db);
    db.prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, answers_json, submitted_at, created_at)
       VALUES ('ifs-existing', 'form-1', '{"name":"既存回答"}',
               '2026-07-23T09:00:00+09:00', '2026-07-23T09:00:00+09:00')`,
    ).run();

    applyStatements(db, sql);

    expect(db.prepare(
      `SELECT answers_json, external_edit_changes_json
       FROM internal_form_submissions WHERE id = 'ifs-existing'`,
    ).get()).toEqual({
      answers_json: '{"name":"既存回答"}',
      external_edit_changes_json: null,
    });
  });
});
