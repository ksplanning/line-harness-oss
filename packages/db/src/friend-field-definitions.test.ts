import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createFriendFieldDefinition,
  deleteFriendFieldDefinition,
  getFriendFieldDefinition,
  listFriendFieldDefinitions,
  updateFriendFieldDefinition,
} from './friend-field-definitions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
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
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  DB = d1(raw);
});

describe('migration 105 — tenant friend field definitions', () => {
  test('項目名・既定値・表示順・有効フラグを持つ additive table と lookup index を追加する', () => {
    const columns = raw.prepare('PRAGMA table_info(friend_field_definitions)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id',
      'name',
      'default_value',
      'display_order',
      'is_active',
    ]));
    expect(columns.find((column) => column.name === 'default_value')?.dflt_value).toBe("''");
    expect(columns.find((column) => column.name === 'display_order')?.dflt_value).toBe('0');
    expect(columns.find((column) => column.name === 'is_active')?.dflt_value).toBe('1');

    const indexes = raw.prepare('PRAGMA index_list(friend_field_definitions)').all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === 'idx_friend_field_definitions_active_order')).toBe(true);
    expect(indexes.some((index) => index.name === 'idx_friend_field_definitions_name')).toBe(true);
  });

  test('migration は既存 metadata を変換せず CREATE のみを行う', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '105_friend_field_definitions.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|RENAME|UPDATE|DELETE)\b/im);
  });
});

describe('friend field definition model', () => {
  test('tenant 内の全体定義を表示順で返し、有効な定義だけにも絞れる', async () => {
    await createFriendFieldDefinition(DB, {
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 20,
      isActive: true,
    });
    await createFriendFieldDefinition(DB, {
      name: '担当者',
      defaultValue: '未定',
      displayOrder: 10,
      isActive: false,
    });

    const all = await listFriendFieldDefinitions(DB);
    expect(all.map((definition) => definition.name)).toEqual(['担当者', '入金確認']);
    expect(all.map((definition) => definition.isActive)).toEqual([false, true]);
    expect(await listFriendFieldDefinitions(DB, { activeOnly: true })).toHaveLength(1);
  });

  test('更新・削除を round-trip する', async () => {
    const created = await createFriendFieldDefinition(DB, {
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 0,
      isActive: true,
    });

    const updated = await updateFriendFieldDefinition(DB, created.id, {
      name: '決済状態',
      defaultValue: '保留',
      displayOrder: 3,
      isActive: false,
    });
    expect(updated).toMatchObject({
      name: '決済状態',
      defaultValue: '保留',
      displayOrder: 3,
      isActive: false,
    });
    expect(await deleteFriendFieldDefinition(DB, created.id)).toBe(true);
    expect(await getFriendFieldDefinition(DB, created.id)).toBeNull();
  });

  test('同一 tenant 内の項目名は一意', async () => {
    const input = {
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 0,
      isActive: true,
    };
    await createFriendFieldDefinition(DB, input);
    await expect(createFriendFieldDefinition(DB, input)).rejects.toThrow();
  });

  test('KS/Piecemaker のような別 D1 tenant は同じコード・同じ項目名でもデータを共有しない', async () => {
    await createFriendFieldDefinition(DB, {
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 0,
      isActive: true,
    });

    const otherRaw = new Database(':memory:');
    replayAll(otherRaw);
    const otherDB = d1(otherRaw);
    expect(await listFriendFieldDefinitions(otherDB)).toEqual([]);
    await expect(createFriendFieldDefinition(otherDB, {
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 0,
      isActive: true,
    })).resolves.toBeTruthy();
  });
});
