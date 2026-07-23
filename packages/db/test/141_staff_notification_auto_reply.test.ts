import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '141_staff_notification_auto_reply.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_NAME);

function migrationSql(): string | null {
  expect(existsSync(MIGRATION_PATH), `${MIGRATION_NAME} must be added`).toBe(true);
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
    CREATE TABLE staff_notification_destinations (
      id                         TEXT NOT NULL PRIMARY KEY,
      line_account_id            TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
      label                      TEXT NOT NULL,
      channel_type               TEXT NOT NULL CHECK (length(trim(channel_type)) > 0),
      config_json                TEXT NOT NULL DEFAULT '{}'
                                 CHECK (
                                   json_valid(config_json)
                                   AND json_type(config_json) = 'object'
                                 ),
      notify_inquiry             INTEGER NOT NULL DEFAULT 1 CHECK (notify_inquiry IN (0, 1)),
      notify_form_submission     INTEGER NOT NULL DEFAULT 1 CHECK (notify_form_submission IN (0, 1)),
      enabled                    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      line_user_id               TEXT,
      line_link_code_digest      TEXT,
      line_link_code_expires_at  TEXT,
      line_linked_at             TEXT,
      created_at                 TEXT NOT NULL,
      updated_at                 TEXT NOT NULL
    );
    CREATE TABLE unrelated_bytes (
      id TEXT PRIMARY KEY,
      payload BLOB NOT NULL
    );
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-1', 'channel-1', 'Account 1', 'token', 'secret');
    INSERT INTO staff_notification_destinations
      (id, line_account_id, label, channel_type, config_json,
       notify_inquiry, notify_form_submission, enabled, line_user_id,
       line_link_code_digest, line_link_code_expires_at, line_linked_at,
       created_at, updated_at)
    VALUES
      ('legacy-destination', 'account-1', '既存の受付', 'chatwork',
       '{"apiToken":"stored-secret","roomId":"123"}',
       1, 0, 1, NULL, 'digest-before', '2099-01-01T00:10:00.000+09:00',
       NULL, '2026-07-23T10:00:00.000+09:00',
       '2026-07-23T10:01:00.000+09:00');
    INSERT INTO unrelated_bytes (id, payload)
    VALUES ('unrelated', X'00010200FF7F80');
  `);
  return db;
}

function legacyDestinationBytes(db: Database.Database): unknown {
  return db.prepare(
    `SELECT id,
            hex(CAST(line_account_id AS BLOB)) AS line_account_id_hex,
            hex(CAST(label AS BLOB)) AS label_hex,
            hex(CAST(channel_type AS BLOB)) AS channel_type_hex,
            hex(CAST(config_json AS BLOB)) AS config_json_hex,
            notify_inquiry,
            notify_form_submission,
            enabled,
            hex(CAST(COALESCE(line_user_id, '') AS BLOB)) AS line_user_id_hex,
            hex(CAST(COALESCE(line_link_code_digest, '') AS BLOB)) AS line_link_code_digest_hex,
            hex(CAST(COALESCE(line_link_code_expires_at, '') AS BLOB))
              AS line_link_code_expires_at_hex,
            hex(CAST(COALESCE(line_linked_at, '') AS BLOB)) AS line_linked_at_hex,
            hex(CAST(created_at AS BLOB)) AS created_at_hex,
            hex(CAST(updated_at AS BLOB)) AS updated_at_hex
       FROM staff_notification_destinations
      WHERE id = 'legacy-destination'`,
  ).get();
}

describe('migration 141 — staff notification auto-reply opt-in', () => {
  test('exists and passes the additive migration guard', () => {
    const sql = migrationSql();
    if (!sql) return;

    expect(checkMigration(sql, MIGRATION_NAME)).toEqual({ ok: true });
  });

  test('defaults existing rows to 0, round-trips explicit 1, rejects 2, and preserves unrelated bytes', () => {
    const sql = migrationSql();
    if (!sql) return;

    const db = legacyDatabase();
    const destinationBefore = legacyDestinationBytes(db);
    const unrelatedBefore = db.prepare(
      `SELECT id, typeof(payload) AS storage_type, hex(payload) AS payload_hex
         FROM unrelated_bytes
        ORDER BY id`,
    ).all();

    db.exec(sql);

    const column = (db.prepare(
      "PRAGMA table_info('staff_notification_destinations')",
    ).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((item) => item.name === 'notify_auto_reply');
    expect(column).toEqual(expect.objectContaining({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    }));
    expect(db.prepare(
      `SELECT notify_auto_reply
         FROM staff_notification_destinations
        WHERE id = 'legacy-destination'`,
    ).get()).toEqual({ notify_auto_reply: 0 });
    expect(legacyDestinationBytes(db)).toEqual(destinationBefore);
    expect(db.prepare(
      `SELECT id, typeof(payload) AS storage_type, hex(payload) AS payload_hex
         FROM unrelated_bytes
        ORDER BY id`,
    ).all()).toEqual(unrelatedBefore);

    db.prepare(
      `INSERT INTO staff_notification_destinations
         (id, line_account_id, label, channel_type, config_json,
          notify_inquiry, notify_form_submission, notify_auto_reply, enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'opt-in-destination',
      'account-1',
      '自動応答も通知',
      'chatwork',
      '{"roomId":"456"}',
      1,
      1,
      1,
      1,
      '2026-07-24T00:00:00.000+09:00',
      '2026-07-24T00:00:00.000+09:00',
    );
    expect(db.prepare(
      `SELECT notify_auto_reply
         FROM staff_notification_destinations
        WHERE id = 'opt-in-destination'`,
    ).get()).toEqual({ notify_auto_reply: 1 });

    expect(() => db.prepare(
      `UPDATE staff_notification_destinations
          SET notify_auto_reply = 2
        WHERE id = 'legacy-destination'`,
    ).run()).toThrow(/CHECK constraint failed/i);
    db.close();
  });
});
