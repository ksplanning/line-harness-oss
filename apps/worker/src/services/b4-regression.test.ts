/**
 * D-1 / D-2 / D-3 (Phase B B-4) — 送信安全・回帰・cross-account/秘密漏洩 の機械 assert。
 *  D-1: 現在形不変 (crons 正定義2本 (2026-07-11 解禁)/FAQ_BOT_ENABLED スイッチ="true" go-live 承認/binding 意図形/webhook gate) + chunks 結線後も
 *       FAQ_BOT_ENABLED=false/account gate 閉で embed/generate/replyMessage 全 0 (RAG 配線が送信を漏らさない)。
 *  D-2: faq-match/faq-fts byte-identical + faq Dice floor 尺度不変 (baseline green/tsc は runner が担保)。
 *  D-3: embed 入力=chunk/質問のみ・buildRagPrompt に秘密値/内部識別子なし・Vectorize metadata は account/doc id のみ。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { tryFaqReply } from './faq-reply.js';
import { buildFaqSearchText } from './faq-fts.js';
import { buildRagPrompt, type FaqEvidence } from './faq-ai.js';
import { retrieveChunkEvidence, embedChunksForDocument, buildChunkSearchText, type ChunkEvidenceConfig } from './knowledge.js';
import { upsertChunkVectors, type VectorizeIndex, type VectorizeVectorInput } from './vectorize.js';
import { type FaqAiRuntime } from './llm/runtime.js';
import { type LlmProvider, type LlmPrompt } from './llm/llm-provider.js';
import { createKnowledgeDocument, insertKnowledgeChunks } from '@line-crm/db';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '../../../..');
const DB_ROOT = join(REPO, 'packages/db');
const BENIGN = /duplicate column name|already exists/i;
const readRepo = (p: string) => readFileSync(join(REPO, p), 'utf8');
function unchangedVsMain(p: string): boolean {
  try { execFileSync('git', ['diff', '--quiet', 'origin/main', '--', p], { cwd: REPO, stdio: 'pipe' }); return true; } catch { return false; }
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function d1(db: Database.Database): D1Database {
  const makeStmt = (sql: string) => {
    const s = db.prepare(sql);
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
    async batch(stmts: Array<{ __exec: () => unknown }>) { const tx = db.transaction(() => stmts.map((st) => st.__exec())); tx(); return stmts.map(() => ({ success: true })); },
  } as unknown as D1Database;
}

/** generate/embed の呼出回数を数える provider。 */
class CountingProvider implements LlmProvider {
  public readonly calls: LlmPrompt[] = [];
  public embedInputs: string[] = [];
  constructor(private readonly text: string, private readonly vec: number[]) {}
  async generate(prompt: LlmPrompt): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    this.calls.push(prompt);
    return { text: this.text, usage: { inputTokens: 10, outputTokens: 20 } };
  }
  async embed(text: string): Promise<number[]> { this.embedInputs.push(text); return this.vec; }
}

function mockVectorize(seed: Array<{ id: string; values: number[]; accountId: string | null }> = [], queryReturns: string[] = []): VectorizeIndex {
  const store = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  for (const s of seed) store.set(s.id, { values: s.values, metadata: { line_account_id: s.accountId ?? '__global__' } });
  return {
    async upsert(v) { for (const x of v) store.set(x.id, { values: x.values, metadata: x.metadata ?? {} }); return {}; },
    async query(_v, o) { return { matches: queryReturns.filter((id) => store.has(id)).slice(0, o?.topK ?? 10).map((id) => ({ id, score: 0.9 })) }; },
    async deleteByIds(ids) { for (const id of ids) store.delete(id); return {}; },
    async getByIds(ids) { return ids.filter((id) => store.has(id)).map((id) => ({ id, values: store.get(id)!.values, metadata: store.get(id)!.metadata })); },
  };
}

let raw: Database.Database;
let db: D1Database;
let lineClient: { replyMessage: ReturnType<typeof vi.fn> };
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); db = d1(raw); lineClient = { replyMessage: vi.fn().mockResolvedValue({}) }; });

