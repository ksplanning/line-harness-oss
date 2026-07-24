import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '143_auto_reply_actions.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_NAME);

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE auto_replies (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL,
      response_type TEXT NOT NULL,
      response_content TEXT NOT NULL,
      response_messages TEXT,
      template_id TEXT,
      line_account_id TEXT,
      keep_in_unresponded INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('migration 143: auto_replies ordered reply actions', () => {
  test('exists and passes the additive migration guard', () => {
    expect(existsSync(MIGRATION_PATH), `${MIGRATION_NAME} must be added`).toBe(true);
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(checkMigration(migrationSql, MIGRATION_NAME)).toEqual({ ok: true });
  });

  test('preserves legacy rows as NULL and accepts only JSON arrays', () => {
    expect(existsSync(MIGRATION_PATH), `${MIGRATION_NAME} must be added`).toBe(true);
    const db = legacyDb();
    db.prepare(
      `INSERT INTO auto_replies
        (id, keyword, match_type, response_type, response_content, response_messages,
         template_id, line_account_id, keep_in_unresponded, is_active, created_at)
       VALUES ('legacy', '営業時間', 'exact', 'text', '10時からです', NULL,
               NULL, NULL, 0, 1, 'now')`,
    ).run();

    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));

    expect(db.prepare(
      "SELECT on_reply_actions_json FROM auto_replies WHERE id = 'legacy'",
    ).get()).toEqual({ on_reply_actions_json: null });
    expect(() => db.prepare(
      "UPDATE auto_replies SET on_reply_actions_json = '[]' WHERE id = 'legacy'",
    ).run()).not.toThrow();
    expect(() => db.prepare(
      "UPDATE auto_replies SET on_reply_actions_json = '{}' WHERE id = 'legacy'",
    ).run()).toThrow();
  });

  test.each(['schema.sql', 'bootstrap.sql'])('%s declares the nullable checked array column', (filename) => {
    const sql = readFileSync(join(PKG_ROOT, filename), 'utf8');
    expect(sql).toMatch(
      /auto_replies[\s\S]*on_reply_actions_json\s+TEXT DEFAULT NULL[\s\S]*json_type\(on_reply_actions_json\) = 'array'/,
    );
  });

  test('bootstrap metadata includes migration 143 exactly once', () => {
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
      migrationCount: number;
    };
    expect(meta.includedMigrations.filter((name) => name === MIGRATION_NAME)).toHaveLength(1);
    expect(meta.migrationCount).toBe(meta.includedMigrations.length);
  });
});
