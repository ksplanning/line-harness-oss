/**
 * owner 自己締め出し防止 (G64 R-3 / T-C1 / T-C2) — real SQLite。
 *   - T-C1: owner は制限 custom role を割り当てても全 19 feature allow (owner 全権不変 / staff_admin 剥奪不可)
 *   - T-C2(b): 実行者が自分自身のオーナー権限を外す PATCH は 403 (self-lock 防止)
 *   - T-C2(a): 最後の active owner の降格は 400 (既存ガード / byte-identical)
 *   - T-C2(c): 最後の active owner の削除は 400 (既存ガード)
 * ※ 既存ガードは 400 のまま (D-1 byte-identical) / 新設の self-lock は 403。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createRole, setRolePermissions } from '@line-crm/db';
import { resolvePermissions as workerResolve } from '../middleware/permissions.js';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { staff as staffRoutes } from './staff.js';
import { roles as rolesRoutes } from './roles.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', staffRoutes);
  a.route('/', rolesRoutes);
  return a;
}

function call(method: string, path: string, body?: unknown, auth = 'Bearer env-owner-key') {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('T-C1: owner は custom role でも全権', () => {
  test('制限 custom role を割り当てた owner の resolvePermissions が全20', async () => {
    const r = await createRole(DB, { name: 'チャットのみ' });
    await setRolePermissions(DB, r.id, [{ feature_key: 'chat', allowed: true }]);
    const p = await workerResolve(DB, { id: 'owner-x', role: 'owner', roleId: r.id });
    expect(p.features.length).toBe(20);
    expect(p.allows('staff_admin')).toBe(true); // 剥奪されない
  });

  test('owner staff を custom role 付きで作成 → /staff/me が全20', async () => {
    const rid = (await (await call('POST', '/api/roles', { name: 'r', template: 'chat_only' })).json() as { data: { id: string } }).data.id;
    const created = await call('POST', '/api/staff', { name: '共同オーナー', role: 'owner', roleId: rid });
    const apiKey = (await created.json() as { data: { apiKey: string } }).data.apiKey;
    const me = await call('GET', '/api/staff/me', undefined, `Bearer ${apiKey}`);
    const data = (await me.json() as { data: { permissions: string[] } }).data;
    expect(data.permissions.length).toBe(20);
  });
});

describe('T-C2: self-lock / 最後の owner', () => {
  test('(b) 自分自身のオーナー権限を外す PATCH は 403', async () => {
    // owner2 を作り、その本人 (api_key) が自分を staff へ降格 → 403
    const created = await call('POST', '/api/staff', { name: 'owner2', role: 'owner' });
    const { id, apiKey } = (await created.json() as { data: { id: string; apiKey: string } }).data;
    const res = await call('PATCH', `/api/staff/${id}`, { role: 'staff' }, `Bearer ${apiKey}`);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/自分自身のオーナー権限/);
  });

  test('(b) 自分自身を無効化する PATCH も 403', async () => {
    const created = await call('POST', '/api/staff', { name: 'owner3', role: 'owner' });
    const { id, apiKey } = (await created.json() as { data: { id: string; apiKey: string } }).data;
    const res = await call('PATCH', `/api/staff/${id}`, { isActive: false }, `Bearer ${apiKey}`);
    expect(res.status).toBe(403);
  });

  test('(a) 最後の owner を別 owner が降格 → 400 (既存ガード byte-identical)', async () => {
    // DB owner が 1 人。env-owner (別実行者) が降格を試みる → 最後の1人ガードで 400。
    const created = await call('POST', '/api/staff', { name: 'onlyowner', role: 'owner' });
    const id = (await created.json() as { data: { id: string } }).data.id;
    const res = await call('PATCH', `/api/staff/${id}`, { role: 'staff' }); // env-owner 実行
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/オーナーは最低1人/);
  });

  test('(c) 最後の owner を削除しようとすると 400 (既存 DELETE ガード)', async () => {
    const created = await call('POST', '/api/staff', { name: 'onlyowner2', role: 'owner' });
    const id = (await created.json() as { data: { id: string } }).data.id;
    const res = await call('DELETE', `/api/staff/${id}`);
    expect(res.status).toBe(400);
  });

  test('owner が 2 人いれば別 owner の降格は通る (過剰ブロックしない)', async () => {
    const o1 = (await (await call('POST', '/api/staff', { name: 'o1', role: 'owner' })).json() as { data: { id: string } }).data.id;
    await call('POST', '/api/staff', { name: 'o2', role: 'owner' });
    // env-owner が o1 を降格 (o2 が残るので OK / 自己でもないので self-lock 非該当)
    const res = await call('PATCH', `/api/staff/${o1}`, { role: 'staff' });
    expect(res.status).toBe(200);
  });
});
