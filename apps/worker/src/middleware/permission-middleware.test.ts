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
  // 機微 sub-route の probe (reviewer Round1 H-1/H-2/M-1 の enforcement 固定)
  a.post('/api/friends/:id/messages', (c) => c.json({ ok: 'send' })); // 実送信路 = chat
  a.get('/api/friends/:id', (c) => c.json({ ok: 'friend-detail' })); // = friend
  a.post('/api/friends/:id/rich-menu', (c) => c.json({ ok: 'rmlink' })); // = rich_menu
  a.get('/api/friends/:id/reminders', (c) => c.json({ ok: 'friend-reminders' })); // = booking (G64 R2-1)
  return a;
}

function post(path: string, apiKey?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return app().request(path, { method: 'POST', headers, body: '{}' }, env());
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

describe('送信境界 (reviewer Round1 H-1/H-2 / friend 管理では送信・rich_menu へ到達させない)', () => {
  /** friend のみ許可 (chat/rich_menu は false) の custom role。 */
  async function seedFriendOnlyStaff(): Promise<string> {
    const role = await createRole(DB, { name: '友だち管理のみ' });
    await setRolePermissions(DB, role.id, [
      { feature_key: 'friend', allowed: true },
      { feature_key: 'chat', allowed: false },
      { feature_key: 'rich_menu', allowed: false },
    ]);
    const staff = await createStaffMember(DB, { name: '受付', role: 'staff' });
    await setStaffRoleId(DB, staff.id, role.id);
    return staff.api_key;
  }

  test('H-1: friend-only role は POST /api/friends/:id/messages で 403 (実顧客送信を阻止)', async () => {
    const key = await seedFriendOnlyStaff();
    // friend 詳細 (GET /api/friends/:id) は friend feature なので到達できる
    expect((await get('/api/friends/f1', key)).status).toBe(200);
    // だが送信 (POST messages = chat feature) は 403
    expect((await post('/api/friends/f1/messages', key)).status).toBe(403);
  });

  test('H-2: friend-only role は個別リッチメニュー紐付けで 403', async () => {
    const key = await seedFriendOnlyStaff();
    expect((await post('/api/friends/f1/rich-menu', key)).status).toBe(403);
  });

  test('chat 許可 role は POST /api/friends/:id/messages で送信到達 (200)', async () => {
    const key = await seedChatOnlyStaff(); // chat=true, friend=true, broadcast=false
    expect((await post('/api/friends/f1/messages', key)).status).toBe(200);
  });
});

describe('予約境界 (G64 R2-1 / GET /api/friends/:id/reminders は friend でなく booking)', () => {
  /** friend のみ許可 (booking は false) の custom role。 */
  async function seedFriendNoBookingStaff(): Promise<string> {
    const role = await createRole(DB, { name: '友だち管理のみ (予約なし)' });
    await setRolePermissions(DB, role.id, [
      { feature_key: 'friend', allowed: true },
      { feature_key: 'booking', allowed: false },
    ]);
    const staff = await createStaffMember(DB, { name: '受付', role: 'staff' });
    await setStaffRoleId(DB, staff.id, role.id);
    return staff.api_key;
  }

  /** booking のみ許可 (friend は false) の custom role。 */
  async function seedBookingNoFriendStaff(): Promise<string> {
    const role = await createRole(DB, { name: '予約管理のみ (友だちなし)' });
    await setRolePermissions(DB, role.id, [
      { feature_key: 'booking', allowed: true },
      { feature_key: 'friend', allowed: false },
    ]);
    const staff = await createStaffMember(DB, { name: '予約担当', role: 'staff' });
    await setStaffRoleId(DB, staff.id, role.id);
    return staff.api_key;
  }

  test('friend 権限のみ (booking なし) は GET /api/friends/:id/reminders で 403 (予約領域へ再割当)', async () => {
    const key = await seedFriendNoBookingStaff();
    // friend 詳細 (= friend feature) には到達できる
    expect((await get('/api/friends/f1', key)).status).toBe(200);
    // だがリマインダー (= booking feature) は 403 (friend 権限だけでは通らない)
    expect((await get('/api/friends/f1/reminders', key)).status).toBe(403);
  });

  test('booking 権限あり (friend なし) は GET /api/friends/:id/reminders で到達 (200)', async () => {
    const key = await seedBookingNoFriendStaff();
    expect((await get('/api/friends/f1/reminders', key)).status).toBe(200);
    // 逆向きの証拠: friend 詳細 (= friend feature) は booking 権限では 403 = reminders は friend でない
    expect((await get('/api/friends/f1', key)).status).toBe(403);
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
