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
  '136_staff_notification_destinations.sql',
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
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL UNIQUE,
      display_name TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      line_account_id TEXT
    );
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-1', 'channel-1', 'Account 1', 'token', 'secret');
    INSERT INTO friends
      (id, line_user_id, display_name, is_following, line_account_id)
    VALUES ('friend-1', 'U-customer', '兼任スタッフ', 1, 'account-1');
  `);
  return db;
}

describe('migration 135 — staff notification destinations', () => {
  test('is additive-only and creates account-scoped destinations and delivery logs', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(sql).not.toMatch(/^\s*(?:ALTER|DROP|RENAME|UPDATE|DELETE)\b/im);

    const db = legacyDatabase();
    const friendsBefore = db.prepare('SELECT * FROM friends ORDER BY id').all();
    db.exec(sql);
    db.prepare(
      `INSERT INTO staff_notification_destinations
         (id, line_account_id, label, channel_type, config_json,
          notify_inquiry, notify_form_submission, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'destination-1',
      'account-1',
      '受付担当',
      'chatwork',
      JSON.stringify({ apiToken: 'stored-secret', roomId: '123' }),
      1,
      0,
      1,
    );
    db.prepare(
      `INSERT INTO staff_notification_delivery_logs
         (id, destination_id, line_account_id, event_type, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'delivery-1',
      'destination-1',
      'account-1',
      'inquiry_received',
      'failed',
      'provider_http_error',
    );

    expect(db.prepare(
      `SELECT label, channel_type, notify_inquiry, notify_form_submission, enabled
         FROM staff_notification_destinations
        WHERE id = 'destination-1'`,
    ).get()).toEqual({
      label: '受付担当',
      channel_type: 'chatwork',
      notify_inquiry: 1,
      notify_form_submission: 0,
      enabled: 1,
    });
    expect(db.prepare(
      `SELECT event_type, status, error_code
         FROM staff_notification_delivery_logs
        WHERE id = 'delivery-1'`,
    ).get()).toEqual({
      event_type: 'inquiry_received',
      status: 'failed',
      error_code: 'provider_http_error',
    });
    expect(db.prepare('SELECT * FROM friends ORDER BY id').all()).toEqual(friendsBefore);
    db.close();
  });

  test('keeps channel storage extensible while rejecting invalid subscriptions, config shapes, and delivery states', () => {
    const sql = migrationSql();
    if (!sql) return;

    const db = legacyDatabase();
    db.exec(sql);
    const insert = db.prepare(
      `INSERT INTO staff_notification_destinations
         (id, line_account_id, label, channel_type, config_json,
          notify_inquiry, notify_form_submission, enabled)
       VALUES (?, 'account-1', '担当', ?, ?, ?, 1, 1)`,
    );

    expect(() => insert.run('future-channel', 'slack', '{}', 1)).not.toThrow();
    expect(() => insert.run('bad-json', 'line', '[]', 1)).toThrow(/CHECK constraint failed/i);
    expect(() => insert.run('bad-subscription', 'line', '{}', 2)).toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare(
      `INSERT INTO staff_notification_delivery_logs
         (id, destination_id, line_account_id, event_type, status)
       VALUES ('bad-log', NULL, 'account-1', 'future_event', 'pending')`,
    ).run()).toThrow(/CHECK constraint failed/i);
    db.close();
  });
});
