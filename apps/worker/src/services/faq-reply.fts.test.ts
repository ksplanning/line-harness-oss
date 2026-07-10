/**
 * T-B3 (Phase B B-2) — retrieval 差替 (Dice-over-all → FTS5 recall + Dice 再ランク) の tryFaqReply 経路。
 * threshold=2 で Phase A を常に miss させ AI 後段を決定的に通す (topScore は実 Dice)。
 * ⚠️ FATAL 修正の証明: 検索スコア下限 (ai.retrievalFloor) を撤廃せず保持する三段防御。
 *   ① 候補あり but Dice<floor → below_retrieval_floor escalate (auto 送信しない)。
 *   ② 候補0 (無関係) → escalate。
 *   ③ Dice が floor を超える surface-collision (今日の天気) → 生成 → LLM __NO_ANSWER__ → no_answer escalate。
 * runFaqAiAnswer 本体は byte-identical (candidate の供給元だけ変わる)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { tryFaqReply } from './faq-reply.js';
import { buildFaqSearchText } from './faq-fts.js';
import { MockLlmProvider } from './llm/mock-provider.js';
import { type FaqAiRuntime } from './llm/runtime.js';
import { type LlmProvider } from './llm/llm-provider.js';

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
function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

const CORPUS = [
  { id: 'faq_park', q: '駐車場はありますか', v: ['車で来店できますか', 'パーキングの有無'] },
  { id: 'faq_hours', q: '営業時間を教えてください', v: ['何時まで開いていますか', '定休日はいつですか'] },
  { id: 'faq_resv', q: '予約は必要ですか', v: ['当日予約はできますか'] },
  { id: 'faq_pay', q: '支払い方法は何がありますか', v: ['クレジットカードは使えますか', '電子マネー対応'] },
  { id: 'faq_access', q: '最寄り駅からの行き方', v: ['アクセス方法を教えて'] },
];

function seed(raw: Database.Database, opts: { answerMode?: string; enabled?: boolean } = {}) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','t','s')`).run();
  raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id) VALUES ('f1','u1','acc-1')`).run();
  raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('s1','acc-1','faq_bot',?)`).run(JSON.stringify({
    enabled: opts.enabled ?? true, threshold: 2, handoffMessage: '', autoReplyNotice: '', maxRepliesPerDay: 5, answerMode: opts.answerMode ?? 'auto',
  }));
  const ins = raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, search_text) VALUES (?,?,?,?,?,1,?)`);
  for (const f of CORPUS) ins.run(f.id, 'acc-1', f.q, JSON.stringify(f.v), `${f.id} の答え`, buildFaqSearchText(f.q, f.v));
  // 判別用: question は一致するが search_text='' (backfill 前) の faq。question は corpus と bigram
  // 衝突ゼロ (実測)。Dice-over-all なら見つかるが FTS (search_text) では見つからない = 供給元 FTS の証明。
  ins.run('faq_stale', 'acc-1', '領収書の宛名変更', '[]', '窓口で承ります', '');
}

function rt(provider: LlmProvider): FaqAiRuntime {
  return { provider, retrievalFloor: 0.3, timeoutMs: 5000, neuronPerMTokIn: 4119, neuronPerMTokOut: 34868, dailyNeuronBudgetGlobal: 9000, dailyNeuronBudgetPerAccount: 9000 };
}
const OPTS = (text: string) => ({ friend: { id: 'f1', line_account_id: 'acc-1' }, incomingText: text, lineAccountId: 'acc-1', replyToken: 'rt1' });

let raw: Database.Database;
let db: D1Database;
let lineClient: { replyMessage: ReturnType<typeof vi.fn> };
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  lineClient = { replyMessage: vi.fn().mockResolvedValue({}) };
});
const countUnmatched = () => (raw.prepare(`SELECT COUNT(*) c FROM unmatched_questions`).get() as { c: number }).c;
const countDrafts = () => (raw.prepare(`SELECT COUNT(*) c FROM ai_faq_drafts`).get() as { c: number }).c;

describe('tryFaqReply — FTS retrieval 差替 + floor 保持 (T-B3)', () => {
  test('pos (Dice>floor): FTS recall→再ランク→生成→auto 送信 (replyMessage 1)', async () => {
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: '近くにコインパーキングがございます' });
    const res = await tryFaqReply(db, lineClient, OPTS('車を停める場所はありますか？'), rt(mock));
    expect(res).toEqual({ replied: true, handoff: false });
    expect(mock.calls).toHaveLength(1);
    expect(lineClient.replyMessage).toHaveBeenCalledTimes(1);
    expect(countUnmatched()).toBe(0);
  });

  test('FATAL: 候補あり but Dice(0.135)<floor(0.3) → below_retrieval_floor escalate (auto 送信しない・generate 前退避)', async () => {
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: '支払いの答え' });
    const res = await tryFaqReply(db, lineClient, OPTS('カード払いに対応してる？'), rt(mock));
    expect(res.replied).toBe(false);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(mock.calls).toHaveLength(0); // floor 未満は生成前に退避
    expect(countUnmatched()).toBe(1);
  });

  test('無関係 (候補0) 『宇宙で一番大きい星は？』 → escalate・provider 未呼出', async () => {
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: 'x' });
    const res = await tryFaqReply(db, lineClient, OPTS('宇宙で一番大きい星は？'), rt(mock));
    expect(res.replied).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(countUnmatched()).toBe(1);
  });

  test('三層目: surface-collision (今日の天気 Dice0.31>floor) → 生成 but LLM __NO_ANSWER__ → no_answer escalate', async () => {
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: '__NO_ANSWER__' });
    const res = await tryFaqReply(db, lineClient, OPTS('今日の天気を教えて'), rt(mock));
    expect(res.replied).toBe(false);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(mock.calls).toHaveLength(1); // floor は通過し生成された (LLM が分からないと判断)
    expect(countUnmatched()).toBe(1);
  });

  test('draft モード: pos で生成→ai_faq_drafts 保存・送信も退避もしない', async () => {
    seed(raw, { answerMode: 'draft' });
    const mock = new MockLlmProvider({ text: '近くにコインパーキングがございます' });
    const res = await tryFaqReply(db, lineClient, OPTS('車を停める場所はありますか？'), rt(mock));
    expect(res).toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(1);
    expect(countUnmatched()).toBe(0);
  });

  test('供給元=FTS の証明: question 一致だが search_text="" の faq_stale は recall されず escalate', async () => {
    // Dice-over-all なら faq_stale(question 完全一致=Dice1.0)が best になり生成するが、FTS retrieval では
    // search_text='' ゆえ recall されない → escalate。= AI 後段の候補供給元が FTS である証明 (RED で確認済)。
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: '窓口で承ります' });
    const res = await tryFaqReply(db, lineClient, OPTS('領収書の宛名変更'), rt(mock));
    expect(res.replied).toBe(false);
    expect(mock.calls).toHaveLength(0); // FTS 未 recall → 候補0 → 生成前退避
    expect(countUnmatched()).toBe(1);
  });

  test('dark-ship: enabled=false は ai runtime があっても provider を呼ばず送信しない', async () => {
    seed(raw, { answerMode: 'auto', enabled: false });
    const mock = new MockLlmProvider({ text: '近くにコインパーキングがございます' });
    const res = await tryFaqReply(db, lineClient, OPTS('車を停める場所はありますか？'), rt(mock));
    expect(res).toEqual({ replied: false, handoff: false });
    expect(mock.calls).toHaveLength(0);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
  });
});
