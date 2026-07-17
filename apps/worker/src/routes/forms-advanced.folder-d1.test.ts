/**
 * D-1 (F6-3) — folder 追加が既存 form の serialize/一覧を byte-equivalent に保つ回帰固定。
 *   Codex M#7 の是正どおり byte-equivalent の対象は「既存 form の既存フィールド serialize が不変 +
 *   folderId は additive で NULL」に限定 (新設の未分類 UI 表示自体は byte 比較対象でない)。
 *   - migration 079 相当の最小列だけで作った legacy form (folder_id 未指定=NULL) が一覧/詳細に出る。
 *   - serialize の既存フィールド (F6-2 までの key) が F6-3 で欠落/改変しない。
 *   - folderId は additive で null (既存フォームは未分類)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
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
function call(method: string, path: string) {
  return app().request(path, { method, headers: { Authorization: OWNER, 'Content-Type': 'application/json' } }, env());
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('D-1 folder 追加は既存 form serialize を byte-equivalent に保つ', () => {
  test('legacy form (folder_id 未指定=NULL) は一覧に出て、既存フィールド不変 + folderId additive null', async () => {
    // migration 079 相当: 最小列だけで INSERT (line_account_id/workspace_id/folder_id を指定しない)。
    raw.prepare(
      `INSERT INTO formaloo_forms (id, title, description, definition_json, submit_count) VALUES (?,?,?,?,?)`,
    ).run('fa_legacy', '既存フォーム', '説明', '{"fields":[],"logic":[]}', 7);
    // forms-list-count-fix: 一覧の回答数表示源が submit_count 列 → D1 ミラー行数 (formaloo_submissions COUNT)
    //   へ切替わったため、submit_count=7 の INSERT だけではミラー 0 行で submitCount=0 になり fail する。
    //   「submitCount は実回答数」という本 test の意図をミラー背骨で維持するため fa_legacy に 7 行 seed。
    for (let i = 0; i < 7; i++) {
      raw.prepare(
        `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)`,
      ).run(`fa_legacy_sub_${i}`, 'fa_legacy', '{}', '2026-07-17T10:00:00+09:00');
    }

    const res = await call('GET', '/api/forms-advanced');
    expect(res.status).toBe(200);
    const item = (await res.json() as { data: Record<string, unknown>[] }).data.find((f) => f.id === 'fa_legacy');
    expect(item).toBeTruthy();

    // 既存フィールド (F6-2 までに serialize が返していた key) が F6-3 でも欠落/改変しない。
    for (const k of ['id', 'title', 'description', 'builderStatus', 'submitCount', 'fields', 'logic', 'publicUrl', 'syncStatus', 'lineAccountId', 'updatedAt']) {
      expect(item, `serialize から ${k} が欠落`).toHaveProperty(k);
    }
    expect(item!.title).toBe('既存フォーム');
    expect(item!.submitCount).toBe(7);
    expect(item!.lineAccountId).toBeNull();
    // folderId は additive で null (既存フォームは未分類)。
    expect(item).toHaveProperty('folderId');
    expect(item!.folderId).toBeNull();
  });

  test('詳細 (GET /:id) も legacy form を folderId=null で返す', async () => {
    raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json) VALUES ('fa_legacy2', 'L2', '{"fields":[],"logic":[]}')`).run();
    const res = await call('GET', '/api/forms-advanced/fa_legacy2');
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: Record<string, unknown> }).data;
    expect(d.title).toBe('L2');
    expect(d).toHaveProperty('folderId');
    expect(d.folderId).toBeNull();
  });
});
