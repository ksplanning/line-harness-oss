import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '123_auto_reply_response_messages.sql';
const migrationSql = readFileSync(join(PKG_ROOT, 'migrations', MIGRATION_NAME), 'utf8');

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE auto_replies (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL,
      response_type TEXT NOT NULL,
      response_content TEXT NOT NULL,
      template_id TEXT,
      line_account_id TEXT,
      is_active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

describe('migration 123: auto_replies.response_messages additive column', () => {
  test('is accepted by the additive migration guard', () => {
    expect(checkMigration(migrationSql, MIGRATION_NAME)).toEqual({ ok: true });
    expect(checkMigration(migrationSql)).toEqual({ ok: true });
  });

  test('adds a nullable TEXT column and preserves legacy rows', () => {
    const db = legacyDb();
    db.prepare(
      `INSERT INTO auto_replies VALUES ('legacy','営業時間','exact','text','10時からです',NULL,NULL,1,'now')`,
    ).run();

    db.exec(migrationSql);

    const columns = db.prepare("PRAGMA table_info('auto_replies')").all() as Array<{ name: string; type: string; notnull: number }>;
    expect(columns).toContainEqual(expect.objectContaining({ name: 'response_messages', type: 'TEXT', notnull: 0 }));
    expect((db.prepare("SELECT response_messages FROM auto_replies WHERE id='legacy'").get() as { response_messages: string | null }).response_messages).toBeNull();
  });

  test('round-trips a five-bubble JSON fixture', () => {
    const db = legacyDb();
    db.exec(migrationSql);
    const messages = Array.from({ length: 5 }, (_, index) => ({ messageType: 'text', messageContent: `${index + 1}` }));
    db.prepare(
      `INSERT INTO auto_replies
        (id,keyword,match_type,response_type,response_content,template_id,line_account_id,is_active,created_at,response_messages)
       VALUES ('multi','資料','exact','text','1',NULL,NULL,1,'now',?)`,
    ).run(JSON.stringify(messages));

    const row = db.prepare("SELECT response_messages FROM auto_replies WHERE id='multi'").get() as { response_messages: string };
    expect(JSON.parse(row.response_messages)).toEqual(messages);
  });

  test.each(['schema.sql', 'bootstrap.sql'])('%s declares the additive column', (filename) => {
    const sql = readFileSync(join(PKG_ROOT, filename), 'utf8');
    expect(sql).toMatch(/auto_replies[\s\S]*response_messages\s+TEXT/);
  });

  test('bootstrap metadata includes migration 123', () => {
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as { includedMigrations: string[] };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
  });
});
