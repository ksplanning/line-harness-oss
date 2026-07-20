import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_FILE = '113_internal_form_submissions.sql';
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const BENIGN = /duplicate column name|already exists/i;

function replayThrough112(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name < MIGRATION_FILE)
    .sort()) {
    for (const statement of readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
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
}

function applyMigration113(db: Database.Database): void {
  for (const statement of readFileSync(MIGRATION_PATH, 'utf8')
    .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    try { db.exec(statement); } catch (error) {
      if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

describe('migration 113 — internal form submissions', () => {
  test('exists and remains additive-only', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(checkMigration(sql, MIGRATION_PATH)).toEqual({ ok: true });
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);
  });

  test('keeps the declarative schema in sync with migration 113', () => {
    const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
    expect(schema).toMatch(/render_backend\s+TEXT NOT NULL DEFAULT 'formaloo'[\s\S]*CHECK \(render_backend IN \('formaloo', 'internal'\)\)/i);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS internal_form_submissions/i);
  });

  test('keeps every existing advanced form on the formaloo backend by default', () => {
    if (!existsSync(MIGRATION_PATH)) return;
    const db = new Database(':memory:');
    replayThrough112(db);
    db.prepare(
      `INSERT INTO formaloo_forms (id, title, definition_json)
       VALUES ('fa_existing', '既存フォーム', '{"fields":[],"logic":[]}')`,
    ).run();

    applyMigration113(db);

    expect(db.prepare(
      'SELECT render_backend FROM formaloo_forms WHERE id = ?',
    ).get('fa_existing')).toEqual({ render_backend: 'formaloo' });
    expect(() => db.prepare(
      "UPDATE formaloo_forms SET render_backend = 'unknown' WHERE id = 'fa_existing'",
    ).run()).toThrow(/CHECK constraint failed/i);
  });

  test('creates a separate internal submission store and lookup indexes', () => {
    if (!existsSync(MIGRATION_PATH)) return;
    const db = new Database(':memory:');
    replayThrough112(db);
    applyMigration113(db);

    const columns = db.prepare('PRAGMA table_info(internal_form_submissions)').all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'form_id', 'friend_id', 'answers_json', 'submitted_at', 'created_at',
    ]));

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_internal_form_submissions_%' ORDER BY name",
    ).all();
    expect(indexes).toEqual([
      { name: 'idx_internal_form_submissions_form' },
      { name: 'idx_internal_form_submissions_friend' },
    ]);
  });
});
