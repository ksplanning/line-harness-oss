/**
 * T-C2 (F6-3 / worker route) — /api/formaloo-folders フォルダ CRUD (real route integration = mount 済)。
 *   ① mount 到達性: 未 mount なら 404 (Codex M#2) — POST が 404 でない (route 登録済) を確認。
 *   ② gating: forms_advanced feature で通り **ownerGate なし** (非 owner staff でも 200 = F6-1/F6-2 と違う)。
 *   ③ gate enforcement negative (Codex M#6): forms_advanced を持たない custom role は 403。
 *   ④ 作成: lineAccountId 欠落/空/未知 account は 400 (架空 account 禁止 / M#3)。
 *   ⑤ 削除: 所属 form が未分類 (folder_id=NULL) になり form が消えない + 子フォルダ再接続 (route 経由)。
 *   ⑥ cross-account 親 / 循環 / 自己親を 400。
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
import { formalooFolders } from './formaloo-folders.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

interface MockStmt {
  bind(...args: unknown[]): MockStmt;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
  __exec(): { changes: number };
}

function d1(db: Database.Database): D1Database {
  function makeStmt(sql: string): MockStmt {
    const s = db.prepare(sql);
    let params: unknown[] = [];
    const api: MockStmt = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      __exec() { const info = s.run(...(params as never[])); return { changes: info.changes }; },
    };
    return api;
  }
  return {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: MockStmt[]) {
      const tx = db.transaction((list: MockStmt[]) => list.map((st) => ({ meta: { changes: st.__exec().changes } })));
      return tx(stmts);
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
  a.route('/', formalooFolders);
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

function seedAccount(id: string) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`)
    .run(id, `ch_${id}`, id, 'tok', 'sec');
}
function seedForm(id: string, lineAccountId: string | null, folderId: string | null = null) {
  raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, line_account_id, folder_id) VALUES (?,?,'{"fields":[],"logic":[]}',?,?)`)
    .run(id, id, lineAccountId, folderId);
}
function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id) VALUES (?,?,?,?,?,1,?,?,?)`)
    .run(id, id, null, role, apiKey, now, now, roleId);
}
/** forms_advanced 権限あり非 owner staff (staff 利用可の検証)。 */
async function seedFormsStaff(apiKey: string) {
  const role = await createRole(DB, { name: 'フォーム担当' });
  await setRolePermissions(DB, role.id, [{ feature_key: 'forms_advanced', allowed: true }]);
  seedStaff(`s_${apiKey}`, 'staff', apiKey, role.id);
}
/** forms_advanced 権限なし custom role staff (gate enforcement 検証)。 */
async function seedNoFormsStaff(apiKey: string) {
  const role = await createRole(DB, { name: 'ゲスト' });
  await setRolePermissions(DB, role.id, [{ feature_key: 'forms_advanced', allowed: false }]);
  seedStaff(`g_${apiKey}`, 'staff', apiKey, role.id);
}
async function createFolder(name: string, lineAccountId: string, parentId?: string, auth = OWNER): Promise<{ status: number; id?: string }> {
  const res = await call('POST', '/api/formaloo-folders', { lineAccountId, name, parentId }, auth);
  const body = res.status < 300 ? (await res.json() as { data: { id: string } }) : null;
  return { status: res.status, id: body?.data.id };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  seedAccount('acc_A');
  seedAccount('acc_B');
});

describe('① mount 到達性 + ② gating (ownerGate なし = staff 利用可)', () => {
  test('POST /api/formaloo-folders は mount 済 (owner 201・404 でない)', async () => {
    const res = await call('POST', '/api/formaloo-folders', { lineAccountId: 'acc_A', name: 'キャンペーン' });
    expect(res.status).toBe(201);
  });

  test('非 owner staff (forms_advanced あり) でも CRUD 200/201 (ownerGate なし)', async () => {
    await seedFormsStaff('fa-key');
    const A = 'Bearer fa-key';
    const c = await createFolder('販促', 'acc_A', undefined, A);
    expect(c.status).toBe(201);
    expect((await call('GET', '/api/formaloo-folders?lineAccountId=acc_A', undefined, A)).status).toBe(200);
    expect((await call('PATCH', `/api/formaloo-folders/${c.id}`, { name: '販促2024' }, A)).status).toBe(200);
    expect((await call('DELETE', `/api/formaloo-folders/${c.id}`, undefined, A)).status).toBe(200);
  });
});

