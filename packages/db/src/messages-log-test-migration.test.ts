import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '../migrations');
const sql = (name: string) => readFileSync(join(migrations, name), 'utf8');

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE friends (id TEXT PRIMARY KEY);
    CREATE TABLE broadcasts (id TEXT PRIMARY KEY);
    CREATE TABLE scenario_steps (id TEXT PRIMARY KEY);
    CREATE TABLE messages_log (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      broadcast_id TEXT REFERENCES broadcasts(id) ON DELETE SET NULL,
      scenario_step_id TEXT REFERENCES scenario_steps(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO friends (id) VALUES ('friend-1');
    INSERT INTO broadcasts (id) VALUES ('broadcast-1');
    INSERT INTO scenario_steps (id) VALUES ('step-1');
  `);
  for (const name of [
    '009_delivery_type.sql',
    '028_messages_log_source.sql',
    '032_messages_log_line_account_id.sql',
    '038_scenario_templates_and_stats.sql',
  ]) db.exec(sql(name));
  return db;
}

describe('115 messages_log delivery_type=test migration', () => {
  test('reproduces the old 009 constraint, then widens it without losing rows, columns, indexes, or FKs', () => {
    const db = legacyDatabase();
    expect(() => db.prepare(`
      INSERT INTO messages_log
        (id, friend_id, direction, message_type, content, delivery_type, created_at)
      VALUES ('before-test', 'friend-1', 'outgoing', 'text', 'x', 'test', '2026-07-20')
    `).run()).toThrow(/CHECK constraint failed/i);

    db.prepare(`
      INSERT INTO messages_log
        (id, friend_id, direction, message_type, content, broadcast_id,
         scenario_step_id, delivery_type, source, line_account_id,
         template_id_at_send, created_at)
      VALUES (?, ?, 'outgoing', 'text', ?, ?, ?, 'push', ?, ?, ?, ?)
    `).run(
      'legacy-row', 'friend-1', 'legacy-content', 'broadcast-1', 'step-1',
      'scenario', 'acc-1', 'template-1', '2026-07-20T00:00:00+09:00',
    );

    db.exec(sql('115_messages_log_delivery_type_test.sql'));

    expect(db.prepare(`SELECT * FROM messages_log WHERE id = 'legacy-row'`).get()).toEqual({
      id: 'legacy-row',
      friend_id: 'friend-1',
      direction: 'outgoing',
      message_type: 'text',
      content: 'legacy-content',
      broadcast_id: 'broadcast-1',
      scenario_step_id: 'step-1',
      template_id_at_send: 'template-1',
      delivery_type: 'push',
      source: 'scenario',
      line_account_id: 'acc-1',
      created_at: '2026-07-20T00:00:00+09:00',
    });
    expect(() => db.prepare(`
      INSERT INTO messages_log
        (id, friend_id, direction, message_type, content, delivery_type, created_at)
      VALUES ('after-test', 'friend-1', 'outgoing', 'text', 'x', 'test', '2026-07-20')
    `).run()).not.toThrow();

    const indexes = (db.prepare(`PRAGMA index_list('messages_log')`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_messages_log_broadcast_id',
      'idx_messages_log_friend_id',
      'idx_messages_log_created_at',
      'idx_messages_log_friend_source',
      'idx_messages_log_friend_direction_created',
    ]));
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='test_send_requests'`).get())
      .toEqual({ name: 'test_send_requests' });
  });
});
