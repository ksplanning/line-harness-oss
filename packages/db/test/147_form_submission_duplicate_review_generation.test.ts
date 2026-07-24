import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_FILE = '147_form_submission_duplicate_review_generation.sql';
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

function replayBefore147(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < MIGRATION_FILE)
    .sort()) {
    applyStatements(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

describe('migration 147 — duplicate review generation CAS', () => {
  test('adds an additive form generation and bumps it for grouping-relevant mutations', () => {
    const migrationPath = join(MIGRATIONS_DIR, MIGRATION_FILE);
    expect(existsSync(migrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const sql = readFileSync(migrationPath, 'utf8');
    expect(checkMigration(sql, MIGRATION_FILE)).toEqual({ ok: true });
    expect(sql).toMatch(
      /ADD COLUMN submission_duplicate_review_generation INTEGER NOT NULL DEFAULT 0/i,
    );
    expect(sql.match(/CREATE TRIGGER/gi)).toHaveLength(9);

    const db = new Database(':memory:');
    replayBefore147(db);
    db.prepare(
      `INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status)
       VALUES ('form-1', 'slug-1', 'テスト', 'published')`,
    ).run();

    db.exec(sql);
    const generation = () => db.prepare(
      `SELECT submission_duplicate_review_generation
       FROM formaloo_forms WHERE id = 'form-1'`,
    ).pluck().get();
    expect(generation()).toBe(0);

    db.prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, answers_json, submitted_at, created_at)
       VALUES ('internal-1', 'form-1', '{"name":"A"}', '2026-07-24', '2026-07-24')`,
    ).run();
    expect(generation()).toBe(1);

    db.prepare(
      `UPDATE internal_form_submissions
       SET submitted_at = '2026-07-25' WHERE id = 'internal-1'`,
    ).run();
    expect(generation()).toBe(1);
    db.prepare(
      `UPDATE internal_form_submissions
       SET answers_json = '{"name":"B"}' WHERE id = 'internal-1'`,
    ).run();
    expect(generation()).toBe(2);
    db.prepare(
      `UPDATE internal_form_submissions
       SET answers_json = answers_json WHERE id = 'internal-1'`,
    ).run();
    expect(generation()).toBe(2);
    db.prepare(
      `UPDATE internal_form_submissions
       SET deleted_at = '2026-07-25' WHERE id = 'internal-1'`,
    ).run();
    expect(generation()).toBe(3);

    db.prepare(
      `INSERT INTO formaloo_submissions
         (id, form_id, answers_json, submitted_at)
       VALUES ('formaloo-1', 'form-1', '{"name":"A"}', '2026-07-24')`,
    ).run();
    expect(generation()).toBe(4);
    db.prepare(
      `UPDATE formaloo_submissions
       SET duplicate_reviewed_at = '2026-07-25' WHERE id = 'formaloo-1'`,
    ).run();
    expect(generation()).toBe(4);
    db.prepare("DELETE FROM formaloo_submissions WHERE id = 'formaloo-1'").run();
    expect(generation()).toBe(5);

    db.prepare(
      `INSERT INTO formaloo_field_map
         (id, form_id, formaloo_field_slug, field_type, label, position)
       VALUES ('field-1', 'form-1', 'email', 'email', 'メール', 0)`,
    ).run();
    expect(generation()).toBe(6);
    db.prepare(
      `UPDATE formaloo_field_map SET position = 1 WHERE id = 'field-1'`,
    ).run();
    expect(generation()).toBe(7);
    db.prepare("DELETE FROM formaloo_field_map WHERE id = 'field-1'").run();
    expect(generation()).toBe(8);
  });
});
