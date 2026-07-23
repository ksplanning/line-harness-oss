import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(
  PKG_ROOT,
  'migrations',
  '134_email_sender_settings.sql',
);

function migrationSql(): string | null {
  expect(existsSync(MIGRATION_PATH)).toBe(true);
  return existsSync(MIGRATION_PATH)
    ? readFileSync(MIGRATION_PATH, 'utf8')
    : null;
}

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
  return db;
}

describe('migration 134 — account email sender settings', () => {
  test('is additive-only and creates safe unverified defaults', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(sql).not.toMatch(/^\s*(?:ALTER|DROP|RENAME|UPDATE|DELETE)\b/im);

    const db = legacyDatabase();
    db.exec(sql);
    db.prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_name, sender_domain)
       VALUES (?, ?, ?, ?)`,
    ).run('account-1', 'notice@example.com', 'お知らせ係', 'example.com');

    expect(db.prepare(
      `SELECT line_account_id, sender_email, sender_name, sender_domain,
              resend_domain_id, resend_domain_status, dns_records_json,
              domain_checked_at,
              created_at IS NOT NULL AS has_created_at,
              updated_at IS NOT NULL AS has_updated_at
         FROM email_sender_settings
        WHERE line_account_id = 'account-1'`,
    ).get()).toEqual({
      line_account_id: 'account-1',
      sender_email: 'notice@example.com',
      sender_name: 'お知らせ係',
      sender_domain: 'example.com',
      resend_domain_id: null,
      resend_domain_status: 'not_started',
      dns_records_json: '[]',
      domain_checked_at: null,
      has_created_at: 1,
      has_updated_at: 1,
    });
    db.close();
  });

  test('accepts provider status changes without an enum constraint and rejects invalid DNS JSON', () => {
    const sql = migrationSql();
    if (!sql) return;

    const db = legacyDatabase();
    db.exec(sql);
    db.prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_domain, resend_domain_status)
       VALUES (?, ?, ?, ?)`,
    ).run('account-1', 'notice@example.com', 'example.com', 'temporary_failure');

    expect(db.prepare(
      `SELECT resend_domain_status
         FROM email_sender_settings
        WHERE line_account_id = 'account-1'`,
    ).get()).toEqual({ resend_domain_status: 'temporary_failure' });
    expect(() => db.prepare(
      `UPDATE email_sender_settings
          SET dns_records_json = '{"not":"an array"}'
        WHERE line_account_id = 'account-1'`,
    ).run()).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  test('keeps one settings row per account and cascades account deletion', () => {
    const sql = migrationSql();
    if (!sql) return;

    const db = legacyDatabase();
    db.exec(sql);
    db.prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_domain)
       VALUES (?, ?, ?)`,
    ).run('account-1', 'notice@example.com', 'example.com');

    expect(() => db.prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_domain)
       VALUES (?, ?, ?)`,
    ).run('account-1', 'other@example.com', 'example.com')).toThrow(
      /UNIQUE constraint failed/i,
    );

    db.prepare(`DELETE FROM line_accounts WHERE id = 'account-1'`).run();
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM email_sender_settings`,
    ).get()).toEqual({ count: 0 });
    db.close();
  });

  test('requires a concrete LINE account id instead of accepting NULL primary keys', () => {
    const sql = migrationSql();
    if (!sql) return;

    const db = legacyDatabase();
    db.exec(sql);
    expect(() => db.prepare(
      `INSERT INTO email_sender_settings
         (line_account_id, sender_email, sender_domain)
       VALUES (NULL, ?, ?)`,
    ).run('notice@example.com', 'example.com')).toThrow(/NOT NULL constraint failed/i);
    db.close();
  });
});
