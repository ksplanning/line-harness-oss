/**
 * T-B2 (F6-2) — 表示スコープ read 経路 (worker route + serialize)。
 *   ① GET /api/forms-advanced?lineAccountId= が (line_account_id=? OR IS NULL) に絞る (別アカウント除外)。
 *   ② serializeForm 出力に lineAccountId が常時含まれる (round-trip / M-8)。
 *   ③ role-aware redaction (Codex B#2): workspaceId は owner 応答のみ含み、非 owner (forms_advanced 権限あり
 *      custom role staff) の一覧/詳細応答には含まれない。lineAccountId は全 role 露出可 (秘密でない)。
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

/** 表示スコープ列を直接指定して form を seed。 */
function seedForm(id: string, title: string, lineAccountId: string | null, workspaceId: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, line_account_id, workspace_id)
     VALUES (?,?,'{"fields":[],"logic":[]}',?,?)`,
  ).run(id, title, lineAccountId, workspaceId);
}

/** forms_advanced 権限あり非 owner staff (custom role)。 */
async function seedFormsStaff(apiKey: string) {
  const role = await createRole(DB, { name: 'フォーム担当' });
  await setRolePermissions(DB, role.id, [{ feature_key: 'forms_advanced', allowed: true }]);
  seedStaff(`s_${apiKey}`, 'staff', apiKey, role.id);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

interface ListItem { id: string; lineAccountId?: string | null; workspaceId?: string | null }

describe('GET /api/forms-advanced?lineAccountId= — 表示スコープ (①)', () => {
  test('指定アカウント form + 共通 NULL のみ返す (別アカウント除外)', async () => {
    seedForm('fa_A', 'A社', 'acc_A', 'fw_shared');
    seedForm('fa_B', 'B社', 'acc_B', 'fw_shared');
    seedForm('fa_common', '共通', null, null);

    const res = await call('GET', '/api/forms-advanced?lineAccountId=acc_A');
    expect(res.status).toBe(200);
    const ids = ((await res.json() as { data: ListItem[] }).data).map((f) => f.id);
    expect(ids).toContain('fa_A');
    expect(ids).toContain('fa_common');
    expect(ids).not.toContain('fa_B');
  });

  test('lineAccountId 無しは全件 (後方互換)', async () => {
    seedForm('fa_A', 'A社', 'acc_A', null);
    seedForm('fa_B', 'B社', 'acc_B', null);
    const res = await call('GET', '/api/forms-advanced');
    const ids = ((await res.json() as { data: ListItem[] }).data).map((f) => f.id);
    expect(ids.sort()).toEqual(['fa_A', 'fa_B']);
  });
});

describe('serializeForm round-trip + role-aware redaction (② ③)', () => {
  test('② lineAccountId は owner 応答に常時含まれる', async () => {
    seedForm('fa_A', 'A社', 'acc_A', 'fw_1');
    const res = await call('GET', '/api/forms-advanced/fa_A');
    const d = (await res.json() as { data: ListItem }).data;
    expect(d.lineAccountId).toBe('acc_A');
  });

  test('③ workspaceId は owner 応答に含まれる (owner-only 露出)', async () => {
    seedForm('fa_A', 'A社', 'acc_A', 'fw_1');
    const res = await call('GET', '/api/forms-advanced/fa_A');
    const d = (await res.json() as { data: ListItem }).data;
    expect(d.workspaceId).toBe('fw_1');
  });

  test('③ 非 owner (forms_advanced 権限 staff) の応答には workspaceId が含まれない (redaction)', async () => {
    seedForm('fa_common', '共通', null, 'fw_secret');
    await seedFormsStaff('lh_formkey');
    // 一覧
    const list = await call('GET', '/api/forms-advanced', undefined, 'Bearer lh_formkey');
    expect(list.status).toBe(200);
    const item = (await list.json() as { data: ListItem[] }).data.find((f) => f.id === 'fa_common');
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('workspaceId');
    // lineAccountId は非 owner でも露出可 (表示スコープ判定に要る・秘密でない)
    expect(item).toHaveProperty('lineAccountId');
    // 詳細
    const detail = await call('GET', '/api/forms-advanced/fa_common', undefined, 'Bearer lh_formkey');
    const d = (await detail.json() as { data: ListItem }).data;
    expect(d).not.toHaveProperty('workspaceId');
    expect(d).toHaveProperty('lineAccountId');
  });
});
