import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_NAME = '124_template_pack_message_types.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_NAME);
const OLD_TYPES = ['text', 'flex'] as const;
const NEW_TYPES = ['image', 'video', 'audio', 'sticker', 'imagemap', 'richvideo'] as const;

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE tags (id TEXT PRIMARY KEY);
    CREATE TABLE campaigns (id TEXT PRIMARY KEY);
    CREATE TABLE sender_presets (id TEXT PRIMARY KEY);
    CREATE TABLE ab_tests (
      id TEXT PRIMARY KEY,
      winner_broadcast_id TEXT REFERENCES broadcasts (id) ON DELETE SET NULL
    );
    CREATE TABLE broadcasts (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video', 'audio', 'imagemap', 'richvideo')),
      message_content    TEXT NOT NULL,
      target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
      target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
      status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
      scheduled_at       TEXT,
      sent_at            TEXT,
      total_count        INTEGER NOT NULL DEFAULT 0,
      success_count      INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      line_account_id    TEXT,
      alt_text           TEXT,
      line_request_id    TEXT,
      aggregation_unit   TEXT,
      batch_offset       INTEGER NOT NULL DEFAULT 0,
      segment_conditions TEXT,
      account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
      dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
      failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)),
      dedup_progress     TEXT,
      batch_lock_at      TEXT,
      campaign_id        TEXT REFERENCES campaigns (id) ON DELETE SET NULL,
      sender_preset_id   TEXT REFERENCES sender_presets (id) ON DELETE SET NULL,
      ab_test_id         TEXT REFERENCES ab_tests (id) ON DELETE SET NULL,
      ab_variant         TEXT,
      messages           TEXT
    );
    CREATE INDEX idx_broadcasts_status ON broadcasts (status);
    CREATE INDEX idx_broadcasts_campaign ON broadcasts (campaign_id);
    CREATE INDEX idx_broadcasts_ab_test_id ON broadcasts (ab_test_id);
    CREATE TABLE broadcast_insights (
      id TEXT PRIMARY KEY,
      broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE
    );
    CREATE TABLE messages_log (
      id TEXT PRIMARY KEY,
      broadcast_id TEXT REFERENCES broadcasts(id) ON DELETE SET NULL
    );
    CREATE TABLE template_packs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE template_pack_items (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES template_packs(id) ON DELETE CASCADE,
      order_index INTEGER NOT NULL,
      message_type TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
      message_content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_template_pack_items_pack ON template_pack_items(pack_id, order_index);
  `);
  return db;
}

function broadcastSnapshot(db: Database.Database): unknown {
  return db.prepare(`
    SELECT *,
      hex(title) AS title_hex,
      hex(message_content) AS message_content_hex,
      hex(segment_conditions) AS segment_conditions_hex,
      hex(messages) AS messages_hex
    FROM broadcasts
    WHERE id = 'broadcast-full-row'
  `).get();
}

function broadcastShape(db: Database.Database): unknown {
  const columns = db.prepare(`PRAGMA table_info('broadcasts')`).all();
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list('broadcasts')`).all();
  const indexes = (db.prepare(`PRAGMA index_list('broadcasts')`).all() as Array<{ name: string; origin: string }>)
    .filter((index) => index.origin !== 'pk')
    .map((index) => ({
      name: index.name,
      columns: (db.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map((column) => column.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { columns, foreignKeys, indexes };
}

function itemSnapshot(db: Database.Database): unknown[] {
  return db.prepare(`
    SELECT id, pack_id, order_index, message_type, hex(message_content) AS content_hex, created_at, updated_at
    FROM template_pack_items
    ORDER BY order_index
  `).all();
}

function checkTypes(sql: string): string {
  const match = sql.match(/CREATE TABLE(?: IF NOT EXISTS)? template_pack_items[\s\S]*?message_type\s+TEXT NOT NULL CHECK \(message_type IN \(([^)]*)\)\)/);
  expect(match, 'template_pack_items message_type CHECK must exist').not.toBeNull();
  return match![1];
}

function broadcastCheckTypes(sql: string): string {
  const match = sql.match(/CREATE TABLE(?: IF NOT EXISTS)? ["']?broadcasts["']?[\s\S]*?message_type\s+TEXT NOT NULL CHECK \(message_type IN \(([^)]*)\)\)/);
  expect(match, 'broadcasts message_type CHECK must exist').not.toBeNull();
  return match![1];
}

describe('migration 124: template-pack outbound message types', () => {
  test('exists, passes the scoped migration guard, widens CHECK, and preserves legacy rows byte-for-byte', () => {
    expect(existsSync(MIGRATION_PATH), `${MIGRATION_NAME} must be added`).toBe(true);
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(checkMigration(migrationSql, MIGRATION_NAME)).toEqual({ ok: true });

    const db = legacyDb();
    db.prepare(`INSERT INTO line_accounts (id) VALUES ('acc-1')`).run();
    db.prepare(`INSERT INTO template_packs VALUES ('pack-1','acc-1','legacy','created-pack','updated-pack')`).run();
    const legacyText = '日本語🙂\r\ntrailing spaces  ';
    const legacyFlex = '{\n  "type": "bubble",\n  "body": { "type": "box", "layout": "vertical", "contents": [] }\n}';
    db.prepare(`INSERT INTO template_pack_items VALUES (?,?,?,?,?,?,?)`).run('item-text', 'pack-1', 0, 'text', legacyText, 'created-text', 'updated-text');
    db.prepare(`INSERT INTO template_pack_items VALUES (?,?,?,?,?,?,?)`).run('item-flex', 'pack-1', 1, 'flex', legacyFlex, 'created-flex', 'updated-flex');
    const before = itemSnapshot(db);

    db.exec(migrationSql);

    expect(itemSnapshot(db)).toEqual(before);
    const insert = db.prepare(`INSERT INTO template_pack_items VALUES (?, 'pack-1', ?, ?, '{}', 'created', 'updated')`);
    [...OLD_TYPES, ...NEW_TYPES].forEach((messageType, index) => {
      expect(() => insert.run(`insert-${messageType}`, index + 2, messageType), messageType).not.toThrow();
    });
    expect(() => insert.run('item-unknown', 99, 'unknown')).toThrow();
  });

  test('allows a sticker-first pack mirror in broadcasts and preserves the canonical full row, FKs, and indexes', () => {
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    const db = legacyDb();
    db.prepare(`INSERT INTO tags VALUES ('tag-1')`).run();
    db.prepare(`INSERT INTO campaigns VALUES ('campaign-1')`).run();
    db.prepare(`INSERT INTO sender_presets VALUES ('sender-1')`).run();
    db.prepare(`INSERT INTO ab_tests (id) VALUES ('ab-1')`).run();
    db.prepare(`
      INSERT INTO broadcasts (
        id, title, message_type, message_content, target_type, target_tag_id, status,
        scheduled_at, sent_at, total_count, success_count, created_at, line_account_id,
        alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
        account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at,
        campaign_id, sender_preset_id, ab_test_id, ab_variant, messages
      ) VALUES (
        @id, @title, @message_type, @message_content, @target_type, @target_tag_id, @status,
        @scheduled_at, @sent_at, @total_count, @success_count, @created_at, @line_account_id,
        @alt_text, @line_request_id, @aggregation_unit, @batch_offset, @segment_conditions,
        @account_ids, @dedup_priority, @failed_account_ids, @dedup_progress, @batch_lock_at,
        @campaign_id, @sender_preset_id, @ab_test_id, @ab_variant, @messages
      )
    `).run({
      id: 'broadcast-full-row',
      title: '日本語🙂\r\ntrailing spaces  ',
      message_type: 'richvideo',
      message_content: '{\n  "baseUrl": "https://example.test/rich"\n}\r\n',
      target_type: 'multi-account-dedup',
      target_tag_id: 'tag-1',
      status: 'sent',
      scheduled_at: '2026-07-21T01:02:03.004+09:00',
      sent_at: '2026-07-21T02:03:04.005+09:00',
      total_count: 123456789,
      success_count: 123456788,
      created_at: '2026-07-20T23:59:59.999+09:00',
      line_account_id: 'acc-raw-🙂',
      alt_text: '代替文字  ',
      line_request_id: 'req/full-row',
      aggregation_unit: 'unit-1',
      batch_offset: 37,
      segment_conditions: '{"name":"日本語","values":[1,2]}\r\n',
      account_ids: '["acc-a","acc-b"]',
      dedup_priority: '["acc-b","acc-a"]',
      failed_account_ids: '["acc-z"]',
      dedup_progress: '{"cursor":"🙂"}',
      batch_lock_at: '2026-07-21T01:30:00.000+09:00',
      campaign_id: 'campaign-1',
      sender_preset_id: 'sender-1',
      ab_test_id: 'ab-1',
      ab_variant: 'B',
      messages: '[{"type":"text","content":"byte exact  "}]\r\n',
    });
    db.prepare(`INSERT INTO broadcast_insights VALUES ('insight-1', 'broadcast-full-row')`).run();
    db.prepare(`INSERT INTO messages_log VALUES ('message-1', 'broadcast-full-row')`).run();
    db.prepare(`UPDATE ab_tests SET winner_broadcast_id = 'broadcast-full-row' WHERE id = 'ab-1'`).run();
    const beforeRow = broadcastSnapshot(db);
    const beforeShape = broadcastShape(db);
    const beforeChildren = {
      insight: db.prepare(`SELECT * FROM broadcast_insights`).all(),
      message: db.prepare(`SELECT * FROM messages_log`).all(),
      winner: db.prepare(`SELECT id, winner_broadcast_id FROM ab_tests`).all(),
    };

    db.exec(migrationSql);

    expect(broadcastSnapshot(db)).toEqual(beforeRow);
    expect(broadcastShape(db)).toEqual(beforeShape);
    expect({
      insight: db.prepare(`SELECT * FROM broadcast_insights`).all(),
      message: db.prepare(`SELECT * FROM messages_log`).all(),
      winner: db.prepare(`SELECT id, winner_broadcast_id FROM ab_tests`).all(),
    }).toEqual(beforeChildren);
    db.pragma('foreign_keys = ON');
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(() => db.prepare(`
      INSERT INTO broadcasts (id, title, message_type, message_content)
      VALUES ('broadcast-sticker-first', 'sticker pack', 'sticker', '{"packageId":"11537","stickerId":"52002734"}')
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO broadcasts (id, title, message_type, message_content)
      VALUES ('broadcast-unknown', 'unknown', 'unknown', '{}')
    `).run()).toThrow();
  });

  test.each(['schema.sql', 'bootstrap.sql'])('%s declares all D-3 pack and broadcast types', (filename) => {
    const sql = readFileSync(join(PKG_ROOT, filename), 'utf8');
    const allowed = checkTypes(sql);
    for (const messageType of [...OLD_TYPES, ...NEW_TYPES]) {
      expect(allowed, `${filename} must allow ${messageType}`).toContain(`'${messageType}'`);
    }
    const broadcastAllowed = broadcastCheckTypes(sql);
    for (const messageType of ['text', 'image', 'flex', 'video', 'audio', 'sticker', 'imagemap', 'richvideo']) {
      expect(broadcastAllowed, `${filename} broadcasts must allow ${messageType}`).toContain(`'${messageType}'`);
    }
  });

  test('bootstrap metadata includes migration 124', () => {
    const meta = JSON.parse(readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8')) as { includedMigrations: string[] };
    expect(meta.includedMigrations).toContain(MIGRATION_NAME);
  });
});
