/**
 * T-C2 (F6-3 / forms-advanced route の folder 配線) — 一覧 folder 絞り (3 状態) + serialize round-trip +
 *   フォーム→フォルダ割当 route。
 *   ⑥ 一覧 folder 絞り (Codex M#4 = 3 状態):
 *      ?lineAccountId=<a> (folderId 無指定) = account 絞りのみ (全フォルダ + 未分類) /
 *      &folderId=<f> = 特定フォルダ (AND folder_id=?) /
 *      &folderId=none (sentinel) = 未分類のみ (AND folder_id IS NULL)。
 *   serializeForm 出力に folderId が含まれる (round-trip / M-8)。
 *   ④ PUT /api/forms-advanced/:id/folder = form.folder_id 更新 (Formaloo push なし / 同一 account 検証)。
 *      cross-account は 400・一致は 200・null で未分類化。
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

function seedAccount(id: string) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`)
    .run(id, `ch_${id}`, id, 'tok', 'sec');
}
function seedFolder(id: string, lineAccountId: string) {
  const now = jstNow();
  raw.prepare(`INSERT INTO formaloo_folders (id, line_account_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(id, lineAccountId, id, now, now);
}
function seedForm(id: string, lineAccountId: string | null, folderId: string | null = null) {
  raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, line_account_id, folder_id) VALUES (?,?,'{"fields":[],"logic":[]}',?,?)`)
    .run(id, id, lineAccountId, folderId);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  seedAccount('acc_A');
  seedAccount('acc_B');
});

interface ListItem { id: string; folderId?: string | null }

describe('⑥ 一覧 folder 絞り (3 状態 / Codex M#4)', () => {
  beforeEach(() => {
    seedFolder('ff_1', 'acc_A');
    seedFolder('ff_2', 'acc_A');
    seedForm('fa_in1', 'acc_A', 'ff_1');
    seedForm('fa_in2', 'acc_A', 'ff_2');
    seedForm('fa_unfiled', 'acc_A', null);
  });

  test('folderId 無指定 = account 絞りのみ (全フォルダ + 未分類)', async () => {
    const res = await call('GET', '/api/forms-advanced?lineAccountId=acc_A');
    const ids = (await res.json() as { data: ListItem[] }).data.map((f) => f.id).sort();
    expect(ids).toEqual(['fa_in1', 'fa_in2', 'fa_unfiled']);
  });

  test('folderId=<id> = 特定フォルダのみ (AND folder_id=?)', async () => {
    const res = await call('GET', '/api/forms-advanced?lineAccountId=acc_A&folderId=ff_1');
    const ids = (await res.json() as { data: ListItem[] }).data.map((f) => f.id);
    expect(ids).toEqual(['fa_in1']);
  });

  test('folderId=none (sentinel) = 未分類のみ (AND folder_id IS NULL)', async () => {
    const res = await call('GET', '/api/forms-advanced?lineAccountId=acc_A&folderId=none');
    const ids = (await res.json() as { data: ListItem[] }).data.map((f) => f.id);
    expect(ids).toEqual(['fa_unfiled']);
  });

  test('serializeForm 出力に folderId が含まれる (round-trip / M-8)', async () => {
    const res = await call('GET', '/api/forms-advanced?lineAccountId=acc_A&folderId=ff_1');
    const item = (await res.json() as { data: ListItem[] }).data[0];
    expect(item).toHaveProperty('folderId');
    expect(item.folderId).toBe('ff_1');
    // 未分類は folderId=null (プロパティは存在する)
    const unfiled = await call('GET', '/api/forms-advanced?lineAccountId=acc_A&folderId=none');
    const u = (await unfiled.json() as { data: ListItem[] }).data[0];
    expect(u).toHaveProperty('folderId');
    expect(u.folderId).toBeNull();
  });
});

describe('④ PUT /api/forms-advanced/:id/folder — 割当 (同一 account 検証 / Formaloo push なし)', () => {
  test('同一 account の folder への割当は 200・folder_id 更新', async () => {
    seedFolder('ff_A', 'acc_A');
    seedForm('fa_A', 'acc_A', null);
    const res = await call('PUT', '/api/forms-advanced/fa_A/folder', { folderId: 'ff_A' });
    expect(res.status).toBe(200);
    expect((raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_A'`).get() as { folder_id: string }).folder_id).toBe('ff_A');
    // 応答 serialize に folderId round-trip
    const d = (await res.json() as { data: ListItem }).data;
    expect(d.folderId).toBe('ff_A');
  });

  test('別 account の folder への割当は 400・割り当てない (cross-account 混入防止)', async () => {
    seedFolder('ff_B', 'acc_B');
    seedForm('fa_A', 'acc_A', null);
    const res = await call('PUT', '/api/forms-advanced/fa_A/folder', { folderId: 'ff_B' });
    expect(res.status).toBe(400);
    expect((raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_A'`).get() as { folder_id: string | null }).folder_id).toBeNull();
  });

  test('folderId=null で未分類に戻せる (200)', async () => {
    seedFolder('ff_A', 'acc_A');
    seedForm('fa_A', 'acc_A', 'ff_A');
    const res = await call('PUT', '/api/forms-advanced/fa_A/folder', { folderId: null });
    expect(res.status).toBe(200);
    expect((raw.prepare(`SELECT folder_id FROM formaloo_forms WHERE id='fa_A'`).get() as { folder_id: string | null }).folder_id).toBeNull();
  });

  test('不明 form は 404 / 不明 folder は 400', async () => {
    seedForm('fa_A', 'acc_A', null);
    expect((await call('PUT', '/api/forms-advanced/fa_ghost/folder', { folderId: null })).status).toBe(404);
    expect((await call('PUT', '/api/forms-advanced/fa_A/folder', { folderId: 'ff_ghost' })).status).toBe(400);
  });
});
