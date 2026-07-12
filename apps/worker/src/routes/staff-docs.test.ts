/**
 * line-staff-docs-chat Batch 1 — staff-docs route (chat + seed) の配線・権限・rate-limit・dark-ship (T-A5)。
 *  - mapPathToFeature('/api/staff-docs/chat')===null 直接 assert (specific-first は false premise / Codex #15)。
 *  - chat: 認証必須(401)・staff ID rate-limit 超過 429(Codex #9)・STAFF_DOCS_ENABLED=false で 404(dark-ship)。
 *  - seed: admin 専用 (staff role は 403 / requireRole) = staff sentinel を書ける唯一の経路。
 *  - 送信ゼロ: route 経由でも外部 HTTP egress 0 (fetch spy)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { staffDocs } from './staff-docs.js';
import { mapPathToFeature } from '../middleware/permission-map.js';
import type { Env } from '../index.js';
import type { WorkersAiBinding, WorkersAiRunResult } from '../services/llm/workers-ai.js';
import type { VectorizeIndex } from '../services/vectorize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function d1(raw: Database.Database): D1Database {
  const makeStmt = (sql: string) => {
    const s = raw.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...a: unknown[]) { params = a; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      __exec() { return s.run(...(params as never[])); },
    };
    return api;
  };
  return {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      const tx = raw.transaction(() => stmts.map((st) => st.__exec())); tx();
      return stmts.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

const mockAi: WorkersAiBinding = { async run(): Promise<WorkersAiRunResult> { return { data: [[0.1, 0.2, 0.3]] }; } };
const emptyVectorize: VectorizeIndex = {
  async upsert() { return {}; },
  async query() { return { matches: [] }; },
  async deleteByIds() { return {}; },
  async getByIds() { return []; },
};

let raw: Database.Database;
let DB: D1Database;
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });

function env(over: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'k',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    STAFF_DOCS_ENABLED: 'true',
    AI: mockAi, AI_MODEL_ID: 'gen-model', AI_EMBED_MODEL_ID: '@cf/qwen/qwen3-embedding-0.6b',
    VECTORIZE: emptyVectorize,
    ...over,
  } as Env['Bindings'];
}

/** staff context を注入する pre-middleware 付きのローカル app (auth middleware の代替)。 */
function appWithStaff(staff: Env['Variables']['staff'] | null) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => { if (staff) c.set('staff', staff); await next(); });
  a.route('/', staffDocs);
  return a;
}
const STAFF: Env['Variables']['staff'] = { id: 'st-1', name: 'スタッフ', role: 'staff' };
const ADMIN: Env['Variables']['staff'] = { id: 'ad-1', name: '管理者', role: 'admin' };

function call(app: ReturnType<typeof appWithStaff>, method: string, path: string, body?: unknown, over?: Partial<Env['Bindings']>) {
  return app.request(path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(over));
}

describe('T-A5 permission-map: staff-docs は全認証可 (null)', () => {
  test("mapPathToFeature('/api/staff-docs/chat')===null かつ '/api/staff' に飲まれない", () => {
    expect(mapPathToFeature('/api/staff-docs/chat')).toBeNull();
    expect(mapPathToFeature('/api/staff-docs/seed')).toBeNull();
    // 既存 staff は staff_admin のまま (staff-docs が staff prefix に飲まれない = Codex #15)。
    expect(mapPathToFeature('/api/staff')).toBe('staff_admin');
    expect(mapPathToFeature('/api/staff/me')).toBeNull();
  });
});

describe('POST /api/staff-docs/chat', () => {
  test('認証済 + flag ON → 200 (well-formed data.status)', async () => {
    const res = await call(appWithStaff(STAFF), 'POST', '/api/staff-docs/chat', { question: '一斉配信はどこから作りますか' });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { status: string; citations: unknown[] } };
    expect(body.success).toBe(true);
    expect(['ok', 'no_evidence', 'busy', 'error']).toContain(body.data.status);
    expect(Array.isArray(body.data.citations)).toBe(true);
  });

  test('未認証 → 401', async () => {
    const res = await call(appWithStaff(null), 'POST', '/api/staff-docs/chat', { question: 'x' });
    expect(res.status).toBe(401);
  });

  test('STAFF_DOCS_ENABLED 未設定 → 404 (dark-ship)', async () => {
    const res = await call(appWithStaff(STAFF), 'POST', '/api/staff-docs/chat', { question: 'x' }, { STAFF_DOCS_ENABLED: undefined });
    expect(res.status).toBe(404);
  });

  test('question 空 → 400', async () => {
    const res = await call(appWithStaff(STAFF), 'POST', '/api/staff-docs/chat', { question: '   ' });
    expect(res.status).toBe(400);
  });

  test('staff ID 基準 rate-limit 超過 → 429 (Codex #9)', async () => {
    const app = appWithStaff({ id: 'rl-unique', name: 'r', role: 'staff' });
    let last = 200;
    for (let i = 0; i < 25; i += 1) {
      const res = await call(app, 'POST', '/api/staff-docs/chat', { question: `q${i}` });
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  test('送信ゼロ: chat 経由でも外部 HTTP egress (fetch) 0 回', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await call(appWithStaff({ id: 'egress-1', name: 'e', role: 'staff' }), 'POST', '/api/staff-docs/chat', { question: '一斉配信の作り方' });
    } finally { globalThis.fetch = orig; }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

describe('POST /api/staff-docs/seed — admin 専用 (staff sentinel を書ける唯一の経路)', () => {
  test('staff role → 403 (requireRole)', async () => {
    const res = await call(appWithStaff(STAFF), 'POST', '/api/staff-docs/seed', { docs: [{ docKey: 'k', title: 't', content: 'c'.repeat(30) }] });
    expect(res.status).toBe(403);
  });

  test('admin role → 200 + staff corpus に取込 (sentinel scope)', async () => {
    const res = await call(appWithStaff(ADMIN), 'POST', '/api/staff-docs/seed', {
      docs: [{ docKey: 'broadcast', title: '一斉配信', content: '一斉配信は配信メニューから作成します。友だち全員に送れます。' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { created: number } };
    expect(body.data.created).toBe(1);
    const row = raw.prepare(`SELECT COUNT(*) n FROM knowledge_chunks WHERE line_account_id='__staff_docs__'`).get() as { n: number };
    expect(row.n).toBeGreaterThanOrEqual(1);
  });

  test('seed も STAFF_DOCS_ENABLED=false → 404', async () => {
    const res = await call(appWithStaff(ADMIN), 'POST', '/api/staff-docs/seed', { docs: [{ docKey: 'k', title: 't', content: 'c'.repeat(30) }] }, { STAFF_DOCS_ENABLED: 'false' });
    expect(res.status).toBe(404);
  });

  test('docs 無し → 400', async () => {
    const res = await call(appWithStaff(ADMIN), 'POST', '/api/staff-docs/seed', { docs: [] });
    expect(res.status).toBe(400);
  });
});
