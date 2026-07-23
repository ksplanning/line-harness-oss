import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', '137_inquiry_console.sql');

describe('migration 137 — inquiry console state', () => {
  test('is additive-only and keeps legacy chat, message, and staff rows intact', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/^\s*(?:DROP|RENAME|DELETE|UPDATE)\b/im);
    expect(sql).not.toMatch(/^\s*ALTER\s+TABLE\s+\S+\s+(?!ADD\s+COLUMN)/im);

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE staff_members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread'
      );
      CREATE TABLE messages_log (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL,
        content TEXT NOT NULL
      );
      INSERT INTO staff_members (id, name, api_key) VALUES ('staff-1', '佐藤', 'key');
      INSERT INTO chats (id, friend_id, status) VALUES ('chat-1', 'friend-1', 'unread');
      INSERT INTO messages_log (id, friend_id, content) VALUES ('message-1', 'friend-1', '相談です');
    `);

    db.exec(sql);

    expect(db.prepare(
      `SELECT assigned_staff_id, read_at FROM chats WHERE id = 'chat-1'`,
    ).get()).toEqual({ assigned_staff_id: null, read_at: null });
    expect(db.prepare(
      `SELECT staff_member_id FROM messages_log WHERE id = 'message-1'`,
    ).get()).toEqual({ staff_member_id: null });
    expect(db.prepare(
      `SELECT reply_signature_enabled FROM staff_members WHERE id = 'staff-1'`,
    ).get()).toEqual({ reply_signature_enabled: 1 });
    db.close();
  });
});
