/**
 * F-5 T-E1 — 埋め込みコード提示 + Google Sheets 連携 (real SQLite)。
 *   - GET /share: published のみ iframe/script コード発行 (N-7 / T-B3 gate 接続)。draft は null。
 *   - POST /gsheet/connect: owner gated (N-9)。dev (Formaloo 未配備) は fail-soft (connected=false + note)。
 *   - 非 owner forms_advanced staff / 権限なし staff は 403。
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
  return app().request(path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env());
}
function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(`INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id) VALUES (?,?,?,?,?,1,?,?,?)`).run(id, id, null, role, apiKey, now, now, roleId);
}
async function seedFormsAdvancedStaff(apiKey: string) {
  const roleId = (await createRole(DB, { name: 'フォーム担当' })).id;
  await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: true }]);
  seedStaff(`u_${apiKey}`, 'staff', apiKey, roleId);
}
const ADDR = 'https://formaloo.me/f/abc123';
function seedForm(id: string, status: string) {
  raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json) VALUES (?,?,?,?,?)`)
    .run(id, `slug_${id}`, 'お問い合わせ', status, JSON.stringify({ fields: [], logic: [], formalooAddress: ADDR }));
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('T-E1 GET /share 埋め込みコード (publish gate 接続 / N-7)', () => {
  test('published → iframe/script コード + publicUrl', async () => {
    seedForm('fa1', 'published');
    const d = (await (await call('GET', '/api/forms-advanced/fa1/share')).json() as { data: { published: boolean; publicUrl: string; iframeCode: string; scriptCode: string } }).data;
    expect(d.published).toBe(true);
    expect(d.publicUrl).toBe(ADDR);
    expect(d.iframeCode).toContain('<iframe');
    expect(d.iframeCode).toContain(ADDR);
    expect(d.scriptCode).toContain('<script>');
  });

  test('draft → コードは null (N-7 誤配信防止)', async () => {
    seedForm('fa1', 'draft');
    const d = (await (await call('GET', '/api/forms-advanced/fa1/share')).json() as { data: { published: boolean; iframeCode: string | null; scriptCode: string | null } }).data;
    expect(d.published).toBe(false);
    expect(d.iframeCode).toBeNull();
    expect(d.scriptCode).toBeNull();
  });

  test('unknown form → 404', async () => {
    expect((await call('GET', '/api/forms-advanced/nope/share')).status).toBe(404);
  });

  test('T-A5: published → lineDistUrl(/fo/:id) を publicUrl と別キーで返す (既存 publicUrl 不変)', async () => {
    seedForm('fa1', 'published');
    const d = (await (await call('GET', '/api/forms-advanced/fa1/share')).json() as { data: { publicUrl: string; lineDistUrl: string } }).data;
    // 既存 publicUrl は HP 生 URL のまま不変 (追加キーのみ / 非破壊)
    expect(d.publicUrl).toBe(ADDR);
    // LINE 配信用は worker の /fo/:id (追跡 + prefill 経路)。base は WORKER_URL。
    expect(d.lineDistUrl).toBe('https://api.example.com/fo/fa1');
  });

  test('T-A5: draft → lineDistUrl も null (未公開は配布不可 / publicUrl と同挙動)', async () => {
    seedForm('fa1', 'draft');
    const d = (await (await call('GET', '/api/forms-advanced/fa1/share')).json() as { data: { publicUrl: string | null; lineDistUrl: string | null } }).data;
    expect(d.publicUrl).toBeNull();
    expect(d.lineDistUrl).toBeNull();
  });
});

describe('T-E1 POST /gsheet/connect (owner gated / fail-soft)', () => {
  test('owner + dev (Formaloo 未配備) → connected=false + note (fail-soft) / 状態保存', async () => {
    seedForm('fa1', 'published');
    const res = await call('POST', '/api/forms-advanced/fa1/gsheet/connect', {});
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { connected: boolean; note: string } }).data;
    expect(d.connected).toBe(false);
    expect(d.note).toContain('未設定');
    expect(d.note).toContain('再同期');
    const row = raw.prepare(`SELECT gsheet_connected FROM formaloo_forms WHERE id='fa1'`).get() as { gsheet_connected: number };
    expect(row.gsheet_connected).toBe(0);
  });

  test('非 owner の forms_advanced staff は 403 (owner gated / N-9)', async () => {
    seedForm('fa1', 'published');
    await seedFormsAdvancedStaff('fa-staff-key');
    expect((await call('POST', '/api/forms-advanced/fa1/gsheet/connect', {}, 'Bearer fa-staff-key')).status).toBe(403);
  });

  test('forms_advanced 権限なしは 403 (middleware gate)', async () => {
    seedForm('fa1', 'published');
    const roleId = (await createRole(DB, { name: 'ゲスト' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('guest', 'staff', 'guest-key', roleId);
    expect((await call('POST', '/api/forms-advanced/fa1/gsheet/connect', {}, 'Bearer guest-key')).status).toBe(403);
  });
});
