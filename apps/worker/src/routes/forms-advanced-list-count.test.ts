/**
 * forms-list-count-fix T-A2/T-A3 — 高機能フォーム一覧の回答数表示源を
 *   submit_count(harness-only カウンタ) から formaloo_submissions ミラー行数へ切替える route 検証。
 *   - T-A2: 一覧 GET /api/forms-advanced が ミラー N 行のフォームに submitCount:N を返す
 *       (form A: submit_count=99 だが ミラー 4 行 → 4 = 源がミラーに切替わった証明 / form B: 0 行 → 0)。
 *   - T-A3 (暴走ガード / failure_observable 直結): 一覧描画中に Formaloo drill を一切しない
 *       (resolveFormalooClient が 0 回 = client.get 到達不能 = local D1 のみで完結)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

// T-A3: 一覧描画で Formaloo client を解決しないことを spy で封鎖 (importActual で他 export は温存)。
const hoisted = vi.hoisted(() => ({ resolveSpy: vi.fn() }));
vi.mock('../services/formaloo-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/formaloo-client.js')>();
  return { ...actual, resolveFormalooClient: hoisted.resolveSpy };
});

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
function call(method: string, path: string) {
  return app().request(path, { method, headers: { Authorization: OWNER, 'Content-Type': 'application/json' } }, env());
}

function seedForm(id: string, title: string, submitCount: number) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, submit_count) VALUES (?,?,?,?,?)`,
  ).run(id, title, '説明', '{"fields":[],"logic":[]}', submitCount);
}
function seedMirror(id: string, formId: string) {
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)`,
  ).run(id, formId, '{}', '2026-07-17T10:00:00+09:00');
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  hoisted.resolveSpy.mockClear();
});

describe('forms-list-count-fix — 一覧の回答数はミラー行数 (T-A2)', () => {
  test('submit_count と乖離してもミラー行数を返す (form A 4行→4 / form B 0行→0)', async () => {
    // form A: harness カウンタ submit_count=99 (乖離) だが ミラー 4 行 = 実回答 → 4 を期待。
    seedForm('fa_A', 'フォームA', 99);
    seedMirror('a1', 'fa_A');
    seedMirror('a2', 'fa_A');
    seedMirror('a3', 'fa_A');
    seedMirror('a4', 'fa_A');
    // form B: ミラー 0 行 → 0 (正しく 0)。
    seedForm('fa_B', 'フォームB', 0);

    const res = await call('GET', '/api/forms-advanced');
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: Record<string, unknown>[] }).data;
    const a = data.find((f) => f.id === 'fa_A');
    const b = data.find((f) => f.id === 'fa_B');
    expect(a!.submitCount).toBe(4);
    expect(b!.submitCount).toBe(0);
  });

  test('T-A3 暴走ガード: 一覧描画で Formaloo drill を一切しない (resolveFormalooClient 0 回)', async () => {
    seedForm('fa_A', 'フォームA', 0);
    seedMirror('a1', 'fa_A');
    seedMirror('a2', 'fa_A');

    const res = await call('GET', '/api/forms-advanced');
    expect(res.status).toBe(200);
    const a = (await res.json() as { data: Record<string, unknown>[] }).data.find((f) => f.id === 'fa_A');
    expect(a!.submitCount).toBe(2);
    // ミラー集約は local D1 のみ。Formaloo client は解決すらしない (= client.get 到達不能)。
    expect(hoisted.resolveSpy).not.toHaveBeenCalled();
  });
});
