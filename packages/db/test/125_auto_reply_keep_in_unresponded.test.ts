import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '125_auto_reply_keep_in_unresponded.sql';
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
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('migration 125: auto_replies.keep_in_unresponded additive opt-in', () => {
  test('exists and passes the additive migration guard', () => {
    expect(existsSync(MIGRATION_PATH), `${MIGRATION_NAME} must be added`).toBe(true);
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(checkMigration(migrationSql, MIGRATION_NAME)).toEqual({ ok: true });
  });

  test('preserves legacy rows with default 0 and accepts explicit opt-in 1', () => {
    expect(existsSync(MIGRATION_PATH), `${MIGRATION_NAME} must be added`).toBe(true);
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    const db = legacyDb();
    db.prepare(
      `INSERT INTO auto_replies VALUES ('legacy','営業時間','exact','text','10時からです',NULL,NULL,NULL,1,'now')`,
    ).run();

    db.exec(migrationSql);

    const column = (db.prepare("PRAGMA table_info('auto_replies')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((item) => item.name === 'keep_in_unresponded');
    expect(column).toEqual(expect.objectContaining({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    }));
    expect(db.prepare("SELECT keep_in_unresponded FROM auto_replies WHERE id='legacy'").get()).toEqual({
      keep_in_unresponded: 0,
    });

    db.prepare(
      `INSERT INTO auto_replies
        (id,keyword,match_type,response_type,response_content,response_messages,template_id,line_account_id,is_active,created_at,keep_in_unresponded)
       VALUES ('opt-in','問い合わせ','exact','text','確認します',NULL,NULL,NULL,1,'now',1)`,
    ).run();
    expect(db.prepare("SELECT keep_in_unresponded FROM auto_replies WHERE id='opt-in'").get()).toEqual({
      keep_in_unresponded: 1,
    });
  });

  test.each(['schema.sql', 'bootstrap.sql'])('%s declares the default-0 column', (filename) => {
    const sql = readFileSync(join(PKG_ROOT, filename), 'utf8');
    expect(sql).toMatch(/auto_replies[\s\S]*keep_in_unresponded\s+INTEGER NOT NULL DEFAULT 0/);
  });

  test('bootstrap metadata includes migration 125', () => {
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as {
      includedMigrations: string[];
    };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
  });
});
