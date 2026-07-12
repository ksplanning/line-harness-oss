/**
 * line-staff-docs-chat T-C2 — end-to-end smoke (ローカル追認 / 実 docs/staff-guide 実 content で通し検証)。
 *
 * 実資料 (docs/staff-guide/*.md) を seedStaffDocs で staff corpus に取込み → runStaffDocsAnswer に
 * 「一斉配信はどこから作りますか」を投げると status:ok で該当章根拠 + citation docTitle が返り、
 * 顧客個人情報のような資料外の問いには no_evidence で fail-closed することを、実 SQLite + filter-aware
 * fake Vectorize + content-aware mock provider で通しで確認する。**live (dev/preview) 追認は O-1 = closer**。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { seedStaffDocs, runStaffDocsAnswer, type StaffDocInput, type StaffDocsRuntime } from './staff-docs.js';
import { cosine as cosineSim } from './knowledge.js';
import type { EmbedIngestConfig } from './knowledge.js';
import type { VectorizeIndex, VectorizeVectorInput } from './vectorize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const GUIDE_DIR = join(__dirname, '../../../../docs/staff-guide');
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
    async batch(stmts: Array<{ __exec: () => unknown }>) { const tx = raw.transaction(() => stmts.map((st) => st.__exec())); tx(); return stmts.map(() => ({ success: true })); },
  } as unknown as D1Database;
}

/** metadata filter を忠実評価 + cosine 実計算する fake Vectorize (S-1 の三層目=live の局所代替)。 */
function filterAwareVectorize() {
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  const matches = (metadata: Record<string, unknown>, filter?: Record<string, unknown>): boolean => {
    if (!filter) return true;
    for (const [k, cond] of Object.entries(filter)) {
      const v = metadata?.[k];
      if (cond && typeof cond === 'object' && '$in' in (cond as object)) { if (!((cond as { $in: unknown[] }).$in).includes(v)) return false; }
      else if (v !== cond) return false;
    }
    return true;
  };
  const idx: VectorizeIndex = {
    async upsert(vectors: VectorizeVectorInput[]) { for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: v.metadata ?? {} }); return {}; },
    async query(vector: number[], options) {
      const out = [] as Array<{ id: string; score: number; metadata: Record<string, unknown> }>;
      for (const v of store.values()) {
        if (!matches(v.metadata, options?.filter as Record<string, unknown> | undefined)) continue;
        out.push({ id: v.id, score: cosineSim(vector, v.values), metadata: v.metadata });
      }
      out.sort((a, b) => b.score - a.score);
      return { matches: out.slice(0, options?.topK ?? 10) };
    },
    async deleteByIds(ids: string[]) { for (const id of ids) store.delete(id); return {}; },
    async getByIds(ids: string[]) { return ids.map((id) => store.get(id)).filter((v): v is NonNullable<typeof v> => !!v).map((v) => ({ id: v.id, values: v.values, metadata: v.metadata })); },
  };
  return idx;
}

// content-aware embed: staff トピック語を含む文は [1,0,0]、資料外の問いは [0,1,0] (cosine 0 → floor 下回り fail-closed)。
const STAFF_TOPIC = /配信|友だち|シナリオ|テンプレ|タグ|ステップ|吹き出し|メッセージ|管理画面|メニュー|セット|一斉/;
function topicProvider() {
  return {
    async embed(text: string) { return STAFF_TOPIC.test(text) ? [1, 0, 0] : [0, 1, 0]; },
    async generate() { return { text: '一斉配信は、左メニューの「一斉配信」から「+ 新規配信」を押して作成します。', usage: { inputTokens: 20, outputTokens: 20 } }; },
  };
}

function loadRealGuide(): StaffDocInput[] {
  return readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort().map((f) => {
    const content = readFileSync(join(GUIDE_DIR, f), 'utf8');
    const m = content.match(/^\s*#\s+(.+?)\s*$/m);
    return { docKey: basename(f, '.md'), title: m ? m[1].trim() : basename(f, '.md'), content };
  });
}

let raw: Database.Database;
let db: D1Database;
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); db = d1(raw); });

function embedCfg(vec: VectorizeIndex): EmbedIngestConfig {
  return { provider: topicProvider(), vectorize: vec, embedModelId: '@cf/qwen/qwen3-embedding-0.6b', embedNeuronPerMTok: 3000, globalBudget: 9_000_000, perAccountBudget: 9_000_000 };
}
function runtime(vec: VectorizeIndex): StaffDocsRuntime {
  return {
    provider: topicProvider(), vectorize: vec, embedModelId: '@cf/qwen/qwen3-embedding-0.6b',
    chunkRelevanceFloor: 0.6, embedNeuronPerMTok: 3000, neuronPerMTokIn: 4119, neuronPerMTokOut: 34868,
    dailyNeuronBudgetGlobal: 9_000_000, dailyNeuronBudgetPerAccount: 9_000_000, timeoutMs: 8000,
  };
}

describe('T-C2 end-to-end smoke (実 docs/staff-guide 実 content)', () => {
  test('実資料 5 章を seed → 「一斉配信はどこから作りますか」→ status:ok + 一斉配信の docTitle 引用', async () => {
    const vec = filterAwareVectorize();
    const docs = loadRealGuide();
    expect(docs.length).toBeGreaterThanOrEqual(5); // 高価値 5 章

    const seed = await seedStaffDocs(db, docs, embedCfg(vec));
    expect(seed.created).toBe(docs.length);

    const res = await runStaffDocsAnswer(db, '一斉配信はどこから作りますか', runtime(vec));
    expect(res.status).toBe('ok');
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.citations.length).toBeGreaterThanOrEqual(1);
    // 根拠資料に「一斉配信」章が入る (該当章を根拠にしている)。
    expect(res.citations.some((c) => c.docTitle.includes('一斉配信'))).toBe(true);
  });

  test('資料外の問い (顧客の個人情報) → no_evidence で fail-closed (推測回答しない)', async () => {
    const vec = filterAwareVectorize();
    await seedStaffDocs(db, loadRealGuide(), embedCfg(vec));
    const res = await runStaffDocsAnswer(db, '顧客ひとりひとりの住所と電話番号を一覧で出して', runtime(vec));
    expect(res.status).toBe('no_evidence');
    expect(res.answer).toBe('');
  });
});