function seedAccount(opts: { enabled: boolean }) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','t','s')`).run();
  raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id) VALUES ('f1','u1','acc-1')`).run();
  raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('s1','acc-1','faq_bot',?)`)
    .run(JSON.stringify({ enabled: opts.enabled, threshold: 2, handoffMessage: '', autoReplyNotice: '', maxRepliesPerDay: 5, answerMode: 'auto' }));
  raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, search_text) VALUES ('fq1','acc-1','営業時間は何時ですか','[]','平日は10時から19時までです',1,?)`)
    .run(buildFaqSearchText('営業時間は何時ですか', []));
}
function insertChunk(id: string, account: string | null, content: string) {
  raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES (?, 'text')`).run(`doc-${id}`);
  raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, line_account_id, chunk_index, content, search_text) VALUES (?,?,?,?,?,?)`)
    .run(id, `doc-${id}`, account, 0, content, buildChunkSearchText(content));
}
function ragRuntime(provider: LlmProvider, vectorize: VectorizeIndex): FaqAiRuntime {
  return { provider, retrievalFloor: 0.3, timeoutMs: 5000, neuronPerMTokIn: 4119, neuronPerMTokOut: 34868, dailyNeuronBudgetGlobal: 9000, dailyNeuronBudgetPerAccount: 9000, vectorize, embedModelId: 'm', chunkRelevanceFloor: 0.6, embedNeuronPerMTok: 100_000 };
}
const OPTS = { friend: { id: 'f1', line_account_id: 'acc-1' }, incomingText: '営業時間は何時ですか', lineAccountId: 'acc-1', replyToken: 'rt1' };

describe('D-1 — dark-ship byte-identical + chunks 結線後も送信ゼロ', () => {
  // 【2026-07-11 rebaseline】go-live で FAQ_BOT_ENABLED="true"。旧 assert は "false" 行1件を固定し恒久 RED 化。
  // 実体=crons 正定義2本 (2026-07-11 解禁)・全体スイッチが黙って書き換わらない を現在形で保護。
  test('wrangler crons 正定義2本 exact + FAQ_BOT_ENABLED スイッチ正確に1件・値="true"(go-live 承認)・"false" 残骸0件', () => {
    const lines = readRepo('apps/worker/wrangler.ks.toml').split('\n');
    // 2026-07-11 crons 解禁 (case line-crons-enable): crons=[] → 正定義2本。5min tick=配信/リマインダー/stuck 復旧/token refresh、6h tick=booking/event expirer (index.ts:708,736 の event.cron === '0 */6 * * *' と exact 一致)。config と同一 diff で更新し解禁直後の恒久 RED を防止。
    expect(lines.filter((l) => l === 'crons = ["*/5 * * * *", "0 */6 * * *"]')).toHaveLength(1); // 正 cron 2 本 exact (重複/追加なし)
    expect(lines.filter((l) => /^FAQ_BOT_ENABLED = "(?:true|false)"$/.test(l))).toEqual(['FAQ_BOT_ENABLED = "true"']);
    expect(lines.filter((l) => l === 'FAQ_BOT_ENABLED = "false"')).toHaveLength(0);
  });

  // 【2026-07-11 rebaseline】旧 assert は unchangedVsMain(origin/main 比較=時限式) で「B-4 は wrangler 無改変」を
  // 固定していたが、go-live で binding が正式結線され意図が obsolete 化。実体=binding 構成が意図した形から黙って
  // 変わらない を現在形 (現ソース直接) で保護し直す (時限式 origin/main 比較を排除)。
  test('wrangler binding は意図した現在形 ([ai]/[[vectorize]]/index_name が黙って変わらない)', () => {
    const lines = readRepo('apps/worker/wrangler.ks.toml').split('\n');
    expect(lines.filter((l) => l === '[ai]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'binding = "AI"')).toHaveLength(1);
    expect(lines.filter((l) => l === '[[vectorize]]')).toHaveLength(1);
    expect(lines.filter((l) => l === 'binding = "VECTORIZE"')).toHaveLength(1);
    expect(lines.filter((l) => l === 'index_name = "ks-knowledge-chunks"')).toHaveLength(1);
  });

  test('webhook faq gate 行が byte-identical (env-level dark-ship・webhook.ts は B-4 無改変)', () => {
    expect(readRepo('apps/worker/src/routes/webhook.ts')).toContain("if (!matched && faqBotEnabled === 'true') {");
    expect(unchangedVsMain('apps/worker/src/routes/webhook.ts')).toBe(true);
  });

  test('account gate 閉 (enabled=false) 時、RAG 完全配線でも embed/generate/replyMessage 全 0', async () => {
    seedAccount({ enabled: false });
    insertChunk('A', 'acc-1', '当店のご予約はお電話にて承っております');
    const provider = new CountingProvider('答え', [1, 0]);
    const vectorize = mockVectorize([{ id: 'A', values: [1, 0], accountId: 'acc-1' }], ['A']);
    const res = await tryFaqReply(db, lineClient, OPTS, ragRuntime(provider, vectorize));
    expect(res).toEqual({ replied: false, handoff: false });
    expect(provider.calls).toHaveLength(0);       // generate 0
    expect(provider.embedInputs).toHaveLength(0); // embed 0 (chunk 検索に到達しない)
    expect(lineClient.replyMessage).not.toHaveBeenCalled(); // 送信 0
  });

  test('gate 開でも escalate (ungrounded) は replyMessage 0 (chunk 結線が新送信経路を作らない)', async () => {
    seedAccount({ enabled: true });
    insertChunk('A', 'acc-1', '当店のご予約はお電話にて承っております');
    const provider = new CountingProvider('詳しくは https://evil.example/ へ', [1, 0]); // 根拠外 URL
    const vectorize = mockVectorize([{ id: 'A', values: [1, 0], accountId: 'acc-1' }], ['A']);
    const res = await tryFaqReply(db, lineClient, OPTS, ragRuntime(provider, vectorize));
    expect(res.replied).toBe(false);
    expect(lineClient.replyMessage).not.toHaveBeenCalled(); // ungrounded → escalate → 送信ゼロ
  });
});

describe('D-2 — matcher/retrieval byte-identical + Dice floor 尺度不変', () => {
  test.each([
    'apps/worker/src/services/faq-match.ts',
    'apps/worker/src/services/faq-fts.ts',
  ])('%s が origin/main と byte-identical', (p) => {
    expect(unchangedVsMain(p)).toBe(true);
  });

  test('faq-fts retrieveAndRankFaq の topScore は scoreFaq(Dice) 尺度のまま (floor 緩和なし)', () => {
    const src = readRepo('apps/worker/src/services/faq-fts.ts');
    expect(src).toContain('scoreFaq');
    expect(src).toContain('topScore: best ? best.score : null');
  });
});

describe('D-3 — 秘密値/内部識別子が embed 入力・プロンプト・metadata に載らない', () => {
  const FORBIDDEN = ['f1', 'acc-1', 'friend', 'friend_id', 'account_id', 'Bearer', 'token', 'CHANNEL_SECRET', 'ACCESS_TOKEN', 'secret'];

  test('buildRagPrompt (faq + chunk) に秘密値/内部識別子が混入しない', () => {
    const faq: FaqEvidence[] = [{ question: '営業時間は？', answer: '平日は10時から19時までです' }];
    const prompt = buildRagPrompt(faq, [{ content: '駐車場は店舗裏に3台あります' }], '営業時間を教えて');
    const whole = `${prompt.system}\n${prompt.user}`;
    for (const bad of FORBIDDEN) expect(whole).not.toContain(bad);
    // chunk は nonce fence で囲われている (instruction/data 分離)。
    expect(prompt.user).toMatch(/\[\[KB:[0-9a-f]{16}\]\]/);
  });

  test('質問時 embed 入力は質問テキストのみ (friend_id/account_id/token を渡さない)', async () => {
    insertChunk('A', 'acc-1', '当店の定休日は水曜です');
    const provider = new CountingProvider('答え', [1, 0]);
    const vectorize = mockVectorize([{ id: 'A', values: [1, 0], accountId: 'acc-1' }], ['A']);
    const cfg: ChunkEvidenceConfig = { provider, vectorize, embedModelId: 'm', chunkRelevanceFloor: 0.6, embedNeuronPerMTok: 100_000 };
    await retrieveChunkEvidence(db, cfg, '営業時間を教えて', 'acc-1');
    expect(provider.embedInputs).toEqual(['営業時間を教えて']); // 質問のみ
    for (const bad of FORBIDDEN) expect(provider.embedInputs.join('|')).not.toContain(bad);
  });

  test('取込時 embed 入力は chunk content のみ・Vectorize metadata は line_account_id/source_doc_id のみ (PII なし)', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: 'acc-1', sourceType: 'text' });
    await insertKnowledgeChunks(db, doc.id, 'acc-1', [{ chunkIndex: 0, content: '取込した本文です', searchText: 'とり' }]);
    const provider = new CountingProvider('x', [1, 0]);
    const upserts: VectorizeVectorInput[] = [];
    const vectorize: VectorizeIndex = {
      async upsert(v) { upserts.push(...v); return {}; },
      async query() { return { matches: [] }; }, async deleteByIds() { return {}; }, async getByIds() { return []; },
    };
    await embedChunksForDocument(db, { provider, vectorize, embedModelId: 'm', embedNeuronPerMTok: 100_000, globalBudget: 9000, perAccountBudget: 9000 }, doc.id, 'acc-1');
    expect(provider.embedInputs).toEqual(['取込した本文です']); // chunk content のみ
    // metadata の key は line_account_id / source_doc_id のみ (friend_id/token/PII なし)。
    expect(Object.keys(upserts[0].metadata ?? {}).sort()).toEqual(['line_account_id', 'source_doc_id']);
  });

  test('upsertChunkVectors の metadata が account/doc id のみ (直接 assert)', async () => {
    const upserts: VectorizeVectorInput[] = [];
    const idx: VectorizeIndex = { async upsert(v) { upserts.push(...v); return {}; }, async query() { return { matches: [] }; }, async deleteByIds() { return {}; }, async getByIds() { return []; } };
    await upsertChunkVectors(idx, [{ id: 'c1', values: [1, 0], accountId: 'acc-1', sourceDocId: 'd1' }]);
    expect(Object.keys(upserts[0].metadata ?? {}).sort()).toEqual(['line_account_id', 'source_doc_id']);
  });
});
