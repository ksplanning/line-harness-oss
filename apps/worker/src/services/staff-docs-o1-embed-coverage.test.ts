/**
 * line-staff-docs-chat O-1 — seed embed coverage 可観測性 (positive path 点灯前実証の precondition)。
 *
 * O-1 (closer 本番 smoke): seed=200 (created=5) だが POST /chat が no_evidence。手動 cosine は
 * retrieval 閾値を超えていた → 下流疑い。本 test は **根因を offline で faithful に再現**する:
 *   Vectorize index 未 provisioning (upsert throw) だと seedStaffDocs は embed を silent swallow し
 *   created=5 の「成功」を返すが、staff chunk は全て embedded_at NULL = 検索不能ベクトル 0 →
 *   runStaffDocsAnswer は fail-closed で no_evidence を返す (= 本番 O-1 の症状)。
 *
 * 修正 (最小・fail-closed/injection 防御は 1mm も緩めない・顧客経路 byte 不変): seedStaffDocs の戻りに
 * staff corpus の embed 被覆 (embedded / embedPending) を surface する。運用者は点灯前に embedPending===0
 * (= 全 chunk が検索可能) を機械確認できる。retrieval / grounding / prompt は一切変えない。
 *
 * 実 5 章 (docs/staff-guide/*.md) を実 content で seed し、filter-aware fake Vectorize + real SQLite で通す。
 * positive (根拠あり→ok+citation) / negative (資料外→no_evidence) の両不変を同時に守る。
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

/** metadata filter 忠実評価 + cosine 実計算の fake Vectorize。upsertThrows で「index 未 provisioning」を再現。 */
function filterAwareVectorize(opts: { upsertThrows?: boolean } = {}) {
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
    async upsert(vectors: VectorizeVectorInput[]) {
      if (opts.upsertThrows) throw new Error('vectorize index not ready (provisioning incomplete)');
      for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: v.metadata ?? {} });
      return {};
    },
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

// content-aware embed: staff トピック語 → [1,0,0]、資料外の問い → [0,1,0] (cosine 0 → floor 下回り fail-closed)。
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
function embedCfg(vec: VectorizeIndex): EmbedIngestConfig {
  return { provider: topicProvider(), vectorize: vec, embedModelId: '@cf/qwen/qwen3-embedding-0.6b', embedNeuronPerMTok: 3000, globalBudget: 9_000_000, perAccountBudget: 9_000_000 };
}
// runtime は本番 wrangler.ks.toml と同じ floor 0.70 で評価する (本番設定の再現)。
function runtime(vec: VectorizeIndex): StaffDocsRuntime {
  return {
    provider: topicProvider(), vectorize: vec, embedModelId: '@cf/qwen/qwen3-embedding-0.6b',
    chunkRelevanceFloor: 0.70, embedNeuronPerMTok: 3000, neuronPerMTokIn: 4119, neuronPerMTokOut: 34868,
    dailyNeuronBudgetGlobal: 9_000_000, dailyNeuronBudgetPerAccount: 9_000_000, timeoutMs: 8000,
  };
}

let raw: Database.Database; let db: D1Database;
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); db = d1(raw); });

describe('O-1 seed embed coverage 可観測性 (点灯前 precondition)', () => {
  test('根因再現: Vectorize 未 provisioning → seed は created を返すが embedPending>0 で全 chunk 未 embed、chat は no_evidence', async () => {
    const vec = filterAwareVectorize({ upsertThrows: true });
    const docs = loadRealGuide();
    expect(docs.length).toBeGreaterThanOrEqual(5);

    const seed = await seedStaffDocs(db, docs, embedCfg(vec));
    // seed 自体は「成功」(created=5) を返す = 運用者に見える success signal は従来これだけだった。
    expect(seed.created).toBe(docs.length);
    // 修正で追加した embed 被覆: upsert が通っていないので queryable ベクトルは 0。
    expect(seed.embedded).toBe(0);
    expect(seed.embedPending).toBeGreaterThan(0); // 全 chunk が embedded_at NULL = 検索不能

    // 本番 O-1 症状の再現: 検索不能ベクトルゆえ fail-closed no_evidence。
    const res = await runStaffDocsAnswer(db, '一斉配信はどこから作りますか', runtime(vec));
    expect(res.status).toBe('no_evidence');
    expect(res.citations.length).toBe(0);
  });

  test('positive path: Vectorize provisioning 済 → embedPending===0 & embedded>0、根拠あり質問は status:ok + 一斉配信 citation', async () => {
    const vec = filterAwareVectorize();
    const docs = loadRealGuide();
    const seed = await seedStaffDocs(db, docs, embedCfg(vec));

    // 点灯前 precondition: 全 staff chunk が embed 済 (検索可能) を機械確認できる。
    expect(seed.embedded).toBeGreaterThan(0);
    expect(seed.embedPending).toBe(0);

    const res = await runStaffDocsAnswer(db, '一斉配信はどこから作りますか', runtime(vec));
    expect(res.status).toBe('ok');
    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.citations.length).toBeGreaterThanOrEqual(1);
    expect(res.citations.some((c) => c.docTitle.includes('一斉配信'))).toBe(true);
  });

  test('negative control (fail-closed 不変): 資料外の問い → no_evidence (embed 被覆が揃っていても無根拠は通さない)', async () => {
    const vec = filterAwareVectorize();
    const seed = await seedStaffDocs(db, loadRealGuide(), embedCfg(vec));
    expect(seed.embedPending).toBe(0); // 検索可能な状態でも…
    const res = await runStaffDocsAnswer(db, '顧客ひとりひとりの住所と電話番号を一覧で出して', runtime(vec));
    expect(res.status).toBe('no_evidence'); // …資料外は fail-closed のまま (緩めていない)
    expect(res.answer).toBe('');
  });

  test('embed 被覆は unchanged 再 seed でも corpus 実状態を反映 (DB count 由来・per-run 集計でない)', async () => {
    const vec = filterAwareVectorize();
    const docs = loadRealGuide();
    await seedStaffDocs(db, docs, embedCfg(vec)); // 1 回目: 全 embed
    const seed2 = await seedStaffDocs(db, docs, embedCfg(vec)); // 2 回目: 全 unchanged (embed 呼ばれない)
    expect(seed2.unchanged).toBe(docs.length);
    // per-run 集計なら embedded=0 になってしまうが、corpus count 由来なので embed 済を正しく反映。
    expect(seed2.embedded).toBeGreaterThan(0);
    expect(seed2.embedPending).toBe(0);
  });
});
