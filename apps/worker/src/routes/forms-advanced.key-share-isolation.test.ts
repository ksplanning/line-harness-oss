/**
 * T-B4 (F6-2) — キー共有分離テスト。owner 原文『複数 LINE アカウント運用で Formaloo キー共有の場合、
 *   アカウント別に表示非表示ができないと A のフォームが B で見えてトラブル』の直接反証。
 *
 *   同一 workspace_id='fw_shared' (= 同じ Formaloo 鍵を共有) でありながら line_account_id が異なる 2 form を
 *   seed し、選択アカウントの一覧に「そのアカウントの form + 共通(NULL)」だけが出て、別アカウントの form が
 *   一切混ざらないことを確認する (鍵共有でも A/B が分離)。
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
function list(lineAccountId?: string) {
  const qs = lineAccountId ? `?lineAccountId=${encodeURIComponent(lineAccountId)}` : '';
  return app().request(`/api/forms-advanced${qs}`, {
    method: 'GET',
    headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
  }, env());
}

/** 同じ鍵 (workspace_id) を共有しつつ line_account_id が異なる form を seed。 */
function seedForm(id: string, lineAccountId: string | null, workspaceId: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, line_account_id, workspace_id)
     VALUES (?,?,'{"fields":[],"logic":[]}',?,?)`,
  ).run(id, id, lineAccountId, workspaceId);
}

async function listedIds(res: Response): Promise<string[]> {
  return ((await res.json() as { data: { id: string }[] }).data).map((f) => f.id);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  // 同一鍵 fw_shared を A/B で共有・共通 form は NULL/NULL。
  seedForm('form_A', 'acc_A', 'fw_shared');
  seedForm('form_B', 'acc_B', 'fw_shared');
  seedForm('form_common', null, null);
});

describe('T-B4 キー共有でも A/B 分離 (owner 懸念の直接反証)', () => {
  test('①acc_A の一覧に form_A は含まれ form_B は含まれない (交差ゼロ)', async () => {
    const ids = await listedIds(await list('acc_A'));
    expect(ids).toContain('form_A');
    expect(ids).not.toContain('form_B');
  });

  test('②acc_B の一覧は form_B のみ (form_A を含まない)', async () => {
    const ids = await listedIds(await list('acc_B'));
    expect(ids).toContain('form_B');
    expect(ids).not.toContain('form_A');
  });

  test('③line_account_id NULL の共通 form は両アカウントに出る', async () => {
    const idsA = await listedIds(await list('acc_A'));
    const idsB = await listedIds(await list('acc_B'));
    expect(idsA).toContain('form_common');
    expect(idsB).toContain('form_common');
  });

  test('同一鍵共有でも表示は line_account_id で分離される (workspace_id は表示に影響しない)', async () => {
    // form_A / form_B は同じ fw_shared を持つが、表示は line_account_id が権威。
    const idsA = await listedIds(await list('acc_A'));
    expect(idsA.sort()).toEqual(['form_A', 'form_common']);
  });
});
