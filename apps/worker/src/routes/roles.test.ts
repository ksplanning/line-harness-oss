/**
 * /api/roles CRUD + /api/staff/me permissions + staff role_id 割当 (G64 / T-A7 / T-C3) — real SQLite。
 *   - roles CRUD (create/template/permissions 保存/get/list/delete-with-reassign)
 *   - staff POST/PATCH で roleId 割当 (存在しない roleId は 400)
 *   - /api/staff/me が resolved permissions を返す (built-in=全19 / custom=allowlist)
 *   - role 削除は割当 staff を reassignTo/null へ付け替えてから (孤児 role_id 0 / T-C3)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
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

const OWNER = 'Bearer env-owner-key';

function call(method: string, path: string, body?: unknown, auth = OWNER) {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

/** DB に owner staff を1人 (最後の owner ガードを踏まないよう複数 owner を作る土台)。 */
function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  ).run(id, id, null, role, apiKey, now, now, roleId);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('roles CRUD API (T-A7)', () => {
  test('POST テンプレ作成 → features がテンプレと一致 / GET list / permissions 保存 / get', async () => {
    const created = await call('POST', '/api/roles', { name: 'チャット対応のみ', template: 'chat_only' });
    expect(created.status).toBe(201);
    const role = (await created.json() as { data: { id: string; features: string[] } }).data;
    expect(role.features.sort()).toEqual(['chat', 'friend'].sort());

    const list = await call('GET', '/api/roles');
    expect(list.status).toBe(200);
    expect((await list.json() as { data: unknown[] }).data.length).toBe(1);

    // マトリクス保存 (chat のみ ON に上書き)
    const saved = await call('PUT', `/api/roles/${role.id}/permissions`, {
      permissions: { chat: true, friend: false, broadcast: true },
    });
    expect(saved.status).toBe(200);
    const after = (await saved.json() as { data: { features: string[] } }).data;
    expect(after.features.sort()).toEqual(['broadcast', 'chat'].sort());
  });

  test('POST 白紙 (全 OFF) / 名前空は 400 / 不正テンプレ 400', async () => {
    const blank = await call('POST', '/api/roles', { name: '白紙' });
    expect(blank.status).toBe(201);
    expect((await blank.json() as { data: { features: string[] } }).data.features).toEqual([]);

    expect((await call('POST', '/api/roles', { name: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/roles', { name: 'x', template: 'nope' })).status).toBe(400);
  });

  test('非 owner (built-in staff) は /api/roles に 403 (staff_admin gate)', async () => {
    seedStaff('s1', 'staff', 'lh_staffkey');
    // built-in staff は permissionMiddleware で全許可 → requireRole('owner') で 403 になる
    const res = await call('GET', '/api/roles', undefined, 'Bearer lh_staffkey');
    expect(res.status).toBe(403);
  });

  test('M-4: staff_admin は custom role に付与できない (API 直で true を送っても false に固定)', async () => {
    const created = await call('POST', '/api/roles', {
      name: '準管理者もどき',
      permissions: { broadcast: true, staff_admin: true }, // staff_admin=true を明示送信
    });
    const role = (await created.json() as { data: { id: string; features: string[] } }).data;
    expect(role.features).toContain('broadcast');
    expect(role.features).not.toContain('staff_admin'); // owner 専用ゆえ剥ぎ取られる

    // PUT permissions でも同様に無効化
    const saved = await call('PUT', `/api/roles/${role.id}/permissions`, {
      permissions: { staff_admin: true, chat: true },
    });
    const after = (await saved.json() as { data: { features: string[] } }).data;
    expect(after.features).not.toContain('staff_admin');
    expect(after.features).toContain('chat');
  });
});

describe('staff role_id 割当 + /staff/me permissions', () => {
  test('POST staff で roleId 割当 → /staff/me が custom allowlist を返す', async () => {
    const roleRes = await call('POST', '/api/roles', { name: 'チャットのみ', template: 'chat_only' });
    const roleId = (await roleRes.json() as { data: { id: string } }).data.id;

    const created = await call('POST', '/api/staff', { name: '外注', role: 'staff', roleId });
    expect(created.status).toBe(201);
    const staffData = (await created.json() as { data: { id: string; apiKey: string; roleId: string } }).data;
    expect(staffData.roleId).toBe(roleId);

    // 割り当てた staff の api_key で /staff/me を叩く
    const apiKey = staffData.apiKey; // 作成時は unmasked
    const me = await call('GET', '/api/staff/me', undefined, `Bearer ${apiKey}`);
    expect(me.status).toBe(200);
    const perms = (await me.json() as { data: { permissions: string[]; roleId: string } }).data;
    expect(perms.roleId).toBe(roleId);
    expect(perms.permissions.sort()).toEqual(['chat', 'friend'].sort());
  });

  test('存在しない roleId は 400 (POST / PATCH)', async () => {
    expect((await call('POST', '/api/staff', { name: 'x', role: 'staff', roleId: 'ghost' })).status).toBe(400);
    const s = await call('POST', '/api/staff', { name: 'y', role: 'staff' });
    const sid = (await s.json() as { data: { id: string } }).data.id;
    expect((await call('PATCH', `/api/staff/${sid}`, { roleId: 'ghost' })).status).toBe(400);
  });

  test('PATCH roleId=null で custom role 解除 → /staff/me が built-in 全20 に戻る', async () => {
    const roleRes = await call('POST', '/api/roles', { name: 'r', template: 'chat_only' });
    const roleId = (await roleRes.json() as { data: { id: string } }).data.id;
    const created = await call('POST', '/api/staff', { name: 'z', role: 'staff', roleId });
    const staffData = (await created.json() as { data: { id: string; apiKey: string } }).data;

    await call('PATCH', `/api/staff/${staffData.id}`, { roleId: null });
    const me = await call('GET', '/api/staff/me', undefined, `Bearer ${staffData.apiKey}`);
    const perms = (await me.json() as { data: { permissions: string[]; roleId: string | null } }).data;
    expect(perms.roleId).toBeNull();
    expect(perms.permissions.length).toBe(20); // built-in preset
  });

  test('env-owner /staff/me は全20 feature', async () => {
    const me = await call('GET', '/api/staff/me');
    const data = (await me.json() as { data: { permissions: string[]; role: string } }).data;
    expect(data.role).toBe('owner');
    expect(data.permissions.length).toBe(20);
  });
});

describe('role 削除 + reassign (T-C3 / 孤児防止)', () => {
  test('割当ありロールは reassignTo 未指定だと 400 / null 指定で built-in 復帰して削除', async () => {
    const roleRes = await call('POST', '/api/roles', { name: 'r', template: 'chat_only' });
    const roleId = (await roleRes.json() as { data: { id: string } }).data.id;
    const created = await call('POST', '/api/staff', { name: 'w', role: 'staff', roleId });
    const staffData = (await created.json() as { data: { id: string } }).data;

    // reassignTo 未指定 → 400
    expect((await call('DELETE', `/api/roles/${roleId}`)).status).toBe(400);

    // reassignTo: null → staff.role_id を NULL に戻して削除
    const del = await call('DELETE', `/api/roles/${roleId}`, { reassignTo: null });
    expect(del.status).toBe(200);

    // 孤児 role_id が残っていない
    const orphan = raw.prepare('SELECT COUNT(*) c FROM staff_members WHERE role_id = ?').get(roleId) as { c: number };
    expect(orphan.c).toBe(0);
    const row = raw.prepare('SELECT role_id FROM staff_members WHERE id = ?').get(staffData.id) as { role_id: string | null };
    expect(row.role_id).toBeNull();
  });

  test('reassignTo に別ロール id を指定すると付け替えて削除 / 存在しない先は 400', async () => {
    const r1 = (await (await call('POST', '/api/roles', { name: 'r1', template: 'chat_only' })).json() as { data: { id: string } }).data.id;
    const r2 = (await (await call('POST', '/api/roles', { name: 'r2', template: 'analytics_only' })).json() as { data: { id: string } }).data.id;
    const created = await call('POST', '/api/staff', { name: 'v', role: 'staff', roleId: r1 });
    const sid = (await created.json() as { data: { id: string } }).data.id;

    expect((await call('DELETE', `/api/roles/${r1}`, { reassignTo: 'ghost' })).status).toBe(400);

    const del = await call('DELETE', `/api/roles/${r1}`, { reassignTo: r2 });
    expect(del.status).toBe(200);
    const row = raw.prepare('SELECT role_id FROM staff_members WHERE id = ?').get(sid) as { role_id: string };
    expect(row.role_id).toBe(r2);
  });
});
