import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { friendFieldDefinitions } from './friend-field-definitions.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
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
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
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

function app() {
  const hono = new Hono<Env>();
  hono.route('/', friendFieldDefinitions);
  return hono;
}

function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { DB } as Env['Bindings']);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('/api/friend-field-definitions CRUD', () => {
  test('初期値は空配列で、作成した定義を表示順に返す', async () => {
    const initial = await call('GET', '/api/friend-field-definitions');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ success: true, data: [] });

    const later = await call('POST', '/api/friend-field-definitions', {
      name: ' 入金確認 ',
      defaultValue: '未',
      displayOrder: 20,
      isActive: true,
    });
    expect(later.status).toBe(201);
    expect(await later.json()).toMatchObject({
      success: true,
      data: { name: '入金確認', defaultValue: '未', displayOrder: 20, isActive: true },
    });

    await call('POST', '/api/friend-field-definitions', {
      name: '担当者',
      defaultValue: '未定',
      displayOrder: 10,
      isActive: false,
    });
    const listed = await call('GET', '/api/friend-field-definitions');
    const json = await listed.json() as { data: Array<{ name: string }> };
    expect(json.data.map((definition) => definition.name)).toEqual(['担当者', '入金確認']);
  });

  test('PATCH で項目名・既定値・順序・有効状態を更新し、DELETE で削除する', async () => {
    const createdResponse = await call('POST', '/api/friend-field-definitions', {
      name: '入金確認',
      defaultValue: '未',
      displayOrder: 0,
      isActive: true,
    });
    const created = await createdResponse.json() as { data: { id: string } };

    const patched = await call('PATCH', `/api/friend-field-definitions/${created.data.id}`, {
      name: '決済状態',
      defaultValue: '保留',
      displayOrder: 3,
      isActive: false,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      data: { name: '決済状態', defaultValue: '保留', displayOrder: 3, isActive: false },
    });

    const removed = await call('DELETE', `/api/friend-field-definitions/${created.data.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true, data: null });
    expect((await (await call('GET', '/api/friend-field-definitions')).json()) as unknown).toEqual({ success: true, data: [] });
  });

  test('予約キー・空名・長すぎる名前・不正な型を DB 書込前に 400 で拒否する', async () => {
    const invalidBodies = [
      { name: '__formaloo_friend_metadata_sync' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: '正常', displayOrder: 1.5 },
      { name: '正常', isActive: 'yes' },
      { name: '正常', defaultValue: 1 },
    ];
    for (const body of invalidBodies) {
      const response = await call('POST', '/api/friend-field-definitions', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((raw.prepare('SELECT COUNT(*) AS count FROM friend_field_definitions').get() as { count: number }).count).toBe(0);
  });

  test('同名定義は 409、存在しない ID の更新・削除は 404', async () => {
    const body = { name: '入金確認', defaultValue: '未', displayOrder: 0, isActive: true };
    expect((await call('POST', '/api/friend-field-definitions', body)).status).toBe(201);
    expect((await call('POST', '/api/friend-field-definitions', body)).status).toBe(409);
    expect((await call('PATCH', '/api/friend-field-definitions/missing', { defaultValue: '済' })).status).toBe(404);
    expect((await call('DELETE', '/api/friend-field-definitions/missing')).status).toBe(404);
  });
});