describe('③ gate enforcement negative (Codex M#6) — forms_advanced なしは 403', () => {
  test('forms_advanced を持たない custom role は folder route で 403', async () => {
    await seedNoFormsStaff('guest-key');
    const A = 'Bearer guest-key';
    expect((await call('GET', '/api/formaloo-folders?lineAccountId=acc_A', undefined, A)).status).toBe(403);
    expect((await call('POST', '/api/formaloo-folders', { lineAccountId: 'acc_A', name: 'x' }, A)).status).toBe(403);
    expect((await call('PATCH', '/api/formaloo-folders/ff_x', { name: 'x' }, A)).status).toBe(403);
    expect((await call('DELETE', '/api/formaloo-folders/ff_x', undefined, A)).status).toBe(403);
  });
});

describe('④ 作成 — lineAccountId 欠落/空/未知 account は 400 (M#3)', () => {
  test('欠落/空/未知 account は 400・フォルダを作らない', async () => {
    expect((await call('POST', '/api/formaloo-folders', { name: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/formaloo-folders', { lineAccountId: '', name: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/formaloo-folders', { lineAccountId: 'acc_ghost', name: 'x' })).status).toBe(400);
    expect((raw.prepare(`SELECT COUNT(*) c FROM formaloo_folders`).get() as { c: number }).c).toBe(0);
  });

  test('空 name は 400', async () => {
    expect((await call('POST', '/api/formaloo-folders', { lineAccountId: 'acc_A', name: '' })).status).toBe(400);
  });

  test('GET は lineAccountId 必須 (欠落は 400)', async () => {
    expect((await call('GET', '/api/formaloo-folders')).status).toBe(400);
  });

  test('GET ?lineAccountId= は account スコープ (別 account のフォルダを返さない)', async () => {
    await createFolder('A1', 'acc_A');
    await createFolder('B1', 'acc_B');
    const res = await call('GET', '/api/formaloo-folders?lineAccountId=acc_A');
    expect(res.status).toBe(200);
    const names = (await res.json() as { data: { name: string }[] }).data.map((f) => f.name);
    expect(names).toEqual(['A1']);
  });
});

describe('⑤ 削除 (route 経由) — form 未分類化 + 子再接続', () => {
  test('削除で所属 form が未分類 + form 消えず + 子フォルダ再接続', async () => {
    const parent = await createFolder('親', 'acc_A');
    const child = await createFolder('子', 'acc_A', parent.id);
    seedForm('fa_1', 'acc_A', parent.id!);
    const res = await call('DELETE', `/api/formaloo-folders/${parent.id}`);
    expect(res.status).toBe(200);
    // form 残る・未分類化
    const form = raw.prepare(`SELECT id, folder_id FROM formaloo_forms WHERE id='fa_1'`).get() as { id: string; folder_id: string | null };
    expect(form.id).toBe('fa_1');
    expect(form.folder_id).toBeNull();
    // 子はトップレベル化 (親がトップレベルだった)
    const childRow = raw.prepare(`SELECT parent_id FROM formaloo_folders WHERE id=?`).get(child.id) as { parent_id: string | null };
    expect(childRow.parent_id).toBeNull();
  });

  test('不明 folder 削除は 404', async () => {
    expect((await call('DELETE', '/api/formaloo-folders/ff_ghost')).status).toBe(404);
  });
});

describe('⑥ cross-account 親 / 循環 / 自己親を 400', () => {
  test('別 account の folder を親にできない (400)', async () => {
    const a = await createFolder('親A', 'acc_A');
    const r = await createFolder('越境', 'acc_B', a.id);
    expect(r.status).toBe(400);
  });

  test('PATCH で循環 (A→B→A) / 自己親を 400', async () => {
    const a = await createFolder('A', 'acc_A');
    const b = await createFolder('B', 'acc_A', a.id);
    // 自己親
    expect((await call('PATCH', `/api/formaloo-folders/${a.id}`, { parentId: a.id })).status).toBe(400);
    // 循環: a を b の子にする (b は a の子孫)
    expect((await call('PATCH', `/api/formaloo-folders/${a.id}`, { parentId: b.id })).status).toBe(400);
  });

  test('PATCH で親付け替え (正常) は 200', async () => {
    const a = await createFolder('A', 'acc_A');
    const b = await createFolder('B', 'acc_A');
    expect((await call('PATCH', `/api/formaloo-folders/${b.id}`, { parentId: a.id })).status).toBe(200);
    expect((raw.prepare(`SELECT parent_id FROM formaloo_folders WHERE id=?`).get(b.id) as { parent_id: string }).parent_id).toBe(a.id);
  });
});
