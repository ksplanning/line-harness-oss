/**
 * T-D5/T-D7 (Phase B B-4) — 取込 route の embed 配線 (ingest embed + delete cleanup)。
 *  - ingest (AI+VECTORIZE 設定時): chunk 保存後に embed → Vectorize upsert → embedded_at set。
 *  - delete: D1 削除の前に Vectorize ベクトルを削除 (孤児 leak 防止)。
 *  - **片側失敗**: Vectorize 削除が失敗しても D1 削除は続行 (孤児は掃除ジョブが回収・ingest/delete を止めない)。
 *  - Vectorize 未 binding では embed no-op (B-3 挙動・既存 route test が担保)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { knowledge } from './knowledge.js';
import type { Env } from '../index.js';
import type { WorkersAiBinding, WorkersAiRunResult } from '../services/llm/workers-ai.js';
import { chunkAccountMetadata, type VectorizeIndex, type VectorizeVectorInput } from '../services/vectorize.js';

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
      const tx = raw.transaction(() => stmts.map((st) => st.__exec()));
      tx();
      return stmts.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

const mockAi: WorkersAiBinding = { async run(): Promise<WorkersAiRunResult> { return { data: [[0.1, 0.2, 0.3]] }; } };

interface StoreVec { values: number[]; metadata: Record<string, unknown> }
function makeVectorize(store: Map<string, StoreVec>, opts: { failDelete?: boolean } = {}): VectorizeIndex {
  return {
    async upsert(vectors: VectorizeVectorInput[]) { for (const v of vectors) store.set(v.id, { values: v.values, metadata: v.metadata ?? {} }); return {}; },
    async query() { return { matches: [] }; },
    async deleteByIds(ids: string[]) { if (opts.failDelete) throw new Error('vectorize delete failed'); for (const id of ids) store.delete(id); return {}; },
    async getByIds(ids: string[]) { return ids.filter((id) => store.has(id)).map((id) => ({ id, values: store.get(id)!.values, metadata: store.get(id)!.metadata })); },
  };
}

let raw: Database.Database;
let DB: D1Database;
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });

function env(vectorize: VectorizeIndex): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'k',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    AI: mockAi, AI_MODEL_ID: 'gen-model', AI_EMBED_MODEL_ID: '@cf/qwen/qwen3-embedding-0.6b',
    VECTORIZE: vectorize,
  } as Env['Bindings'];
}
function localApp() { const a = new Hono<Env>(); a.route('/', knowledge); return a; }
const call = (vectorize: VectorizeIndex, method: string, path: string, body?: unknown) =>
  localApp().request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env(vectorize));

const embeddedCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_chunks WHERE embedded_at IS NOT NULL`).get() as { c: number }).c;
const chunkCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_chunks`).get() as { c: number }).c;
const docCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_documents`).get() as { c: number }).c;

describe('ingest embed 配線 (T-D5)', () => {
  test('AI+VECTORIZE 設定時: chunk 保存後に embed → Vectorize upsert → embedded_at set', async () => {
    const store = new Map<string, StoreVec>();
    const res = await call(makeVectorize(store), 'POST', '/api/knowledge/ingest?accountId=acc-1', {
      kind: 'text', content: '営業時間は10時から19時です。\n\n駐車場は店舗の裏にございます。',
    });
    expect(res.status).toBe(201);
    expect(chunkCount()).toBeGreaterThanOrEqual(1);
    expect(embeddedCount()).toBe(chunkCount()); // 全 chunk が embed 済
    expect(store.size).toBe(chunkCount()); // Vectorize に upsert 済
    // metadata に account (null 不可回避)。
    expect([...store.values()][0].metadata.line_account_id).toBe('acc-1');
  });
});

describe('delete cleanup 配線 (T-D7)', () => {
  async function ingest(store: Map<string, StoreVec>): Promise<string> {
    const res = await call(makeVectorize(store), 'POST', '/api/knowledge/ingest?accountId=acc-1', { kind: 'text', content: '駐車場は店舗の裏に10台分ございます。' });
    return (await res.json() as { data: { id: string } }).data.id;
  }

  test('delete で Vectorize ベクトルを削除 → D1 (chunks→document) も削除', async () => {
    const store = new Map<string, StoreVec>();
    const id = await ingest(store);
    expect(store.size).toBeGreaterThan(0);
    const res = await call(makeVectorize(store), 'DELETE', `/api/knowledge/documents/${id}?accountId=acc-1`);
    expect(res.status).toBe(200);
    expect(store.size).toBe(0); // ベクトル削除済 (孤児なし)
    expect(docCount()).toBe(0);
    expect(chunkCount()).toBe(0);
  });

  test('片側失敗: Vectorize 削除が失敗しても D1 削除は続行 (200・孤児は掃除ジョブが回収)', async () => {
    const store = new Map<string, StoreVec>();
    const id = await ingest(store);
    const before = store.size;
    expect(before).toBeGreaterThan(0);
    // deleteByIds が throw する vectorize で delete。
    const res = await call(makeVectorize(store, { failDelete: true }), 'DELETE', `/api/knowledge/documents/${id}?accountId=acc-1`);
    expect(res.status).toBe(200); // delete は失敗させない
    expect(docCount()).toBe(0); // D1 は削除される (owner の削除意図を尊重)
    expect(chunkCount()).toBe(0);
    expect(store.size).toBe(before); // Vectorize は残る (孤児 = 掃除ジョブ回収対象・ログ済)
  });
});
