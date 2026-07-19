import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_PATH = join(MIGRATIONS_DIR, '107_rich_menu_display_rules.sql');
const SCHEDULE_MIGRATION_PATH = join(MIGRATIONS_DIR, '112_rich_menu_rule_schedule.sql');
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
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority)
       VALUES ('rule-1', 'acc-1', '購入済み', 'tag_exists', 'tag-1', 'menu-1', 10)`,
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
    raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority)
       VALUES ('rule-1', 'acc-1', 'VIP', 'tag_name_contains', 'VIP', 'menu-1', 10)`,
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

  test('keeps rule-less tenants byte-compatible by not creating background work', () => {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-1', 'ch-1', 'A', 'token', 'secret')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, metadata)
       VALUES ('friend-1', 'U1', NULL, '{}')`,
    ).run();
    raw.prepare("UPDATE friends SET line_account_id = 'acc-1' WHERE id = 'friend-1'").run();
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', 'VIP')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-1', 'tag-1')").run();
    raw.prepare("UPDATE friends SET metadata = '{\"rank\":\"VIP\"}' WHERE id = 'friend-1'").run();
    raw.prepare("UPDATE tags SET name = '特別VIP' WHERE id = 'tag-1'").run();

    expect(raw.prepare('SELECT * FROM rich_menu_rule_evaluation_queue').all()).toEqual([]);
  });

  test('requeues managed friends when their LINE account becomes active again', () => {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
       VALUES ('acc-1', 'ch-1', 'A', 'token', 'secret', 0)`,
    ).run();
    raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority)
       VALUES ('rule-1', 'acc-1', 'VIP', 'tag_exists', 'tag-vip', 'menu-1', 10)`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id)
       VALUES ('friend-1', 'U1', 'acc-1')`,
    ).run();

    raw.prepare("UPDATE line_accounts SET is_active = 1 WHERE id = 'acc-1'").run();

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-1' }]);
  });

  test('requeues a managed friend when they follow the account again', () => {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-1', 'ch-1', 'A', 'token', 'secret')`,
    ).run();
    raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority)
       VALUES ('rule-1', 'acc-1', 'VIP', 'tag_exists', 'tag-vip', 'menu-1', 10)`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, is_following)
       VALUES ('friend-1', 'U1', 'acc-1', 0)`,
    ).run();

    raw.prepare("UPDATE friends SET is_following = 1 WHERE id = 'friend-1'").run();

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-1' }]);
  });
});

describe('migration 112 — rich menu rule schedule', () => {
  test('adds nullable active_from and active_until columns without changing existing rule defaults', () => {
    expect(existsSync(SCHEDULE_MIGRATION_PATH)).toBe(true);
    if (!existsSync(SCHEDULE_MIGRATION_PATH)) return;

    const sql = readFileSync(SCHEDULE_MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/ALTER TABLE rich_menu_display_rules\s+ADD COLUMN active_from TEXT/i);
    expect(sql).toMatch(/ALTER TABLE rich_menu_display_rules\s+ADD COLUMN active_until TEXT/i);
    expect(sql).not.toMatch(/^\s*(DROP|RENAME|UPDATE|DELETE)\b/im);

    const columns = raw.prepare('PRAGMA table_info(rich_menu_display_rules)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'active_from', notnull: 0, dflt_value: null }),
      expect.objectContaining({ name: 'active_until', notnull: 0, dflt_value: null }),
    ]));

    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-schedule', 'ch-schedule', 'Schedule', 'token', 'secret')`,
    ).run();
    raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id)
       VALUES ('rule-legacy', 'acc-schedule', '既存相当', 'tag_exists', 'tag-1', 'menu-1')`,
    ).run();
    expect(raw.prepare(
      'SELECT active_from, active_until FROM rich_menu_display_rules WHERE id = ?',
    ).get('rule-legacy')).toEqual({ active_from: null, active_until: null });
  });
});
