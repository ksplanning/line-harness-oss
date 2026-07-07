/**
 * permissionMiddleware (G64) real-SQLite 統合テスト — failure_observable #1 の直接固定。
 *   - custom role token で **API を直叩き** し、禁止 feature が 403 / 許可 feature が通過 (T-A3)。
 *     UI 非経由 = 「UI 隠しただけ」の穴を排除する証拠。
 *   - built-in role (role_id NULL) は未マップ path も allow (byte-identical) / custom role は未マップ deny
 *     の非対称 fail-closed (T-A4)。
 *   - env-owner Bearer は break-glass で全許可 (T-C1 の一部) / 未認証は 401 (authMiddleware 不変)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createRole, setRolePermissions, createStaffMember, setStaffRoleId } from '@line-crm/db';
import { authMiddleware } from './auth.js';
import { permissionMiddleware } from './permission-middleware.js';
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
  // 各 feature 領域を代表する軽量 probe route (permissionMiddleware の後段 = 権限通過時のみ到達)。
  a.get('/api/chats/probe', (c) => c.json({ ok: 'chat' }));
  a.get('/api/broadcasts/probe', (c) => c.json({ ok: 'broadcast' }));
  a.get('/api/staff/me', (c) => c.json({ ok: 'me' })); // null = 常に許可
  a.get('/api/totally-made-up-xyz/probe', (c) => c.json({ ok: 'unmapped' })); // 未マップ
  return a;
}

function get(path: string, apiKey?: string) {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return app().request(path, { headers }, env());
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

/** chat のみ許可の custom role を作り、その role を割り当てた staff の api_key を返す。 */
async function seedChatOnlyStaff(): Promise<string> {
  const role = await createRole(DB, { name: 'チャット対応のみ' });
  await setRolePermissions(DB, role.id, [
    { feature_key: 'chat', allowed: true },
    { feature_key: 'friend', allowed: true },
    { feature_key: 'broadcast', allowed: false },
  ]);
  const staff = await createStaffMember(DB, { name: '外注さん', role: 'staff' });
  await setStaffRoleId(DB, staff.id, role.id);
  return staff.api_key;
}

describe('custom role の API 直叩き (failure_observable #1)', () => {
  test('許可 feature は 200 / 禁止 feature は 403 (UI 非経由の直叩き)', async () => {
    const key = await seedChatOnlyStaff();
    const chat = await get('/api/chats/probe', key);
    expect(chat.status).toBe(200);

    const bc = await get('/api/broadcasts/probe', key);
    expect(bc.status).toBe(403);
    expect((await bc.json() as { error: string }).error).toMatch(/権限がありません/);
  });

  test('staff/me は権限に関係なく常に 200 (自分の情報)', async () => {
    const key = await seedChatOnlyStaff();
    expect((await get('/api/staff/me', key)).status).toBe(200);
  });

  test('custom role の未マップ path は deny (fail-closed / T-A4)', async () => {
    const key = await seedChatOnlyStaff();
    expect((await get('/api/totally-made-up-xyz/probe', key)).status).toBe(403);
  });
});

describe('built-in role byte-identical (T-A4 / D-1)', () => {
  test('built-in staff (role_id NULL) は禁止領域も含め全 probe 200 + 未マップも allow', async () => {
    const staff = await createStaffMember(DB, { name: '社員', role: 'staff' });
    expect((await get('/api/chats/probe', staff.api_key)).status).toBe(200);
    expect((await get('/api/broadcasts/probe', staff.api_key)).status).toBe(200);
    expect((await get('/api/totally-made-up-xyz/probe', staff.api_key)).status).toBe(200); // 未マップ allow
  });

  test('env-owner Bearer は break-glass で全許可', async () => {
    expect((await get('/api/broadcasts/probe', 'env-owner-key')).status).toBe(200);
    expect((await get('/api/totally-made-up-xyz/probe', 'env-owner-key')).status).toBe(200);
  });

  test('未認証は 401 (authMiddleware 不変・permission 層まで来ない)', async () => {
    expect((await get('/api/chats/probe')).status).toBe(401);
  });
});
