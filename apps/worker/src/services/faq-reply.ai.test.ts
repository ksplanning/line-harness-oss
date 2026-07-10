/**
 * T-A2 (faq-reply 単体) — account gate (settings.enabled) + match=null 時の AI RAG 経路。
 *  - 第二ゲート enabled=false → 何もせず provider を呼ばない。
 *  - auto + 根拠あり → mock replyMessage が 1 回 (payload 構成の証明・「ゼロ証明」ではない)。
 *  - 根拠なし → recordUnmatchedQuestion に退避し replyMessage 0。
 *  - draft → ai_faq_drafts に保存し送信しない。
 *  - ai runtime 無し → match=null は従来通り recordUnmatchedQuestion (Phase A 非回帰)。
 * env gate (FAQ_BOT_ENABLED) は webhook.ts:722 のため本単体では assert しない (webhook.test.ts が担保)。
 * threshold=2 で detail.match を常に null にし AI 経路を決定的に通す (topScore は実 dice)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { tryFaqReply } from './faq-reply.js';
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

function seed(raw: Database.Database, opts: { enabled?: boolean; answerMode?: string; threshold?: number } = {}) {
  // FK 親行 (messages_log/unmatched_questions → friends / faqs·account_settings → line_accounts)。
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','t','s')`).run();
  raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id) VALUES ('f1','u1','acc-1')`).run();
  const value = JSON.stringify({
    enabled: opts.enabled ?? true,
    threshold: opts.threshold ?? 2, // 常に match=null → AI 経路を決定的に
    handoffMessage: '',
    autoReplyNotice: '',
    maxRepliesPerDay: 5,
    answerMode: opts.answerMode ?? 'auto',
  });
  raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('s1','acc-1','faq_bot',?)`).run(value);
  raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active) VALUES ('fq1','acc-1','営業時間は何時ですか','[]','平日は10時から19時までです',1)`).run();
}

function rt(provider: LlmProvider): FaqAiRuntime {
  return { provider, retrievalFloor: 0.3, timeoutMs: 5000, neuronPerMTokIn: 4119, neuronPerMTokOut: 34868, dailyNeuronBudgetGlobal: 9000, dailyNeuronBudgetPerAccount: 9000 };
}

const OPTS = (text: string) => ({
  friend: { id: 'f1', line_account_id: 'acc-1' },
  incomingText: text,
  lineAccountId: 'acc-1',
  replyToken: 'rt1',
});

let raw: Database.Database;
let db: D1Database;
let lineClient: { replyMessage: ReturnType<typeof vi.fn> };
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  lineClient = { replyMessage: vi.fn().mockResolvedValue({}) };
});

function countUnmatched() {
  return (raw.prepare(`SELECT COUNT(*) c FROM unmatched_questions`).get() as { c: number }).c;
}
function countDrafts() {
  return (raw.prepare(`SELECT COUNT(*) c FROM ai_faq_drafts`).get() as { c: number }).c;
}
function countFaqOutgoing() {
  return (raw.prepare(`SELECT COUNT(*) c FROM messages_log WHERE source='faq_bot'`).get() as { c: number }).c;
}

describe('tryFaqReply — account gate + AI RAG (T-A2)', () => {
  test('第二ゲート enabled=false → 何もせず provider を呼ばない', async () => {
    seed(raw, { enabled: false });
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock));
    expect(res).toEqual({ replied: false, handoff: false });
    expect(mock.calls).toHaveLength(0);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countUnmatched()).toBe(0);
  });

  test('auto + 根拠あり → replyMessage 1 回 (payload 証明) + faq_bot ログ・未対応退避しない', async () => {
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock));
    expect(res).toEqual({ replied: true, handoff: false });
    expect(mock.calls).toHaveLength(1);
    expect(lineClient.replyMessage).toHaveBeenCalledTimes(1);
    expect(countFaqOutgoing()).toBe(1);
    expect(countUnmatched()).toBe(0); // AI が答えた = 退避しない
  });

  test('根拠なし (floor 未満) → recordUnmatchedQuestion 退避 / replyMessage 0 / provider 未呼出', async () => {
    seed(raw, { answerMode: 'auto' });
    const mock = new MockLlmProvider({ text: 'なにか' });
    const res = await tryFaqReply(db, lineClient, OPTS('zzz 無関係 xyz 12ab'), rt(mock));
    expect(res.replied).toBe(false);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(mock.calls).toHaveLength(0); // floor 未満は generate 前に退避
    expect(countUnmatched()).toBe(1);
  });

  test('draft + 根拠あり → ai_faq_drafts に保存し送信しない・退避しない', async () => {
    seed(raw, { answerMode: 'draft' });
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock));
    expect(res).toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(1);
    expect(countUnmatched()).toBe(0);
  });

  test('ai runtime 無し → match=null は従来通り recordUnmatchedQuestion (Phase A 非回帰)', async () => {
    seed(raw, { answerMode: 'auto' });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか')); // ai 引数なし
    expect(res).toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countUnmatched()).toBe(1);
  });
});
