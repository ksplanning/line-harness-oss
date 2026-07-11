/**
 * T-B3 (F6-2 / worker) — 作成先 workspace の server 権威解決 (§spec 3.4 表) + account_binding route。
 *
 * §3.4 解決順序 (client body を無条件採用しない = server 権威 / Codex B#1/M#4/M#5/M#7):
 *   owner + active 明示           → 採用
 *   owner + 未登録/is_active=0 明示 → 400 (form 作らない)
 *   非 owner + 非 null 明示         → 403 (form 作らない = 他社鍵誤送信を create 層で封じる ★最重要)
 *   明示無 + lineAccountId + active binding → binding 既定 (owner/非 owner とも server 解決)
 *   明示無 + (binding 無 or 無効)   → NULL (env fallback)
 *   非 owner + null/空文字          → binding を迂回して env を選べない (binding 有れば binding 優先)
 *
 * account_binding route: owner-gated GET/PUT(set active 検証)/DELETE(clear)。非 owner 403。無効値で書かない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { jstNow, createRole, setRolePermissions } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import { formalooWorkspaces } from './formaloo-workspaces.js';
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
  a.route('/', formsAdvanced);
  a.route('/', formalooWorkspaces);
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

function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  ).run(id, id, null, role, apiKey, now, now, roleId);
}

async function seedFormsStaff(apiKey: string) {
  const role = await createRole(DB, { name: 'フォーム担当' });
  await setRolePermissions(DB, role.id, [{ feature_key: 'forms_advanced', allowed: true }]);
  seedStaff(`s_${apiKey}`, 'staff', apiKey, role.id);
}

function seedWorkspace(id: string, isActive = 1) {
  raw.prepare(
    `INSERT INTO formaloo_workspaces (id, label, key_ciphertext, key_iv, secret_ciphertext, secret_iv, is_active)
     VALUES (?,?, 'ck','iv1','cs','iv2', ?)`,
  ).run(id, id, isActive);
}

function seedAccount(id: string) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, `ch_${id}`, id, 't', 's', now, now);
}

function seedBinding(lineAccountId: string, workspaceId: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_account_bindings (line_account_id, default_workspace_id) VALUES (?, ?)`,
  ).run(lineAccountId, workspaceId);
}

function readForm(id: string): { workspace_id: string | null; line_account_id: string | null } {
  return raw.prepare(`SELECT workspace_id, line_account_id FROM formaloo_forms WHERE id=?`).get(id) as {
    workspace_id: string | null; line_account_id: string | null;
  };
}
function formCount(): number {
  return (raw.prepare(`SELECT COUNT(*) n FROM formaloo_forms`).get() as { n: number }).n;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('POST /api/forms-advanced — §3.4 workspace 解決 (server 権威)', () => {
  test('owner + active 明示 workspaceId → 採用', async () => {
    seedWorkspace('fw_1', 1);
    const res = await call('POST', '/api/forms-advanced', { title: 'A社', lineAccountId: 'acc_A', workspaceId: 'fw_1' });
    expect(res.status).toBe(201);
    const id = (await res.json() as { data: { id: string } }).data.id;
    const row = readForm(id);
    expect(row.workspace_id).toBe('fw_1');
    expect(row.line_account_id).toBe('acc_A');
  });

  test('owner + 未登録 workspaceId 明示 → 400 (form 作らない)', async () => {
    const before = formCount();
    const res = await call('POST', '/api/forms-advanced', { title: 'x', workspaceId: 'fw_ghost' });
    expect(res.status).toBe(400);
    expect(formCount()).toBe(before);
  });

  test('owner + is_active=0 workspaceId 明示 → 400 (form 作らない)', async () => {
    seedWorkspace('fw_off', 0);
    const before = formCount();
    const res = await call('POST', '/api/forms-advanced', { title: 'x', workspaceId: 'fw_off' });
    expect(res.status).toBe(400);
    expect(formCount()).toBe(before);
  });

  test('★非 owner + 非 null 明示 workspaceId → 403 (form 作らない = 誤送信防止)', async () => {
    seedWorkspace('fw_1', 1);
    await seedFormsStaff('lh_staff');
    const before = formCount();
    const res = await call('POST', '/api/forms-advanced', { title: 'x', lineAccountId: 'acc_B', workspaceId: 'fw_1' }, 'Bearer lh_staff');
    expect(res.status).toBe(403);
    expect(formCount()).toBe(before);
  });

  test('明示無 + lineAccountId + active binding → binding 既定 (owner)', async () => {
    seedWorkspace('fw_1', 1);
    seedBinding('acc_A', 'fw_1');
    const res = await call('POST', '/api/forms-advanced', { title: 'A社', lineAccountId: 'acc_A' });
    const id = (await res.json() as { data: { id: string } }).data.id;
    expect(readForm(id).workspace_id).toBe('fw_1');
  });

  test('明示無 + lineAccountId + active binding → binding 既定 (非 owner も server 解決)', async () => {
    seedWorkspace('fw_1', 1);
    seedBinding('acc_A', 'fw_1');
    await seedFormsStaff('lh_staff2');
    const res = await call('POST', '/api/forms-advanced', { title: 'A社', lineAccountId: 'acc_A' }, 'Bearer lh_staff2');
    expect(res.status).toBe(201);
    const id = (await res.json() as { data: { id: string } }).data.id;
    expect(readForm(id).workspace_id).toBe('fw_1');
    expect(readForm(id).line_account_id).toBe('acc_A');
  });

  test('明示無 + binding が無効化 workspace を指す → NULL に落とす (孤立させない)', async () => {
    seedWorkspace('fw_1', 0);
    seedBinding('acc_A', 'fw_1');
    const res = await call('POST', '/api/forms-advanced', { title: 'A社', lineAccountId: 'acc_A' });
    const id = (await res.json() as { data: { id: string } }).data.id;
    expect(readForm(id).workspace_id).toBeNull();
  });

  test('明示無 + lineAccountId 無 + binding 無 → NULL (env fallback)', async () => {
    const res = await call('POST', '/api/forms-advanced', { title: '共通' });
    const id = (await res.json() as { data: { id: string } }).data.id;
    expect(readForm(id).workspace_id).toBeNull();
    expect(readForm(id).line_account_id).toBeNull();
  });

  test('★非 owner + null/空文字 workspaceId は binding を迂回して env を選べない (binding 優先)', async () => {
    seedWorkspace('fw_1', 1);
    seedBinding('acc_A', 'fw_1');
    await seedFormsStaff('lh_staff3');
    // 空文字を送っても binding が優先される (env NULL を選ぶ迂回にならない)
    const res = await call('POST', '/api/forms-advanced', { title: 'A社', lineAccountId: 'acc_A', workspaceId: '' }, 'Bearer lh_staff3');
    expect(res.status).toBe(201);
    const id = (await res.json() as { data: { id: string } }).data.id;
    expect(readForm(id).workspace_id).toBe('fw_1');
  });
});

describe('account_binding route — owner-gated CRUD (Codex M#6)', () => {
  test('GET は owner で一覧・非 owner は 403', async () => {
    seedBinding('acc_A', 'fw_1');
    const ownerRes = await call('GET', '/api/formaloo-account-bindings');
    expect(ownerRes.status).toBe(200);
    const list = (await ownerRes.json() as { data: { lineAccountId: string; defaultWorkspaceId: string | null }[] }).data;
    expect(list.find((b) => b.lineAccountId === 'acc_A')?.defaultWorkspaceId).toBe('fw_1');

    await seedFormsStaff('lh_b1');
    const staffRes = await call('GET', '/api/formaloo-account-bindings', undefined, 'Bearer lh_b1');
    expect(staffRes.status).toBe(403);
  });

  test('PUT set: active workspace + 実在 account のみ受理', async () => {
    seedAccount('acc_A');
    seedWorkspace('fw_1', 1);
    const res = await call('PUT', '/api/formaloo-account-bindings/acc_A', { defaultWorkspaceId: 'fw_1' });
    expect(res.status).toBe(200);
    const row = raw.prepare(`SELECT default_workspace_id d FROM formaloo_account_bindings WHERE line_account_id='acc_A'`).get() as { d: string };
    expect(row.d).toBe('fw_1');
  });

  test('PUT: 未登録/無効 workspace は 400・binding を書かない (参照整合性)', async () => {
    seedAccount('acc_A');
    seedWorkspace('fw_off', 0);
    const r1 = await call('PUT', '/api/formaloo-account-bindings/acc_A', { defaultWorkspaceId: 'fw_ghost' });
    expect(r1.status).toBe(400);
    const r2 = await call('PUT', '/api/formaloo-account-bindings/acc_A', { defaultWorkspaceId: 'fw_off' });
    expect(r2.status).toBe(400);
    const cnt = (raw.prepare(`SELECT COUNT(*) n FROM formaloo_account_bindings`).get() as { n: number }).n;
    expect(cnt).toBe(0);
  });

  test('PUT: line_accounts に無い id は 400', async () => {
    seedWorkspace('fw_1', 1);
    const res = await call('PUT', '/api/formaloo-account-bindings/acc_missing', { defaultWorkspaceId: 'fw_1' });
    expect(res.status).toBe(400);
  });

  test('PUT は非 owner 403', async () => {
    seedAccount('acc_A');
    seedWorkspace('fw_1', 1);
    await seedFormsStaff('lh_b2');
    const res = await call('PUT', '/api/formaloo-account-bindings/acc_A', { defaultWorkspaceId: 'fw_1' }, 'Bearer lh_b2');
    expect(res.status).toBe(403);
  });

  test('DELETE clear: owner で削除 / 非 owner 403', async () => {
    seedBinding('acc_A', 'fw_1');
    await seedFormsStaff('lh_b3');
    const staffRes = await call('DELETE', '/api/formaloo-account-bindings/acc_A', undefined, 'Bearer lh_b3');
    expect(staffRes.status).toBe(403);
    const ownerRes = await call('DELETE', '/api/formaloo-account-bindings/acc_A');
    expect(ownerRes.status).toBe(200);
    const cnt = (raw.prepare(`SELECT COUNT(*) n FROM formaloo_account_bindings`).get() as { n: number }).n;
    expect(cnt).toBe(0);
  });
});
