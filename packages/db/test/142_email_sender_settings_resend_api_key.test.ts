import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BASE_MIGRATION_PATH = join(
  PKG_ROOT,
  'migrations',
  '134_email_sender_settings.sql',
);
const MIGRATION_PATH = join(
  PKG_ROOT,
  'migrations',
  '142_email_sender_settings_resend_api_key.sql',
);

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      channel_access_token TEXT NOT NULL,
      channel_secret TEXT NOT NULL
    );
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
    VALUES
      ('account-1', 'channel-1', 'Account 1', 'token', 'secret'),
      ('account-2', 'channel-2', 'Account 2', 'token', 'secret');
  `);
  db.exec(readFileSync(BASE_MIGRATION_PATH, 'utf8'));
  return db;
}

describe('migration 142 — account-scoped Resend API key', () => {
  test('adds one nullable key column without rewriting existing sender rows', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/^\s*(?:DROP|RENAME|UPDATE|DELETE)\b/im);

    const db = legacyDatabase();
    db.prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_domain)
       VALUES (?, ?, ?)`,
    ).run('account-1', 'notice@example.com', 'example.com');

    db.exec(sql);
    expect(db.prepare(
      `SELECT sender_email, resend_api_key
         FROM email_sender_settings
        WHERE line_account_id = ?`,
    ).get('account-1')).toEqual({
      sender_email: 'notice@example.com',
      resend_api_key: null,
    });
    db.close();
  });
});
