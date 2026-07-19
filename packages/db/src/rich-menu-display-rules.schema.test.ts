import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_PATH = join(MIGRATIONS_DIR, '107_rich_menu_display_rules.sql');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const sql of statements) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
});

describe('migration 107 — conditional rich menu rules', () => {
  test('adds account rules, successful assignments, retry queue, and bounded reapply jobs', () => {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(expect.arrayContaining([
      'rich_menu_display_rules',
      'rich_menu_friend_assignments',
      'rich_menu_rule_evaluation_queue',
      'rich_menu_rule_reapply_jobs',
    ]));
  });

  test('is additive migration 107 only', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|RENAME|UPDATE|DELETE)\b/im);
  });

  test('queues every tag and metadata change without touching a new friend row', () => {
    const hasQueue = raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rich_menu_rule_evaluation_queue'")
      .get();
    expect(hasQueue).toBeTruthy();
    if (!hasQueue) return;

    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-1', 'ch-1', 'A', 'token', 'secret')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, metadata)
       VALUES ('friend-1', 'U1', NULL, '{}')`,
    ).run();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get()).toEqual({ count: 0 });

    raw.prepare("UPDATE friends SET line_account_id = 'acc-1' WHERE id = 'friend-1'").run();
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').get()).toEqual({ friend_id: 'friend-1' });

    raw.prepare("DELETE FROM rich_menu_rule_evaluation_queue WHERE friend_id = 'friend-1'").run();
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-1', 'tag-1')").run();
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').get()).toEqual({ friend_id: 'friend-1' });

    raw.prepare("DELETE FROM rich_menu_rule_evaluation_queue WHERE friend_id = 'friend-1'").run();
    raw.prepare("DELETE FROM tags WHERE id = 'tag-1'").run();
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').get()).toEqual({ friend_id: 'friend-1' });

    raw.prepare("DELETE FROM rich_menu_rule_evaluation_queue WHERE friend_id = 'friend-1'").run();
    raw.prepare("UPDATE friends SET metadata = metadata WHERE id = 'friend-1'").run();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get()).toEqual({ count: 0 });

    raw.prepare("UPDATE friends SET metadata = '{\"paid\":true}' WHERE id = 'friend-1'").run();
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').get()).toEqual({ friend_id: 'friend-1' });
  });

  test('queues friends whose tag name changes for tag-name conditions', () => {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-1', 'ch-1', 'A', 'token', 'secret')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id)
       VALUES ('friend-1', 'U1', 'acc-1')`,
    ).run();
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', '一般')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-1', 'tag-1')").run();
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();

    raw.prepare("UPDATE tags SET name = 'VIP会員' WHERE id = 'tag-1'").run();

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-1' }]);
  });

  test('does not resurrect queue rows while a tagged friend is cascade-deleted', () => {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-1', 'ch-1', 'A', 'token', 'secret')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id)
       VALUES ('friend-1', 'U1', 'acc-1')`,
    ).run();
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-1', 'tag-1')").run();
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();

    expect(() => raw.prepare("DELETE FROM friends WHERE id = 'friend-1'").run()).not.toThrow();
    expect(raw.prepare('SELECT * FROM rich_menu_rule_evaluation_queue').all()).toEqual([]);
  });
});
