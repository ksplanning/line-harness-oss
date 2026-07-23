import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createBroadcast,
  getBroadcastById,
  recoverStalledBroadcasts,
  updateBroadcast,
} from './broadcasts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const MIGRATION_FILE = '138_broadcast_recipient_snapshots.sql';
const MIGRATION_PATH = join(MIGRATIONS_DIR, MIGRATION_FILE);
const BENIGN = /duplicate column name|already exists/i;

function applyStatements(db: Database.Database, sql: string): void {
  for (const statement of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.trim())
    .filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    applyStatements(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          params = values;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('broadcast segment condition persistence', () => {
  test('create/get/update/clear round-trips segment_conditions JSON', async () => {
    const initialConditions = JSON.stringify({
      operator: 'AND',
      rules: [
        { type: 'tag_not_exists', value: 'tag-excluded' },
        { type: 'metadata_equals', value: { key: 'plan', value: 'pro' } },
      ],
    });

    const created = await createBroadcast(db, {
      title: '条件配信',
      messageType: 'text',
      messageContent: 'hello',
      targetType: 'segment',
      segmentConditions: initialConditions,
    });

    expect(created.target_type).toBe('segment');
    expect(created.target_tag_id).toBeNull();
    expect(created.segment_conditions).toBe(initialConditions);
    expect((await getBroadcastById(db, created.id))?.segment_conditions).toBe(initialConditions);

    const updatedConditions = JSON.stringify({
      operator: 'OR',
      rules: [
        { type: 'metadata_not_equals', value: { key: 'plan', value: 'free' } },
        { type: 'metadata_empty', value: { key: 'region' } },
      ],
    });
    await updateBroadcast(db, created.id, { segment_conditions: updatedConditions });
    expect((await getBroadcastById(db, created.id))?.segment_conditions).toBe(updatedConditions);

    await updateBroadcast(db, created.id, { segment_conditions: null });
    expect((await getBroadcastById(db, created.id))?.segment_conditions).toBeNull();
  });

  test('legacy tag broadcast keeps segment_conditions null', async () => {
    raw.prepare(
      `INSERT INTO tags (id, name, color, created_at)
       VALUES ('tag-legacy', '既存タグ', '#000000', '2026-07-23T00:00:00+09:00')`,
    ).run();

    const created = await createBroadcast(db, {
      title: '従来タグ配信',
      messageType: 'text',
      messageContent: 'legacy',
      targetType: 'tag',
      targetTagId: 'tag-legacy',
    });

    expect(created.target_type).toBe('tag');
    expect(created.target_tag_id).toBe('tag-legacy');
    expect(created.segment_conditions).toBeNull();
  });

  test('guarded updates cannot modify a broadcast after delivery claims it', async () => {
    const created = await createBroadcast(db, {
      title: '競合確認',
      messageType: 'text',
      messageContent: 'before',
      targetType: 'segment',
      segmentConditions: JSON.stringify({
        operator: 'AND',
        rules: [{ type: 'tag_not_exists', value: 'tag-excluded' }],
      }),
    });
    raw.prepare(`UPDATE broadcasts SET status = 'sending' WHERE id = ?`).run(created.id);

    await expect(updateBroadcast(
      db,
      created.id,
      { message_content: 'must-not-win' },
      { expectedStatuses: ['draft', 'scheduled'] },
    )).resolves.toBeNull();
    expect((await getBroadcastById(db, created.id))?.message_content).toBe('before');
  });
});

describe('migration 138 — broadcast recipient snapshots', () => {
  test('is additive and creates the snapshot table with a composite primary key', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/^\s*(?:DROP|RENAME|DELETE|UPDATE)\b/im);
    expect(sql).not.toMatch(/^\s*ALTER\s+TABLE\b/im);

    const migrationDb = new Database(':memory:');
    migrationDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE broadcasts (id TEXT PRIMARY KEY);
      CREATE TABLE friends (id TEXT PRIMARY KEY);
      INSERT INTO broadcasts (id) VALUES ('broadcast-existing');
      INSERT INTO friends (id) VALUES ('friend-existing');
    `);

    migrationDb.exec(sql);

    const columns = migrationDb
      .prepare(`PRAGMA table_info(broadcast_recipient_snapshots)`)
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'broadcast_id',
      'friend_id',
      'line_user_id',
      'created_at',
    ]);
    expect(columns.find((column) => column.name === 'broadcast_id')).toMatchObject({
      notnull: 1,
      pk: 1,
    });
    expect(columns.find((column) => column.name === 'friend_id')).toMatchObject({
      notnull: 1,
      pk: 2,
    });
    expect(columns.find((column) => column.name === 'line_user_id')?.notnull).toBe(1);
    expect(columns.find((column) => column.name === 'created_at')?.notnull).toBe(1);

    migrationDb.prepare(
      `INSERT INTO broadcast_recipient_snapshots
         (broadcast_id, friend_id, line_user_id)
       VALUES ('broadcast-existing', 'friend-existing', 'U-existing')`,
    ).run();
    expect(() => migrationDb.prepare(
      `INSERT INTO broadcast_recipient_snapshots
         (broadcast_id, friend_id, line_user_id)
       VALUES ('broadcast-existing', 'friend-existing', 'U-duplicate')`,
    ).run()).toThrow(/UNIQUE/i);

    expect(migrationDb.prepare(
      `SELECT id FROM broadcasts WHERE id = 'broadcast-existing'`,
    ).get()).toEqual({ id: 'broadcast-existing' });
    expect(migrationDb.prepare(
      `SELECT id FROM friends WHERE id = 'friend-existing'`,
    ).get()).toEqual({ id: 'friend-existing' });
    migrationDb.close();
  });

  test.each(['schema.sql', 'bootstrap.sql'])(
    '%s contains the snapshot table for fresh databases',
    (file) => {
      const freshDb = new Database(':memory:');
      freshDb.exec(readFileSync(join(PKG_ROOT, file), 'utf8'));
      const columns = freshDb
        .prepare(`PRAGMA table_info(broadcast_recipient_snapshots)`)
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        'broadcast_id',
        'friend_id',
        'line_user_id',
        'created_at',
      ]);
      freshDb.close();
    },
  );

  test('bootstrap metadata includes migration 138', () => {
    const metadata = JSON.parse(
      readFileSync(join(PKG_ROOT, 'bootstrap-meta.json'), 'utf8'),
    ) as { includedMigrations: string[] };
    expect(metadata.includedMigrations).toContain(MIGRATION_FILE);
  });

  test('stale conditional build locks fail closed and completed batches resume from success_count', async () => {
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, display_name)
       VALUES ('friend-snapshot', 'U-snapshot', 'snapshot')`,
    ).run();
    const build = await createBroadcast(db, {
      title: 'build lock',
      messageType: 'text',
      messageContent: 'x',
      targetType: 'segment',
      segmentConditions: '{"operator":"AND","rules":[{"type":"tag_exists","value":"vip"}]}',
    });
    const resume = await createBroadcast(db, {
      title: 'resume lock',
      messageType: 'text',
      messageContent: 'x',
      targetType: 'segment',
      segmentConditions: '{"operator":"AND","rules":[{"type":"tag_exists","value":"vip"}]}',
    });
    raw.prepare(
      `INSERT INTO broadcast_recipient_snapshots
         (broadcast_id, friend_id, line_user_id)
       VALUES (?, 'friend-snapshot', 'U-snapshot')`,
    ).run(build.id);
    raw.prepare(
      `UPDATE broadcasts
       SET status = 'sending', batch_offset = -2,
           batch_lock_at = '2000-01-01T00:00:00.000'
       WHERE id = ?`,
    ).run(build.id);
    raw.prepare(
      `UPDATE broadcasts
       SET status = 'sending', batch_offset = -1, success_count = 500,
           batch_lock_at = '2000-01-01T00:00:00.000'
       WHERE id = ?`,
    ).run(resume.id);

    await recoverStalledBroadcasts(db);

    expect(raw.prepare(
      `SELECT status, batch_offset, total_count FROM broadcasts WHERE id = ?`,
    ).get(build.id)).toEqual({ status: 'draft', batch_offset: 0, total_count: 0 });
    expect(raw.prepare(
      `SELECT COUNT(*) AS count
       FROM broadcast_recipient_snapshots WHERE broadcast_id = ?`,
    ).get(build.id)).toEqual({ count: 0 });
    expect(raw.prepare(
      `SELECT status, batch_offset FROM broadcasts WHERE id = ?`,
    ).get(resume.id)).toEqual({ status: 'sending', batch_offset: 500 });
  });
});
