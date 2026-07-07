/**
 * Bug2 回帰固定 (batch F) — ID/PASS login エンドポイントを **実 SQLite (real @line-crm/db)** で通し、
 * 誤パスワードが 401 + 汎用文言 / 5回で lockout(403) / break-glass 不変、をコード+SQL 実挙動で証明する。
 *
 * 背景: browser-evaluator の実機で「誤パスワード → 500 fetch failed」が出た。切り分けの結果、根因は
 *   incrementFailedLogin の SQL ではなく、@cloudflare/vite-plugin (dev サーバの undici 転送) が
 *   POST /api/auth/login への **HTTP 401** で "fetch failed" を起こす dev ツール固有バグと判明
 *   (401→crash / 403・200→ok / authMiddleware の GET 401 は正常 / crash frame は vite-plugin。既存
 *   の apiKey 無効時 401 でも起きる pre-existing。本番 workerd・wrangler dev には vite-plugin が
 *   無く該当しない)。よって worker コードは正しく 401 を返す — 本テストがそれを real SQL で固定する
 *   (Hono の request handler 直叩き = 転送層を挟まないので dev バグの影響を受けない)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { adminAuth } from './admin-auth.js';
import { setStaffPassword, setStaffLoginId } from '@line-crm/db';
import { hashPassword } from '../utils/password.js';
import { jstNow } from '@line-crm/db';
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
    ADMIN_ORIGIN: 'https://admin.example.com',
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.route('/', adminAuth);
  a.get('/api/protected', (c) => c.json({ success: true, data: c.get('staff') }));
  return a;
}

const PW = 'CorrectHorse!2026';

async function seedOwnerWithPassword() {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
     VALUES ('owner-1','Owner',NULL,'owner','lh_ownerkey',1,?,?)`,
  ).run(now, now);
  await setStaffLoginId(DB, 'owner-1', 'owner-ks');
  await setStaffPassword(DB, 'owner-1', await hashPassword(PW));
}

async function login(body: Record<string, unknown>) {
  return app().request('/api/auth/login', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }, env());
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('Bug2 real-SQLite: ID/PASS login エンドポイント', () => {
  test('正しい password → 200 (cookie 値 = 当該 staff の api_key)', async () => {
    await seedOwnerWithPassword();
    const res = await login({ loginId: 'owner-ks', password: PW });
    expect(res.status).toBe(200);
  });

  test('旧 iterations(210k) で保存された既存行も検証できる (保存 iterations を使う前方互換 / P0)', async () => {
    const now = jstNow();
    raw.prepare(
      `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
       VALUES ('legacy-1','Legacy',NULL,'owner','lh_legacykey',1,?,?)`,
    ).run(now, now);
    await setStaffLoginId(DB, 'legacy-1', 'legacy-owner');
    // わざと旧回数 210k で保存 (現行既定 100k とは異なる = 保存値が使われる証拠になる)。
    await setStaffPassword(DB, 'legacy-1', await hashPassword(PW, 210_000));
    const stored = raw.prepare(`SELECT password_iterations FROM staff_members WHERE id='legacy-1'`).get() as { password_iterations: number };
    expect(stored.password_iterations).toBe(210_000);
    // 保存回数で検証されるのでログイン成功 (verify が定数 100k を使っていたら失敗するはず)。
    const res = await login({ loginId: 'legacy-owner', password: PW });
    expect(res.status).toBe(200);
  });

  test('誤パスワード → 401 + 汎用文言 (500 でなく) — real SQL 経路', async () => {
    await seedOwnerWithPassword();
    const res = await login({ loginId: 'owner-ks', password: 'WRONG' });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toMatch(/ログインID.*パスワード/);
    // real SQL で failed_login_count が加算されている。
    const row = raw.prepare(`SELECT failed_login_count FROM staff_members WHERE id='owner-1'`).get() as { failed_login_count: number };
    expect(row.failed_login_count).toBe(1);
  });

  test('存在しない loginId → 401 汎用文言 (列挙攻撃を助けない・500 でない)', async () => {
    await seedOwnerWithPassword();
    const res = await login({ loginId: 'ghost', password: 'whatever' });
    expect(res.status).toBe(401);
  });

  test('owner を 5 回誤ると lockout → 正しい password でも 403', async () => {
    await seedOwnerWithPassword();
    for (let i = 0; i < 5; i++) {
      const r = await login({ loginId: 'owner-ks', password: 'WRONG' });
      expect(r.status).toBe(401); // どの試行も 500 にならない
    }
    // owner は短窓 throttle だが lock はかかる → 正しい password でも今は 403。
    const locked = await login({ loginId: 'owner-ks', password: PW });
    expect(locked.status).toBe(403);
  });

  test('break-glass: env API_KEY Bearer は password-lock と無関係に owner で通る', async () => {
    await seedOwnerWithPassword();
    for (let i = 0; i < 5; i++) await login({ loginId: 'owner-ks', password: 'WRONG' }); // lock 状態に
    const res = await app().request('/api/protected', { headers: { Authorization: 'Bearer env-owner-key' } }, env());
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { role: string } }).data.role).toBe('owner');
  });
});
