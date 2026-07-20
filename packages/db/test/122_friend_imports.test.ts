import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', '122_friend_imports.sql');

function createLegacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      channel_access_token TEXT NOT NULL,
      channel_secret TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT UNIQUE NOT NULL,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      line_account_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', '既存アカウント', 'token', 'secret')
  `).run();
  db.prepare(`
    INSERT INTO friends
      (id, line_user_id, display_name, picture_url, status_message, is_following,
       line_account_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'friend-existing',
    'U-existing',
    '既存 友だち',
    'https://example.test/existing.png',
    '既存 status',
    0,
    'acc-1',
    '{ "preserve" : true, "order": [3, 2, 1] }',
    '2026-01-02T03:04:05.006+09:00',
    '2026-06-07T08:09:10.011+09:00',
  );
  return db;
}

function friendSnapshot(db: Database.Database): unknown {
  return db.prepare(`
    SELECT id,
           hex(CAST(line_user_id AS BLOB)) AS line_user_id_hex,
           hex(CAST(display_name AS BLOB)) AS display_name_hex,
           hex(CAST(picture_url AS BLOB)) AS picture_url_hex,
           hex(CAST(status_message AS BLOB)) AS status_message_hex,
           is_following,
           hex(CAST(line_account_id AS BLOB)) AS line_account_id_hex,
           hex(CAST(metadata AS BLOB)) AS metadata_hex,
           hex(CAST(created_at AS BLOB)) AS created_at_hex,
           hex(CAST(updated_at AS BLOB)) AS updated_at_hex
      FROM friends
     WHERE id = 'friend-existing'
  `).get();
}

describe('migration 122 — followers import jobs', () => {
  test('adds import provenance and resumable job/audit tables without changing an existing friend value', () => {
    const db = createLegacyDatabase();
    try {
      const before = friendSnapshot(db);
      db.exec(readFileSync(MIGRATION_PATH, 'utf8'));

      expect(friendSnapshot(db)).toStrictEqual(before);
      expect(db.prepare("SELECT source FROM friends WHERE id = 'friend-existing'").get()).toEqual({ source: null });

      const tables = db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'friend_import_%'
         ORDER BY name
      `).all();
      expect(tables).toEqual([
        { name: 'friend_import_audit_log' },
        { name: 'friend_import_items' },
        { name: 'friend_import_jobs' },
      ]);

      const jobColumns = db.prepare('PRAGMA table_info(friend_import_jobs)').all() as Array<{ name: string }>;
      expect(jobColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'account_id',
        'status',
        'phase',
        'continuation_token',
        'new_count',
        'existing_count',
        'failed_count',
        'profile_processed_count',
        'next_run_at',
        'lock_token',
        'locked_until',
        'last_error_code',
      ]));

      const itemColumns = db.prepare('PRAGMA table_info(friend_import_items)').all() as Array<{ name: string }>;
      expect(itemColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'profile_attempts',
        'next_attempt_at',
      ]));
    } finally {
      db.close();
    }
  });

  test('allows only one running import per account and keeps audit rows append-only', () => {
    const db = createLegacyDatabase();
    try {
      db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
      const insertJob = db.prepare(`
        INSERT INTO friend_import_jobs (id, account_id, requested_by_id, requested_by_name)
        VALUES (?, 'acc-1', 'staff-1', '担当者')
      `);
      insertJob.run('job-1');
      expect(() => insertJob.run('job-2')).toThrow(/UNIQUE constraint failed/);

      db.prepare(`
        INSERT INTO friend_import_audit_log
          (id, job_id, account_id, event_type, actor_id, actor_name,
           new_count, existing_count, failed_count)
        VALUES ('audit-1', 'job-1', 'acc-1', 'started', 'staff-1', '担当者', 0, 0, 0)
      `).run();
      expect(() => db.prepare("UPDATE friend_import_audit_log SET event_type = 'changed'").run())
        .toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM friend_import_audit_log').run())
        .toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  test('records a cross-account line user collision as an honest import conflict', () => {
    const db = createLegacyDatabase();
    try {
      db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
      db.prepare(`
        INSERT INTO friend_import_jobs (id, account_id, requested_by_id, requested_by_name)
        VALUES ('job-1', 'acc-1', 'staff-1', '担当者')
      `).run();

      expect(() => db.prepare(`
        INSERT INTO friend_import_items
          (job_id, line_user_id, friend_id, outcome, profile_status)
        VALUES ('job-1', 'U-other-account', 'friend-other', 'conflict', 'not_required')
      `).run()).not.toThrow();
    } finally {
      db.close();
    }
  });

  test('schema and generated bootstrap carry the same import contract', () => {
    for (const file of ['schema.sql', 'bootstrap.sql']) {
      const sql = readFileSync(join(PKG_ROOT, file), 'utf8');
      expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? friend_import_jobs/);
      expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? friend_import_items/);
      expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? friend_import_audit_log/);
      expect(sql).toMatch(/\bsource\s+TEXT/);
      expect(sql).toMatch(/outcome IN \('new', 'existing', 'conflict'\)/);
    }
  });
});
