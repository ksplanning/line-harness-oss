import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', '122_internal_submission_notifications.sql');

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE formaloo_forms (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      definition_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE internal_form_submissions (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL,
      friend_id TEXT,
      answers_json TEXT NOT NULL DEFAULT '{}',
      submitted_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO formaloo_forms (id, title) VALUES ('form_existing', '既存フォーム');
    INSERT INTO internal_form_submissions
      (id, form_id, answers_json, submitted_at, created_at)
    VALUES
      ('sub_existing', 'form_existing', '{}', '2026-07-21T00:00:00+09:00', '2026-07-21T00:00:00+09:00');
  `);
  return db;
}

function applyMigration(db: Database.Database): void {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    db.exec(statement);
  }
}

describe('migration 122 — internal submission notifications', () => {
  test('exists and remains additive-only', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);
    expect(sql).not.toMatch(/\bADD\s+COLUMN\s+\S+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i);
  });

  test('adds safe origin and edit-version defaults to legacy submissions', () => {
    if (!existsSync(MIGRATION_PATH)) return;
    const db = legacyDatabase();
    applyMigration(db);

    expect(db.prepare(
      `SELECT origin_channel, edit_version
       FROM internal_form_submissions WHERE id = 'sub_existing'`,
    ).get()).toEqual({ origin_channel: 'embed', edit_version: 0 });
    expect(() => db.prepare(
      `UPDATE internal_form_submissions SET origin_channel = 'other'
       WHERE id = 'sub_existing'`,
    ).run()).toThrow(/CHECK constraint failed/i);
  });

  test('creates per-form notification settings with disabled and epoch-zero defaults', () => {
    if (!existsSync(MIGRATION_PATH)) return;
    const db = legacyDatabase();
    applyMigration(db);

    db.prepare(
      `INSERT INTO internal_form_notification_settings (form_id)
       VALUES ('form_existing')`,
    ).run();
    expect(db.prepare(
      `SELECT enabled, recipient_email_field_id, message_template, edit_link_epoch,
              created_at IS NOT NULL AS has_created_at, updated_at IS NOT NULL AS has_updated_at
       FROM internal_form_notification_settings WHERE form_id = 'form_existing'`,
    ).get()).toEqual({
      enabled: 0,
      recipient_email_field_id: null,
      message_template: null,
      edit_link_epoch: 0,
      has_created_at: 1,
      has_updated_at: 1,
    });
  });

  test('keeps the declarative schema synchronized', () => {
    const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS internal_form_notification_settings/i);
    expect(schema).toMatch(/origin_channel\s+TEXT NOT NULL DEFAULT 'embed'/i);
    expect(schema).toMatch(/edit_version\s+INTEGER NOT NULL DEFAULT 0/i);
  });
});
