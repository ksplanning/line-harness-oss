import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_PATH = join(MIGRATIONS_DIR, '108_formaloo_choice_lists.sql');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const sql of statements) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('migration 108 — Formaloo dynamic choice lists', () => {
  test('creates the form-scoped choice-list table and lookup index', () => {
    const columns = raw.prepare('PRAGMA table_info(formaloo_choice_lists)').all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(['id', 'form_id', 'name', 'items_json', 'created_at', 'updated_at']);

    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='formaloo_choice_lists'").all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toContain('idx_formaloo_choice_lists_form');
  });

  test('is additive migration 108 only', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|RENAME|UPDATE|DELETE)\b/im);
  });

  test('keeps existing Formaloo tables and legacy rows intact', () => {
    raw.prepare("INSERT INTO formaloo_forms (id, title, definition_json) VALUES ('legacy', '既存', '{\"fields\":[],\"logic\":[]}')").run();
    expect(raw.prepare("SELECT title, definition_json FROM formaloo_forms WHERE id='legacy'").get()).toEqual({
      title: '既存', definition_json: '{"fields":[],"logic":[]}',
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM formaloo_choice_lists').get()).toEqual({ count: 0 });
  });

  test('schema.sql and bootstrap.sql contain the same table/index contract', () => {
    for (const file of ['schema.sql', 'bootstrap.sql']) {
      const sql = readFileSync(join(PKG_ROOT, file), 'utf8');
      expect(/CREATE TABLE(?: IF NOT EXISTS)? formaloo_choice_lists/.test(sql)).toBe(true);
      expect(sql.includes('idx_formaloo_choice_lists_form')).toBe(true);
    }
  });
});
