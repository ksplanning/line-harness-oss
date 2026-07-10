/**
 * T-A3 + T-A4 (Phase B B-1) — AI 後段オーケストレーション。
 *  T-A3 根拠妥当性: (i)floor 未満 (ii)LLM分からない (iii)timeout/例外/usage欠損 (iv)根拠外URL/電話
 *        のいずれでも escalate (送らない・provider を呼ばないか結果を捨てる)。
 *  T-A4 answer_mode: auto=送信 payload 用に auto_send / draft=ai_faq_drafts に pending 保存。
 *  D-2 (プロンプト): system(上位) + 根拠 + 質問 のみ・秘密値/friend_id を載せない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  buildFaqPrompt,
  detectNoAnswer,
  validateAnswerGrounding,
  extractUrlsAndPhones,
  runFaqAiAnswer,
  FAQ_AI_UNKNOWN_SENTINEL,
} from './faq-ai.js';
import { MockLlmProvider } from './llm/mock-provider.js';
import { type FaqAiRuntime } from './llm/runtime.js';
import { type LlmProvider } from './llm/llm-provider.js';
import { type FaqMatchDetail, type MatchableFaq } from './faq-match.js';
import { utcDay } from '@line-crm/db';

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

const FAQ: MatchableFaq = {
  id: 'fq-1',
  line_account_id: null,
  question: '営業時間は？',
  variants: [],
  answer: '平日は10時から19時までです',
  is_active: 1,
  hit_count: 0,
  created_at: '',
  updated_at: '',
} as unknown as MatchableFaq;

function detail(topScore: number | null): FaqMatchDetail {
  return { match: null, best: topScore == null ? null : { faq: FAQ, score: topScore }, topScore };
}

function rt(provider: LlmProvider, over: Partial<FaqAiRuntime> = {}): FaqAiRuntime {
  return {
    provider,
    retrievalFloor: 0.3,
    timeoutMs: 5000,
    neuronPerMTokIn: 4119,
    neuronPerMTokOut: 34868,
    dailyNeuronBudgetGlobal: 9000,
    dailyNeuronBudgetPerAccount: 9000,
    ...over,
  };
}

const INPUT = { question: '営業時間を教えて', answerMode: 'auto' as const, lineAccountId: 'acc-1', friendId: 'f1', overLimit: false };

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('buildFaqPrompt (D-2)', () => {
  test('system(上位) + 根拠 + 質問 のみ / friend_id・秘密値を載せない', () => {
    const p = buildFaqPrompt({ question: '営業時間は？', answer: '10-19時' }, '営業時間を教えて');
    expect(p.system).toContain(FAQ_AI_UNKNOWN_SENTINEL);
    expect(p.user).toContain('営業時間は？');
    expect(p.user).toContain('10-19時');
    expect(p.user).toContain('営業時間を教えて');
    // friend_id / account_id / token 等の内部識別子が混入しない
    for (const bad of ['f1', 'acc-1', 'friend', 'token', 'Bearer']) {
      expect(`${p.system}\n${p.user}`).not.toContain(bad);
    }
  });
});

describe('detectNoAnswer / grounding helpers', () => {
  test('sentinel / 空文字 は「分からない」', () => {
    expect(detectNoAnswer(FAQ_AI_UNKNOWN_SENTINEL)).toBe(true);
    expect(detectNoAnswer('   ')).toBe(true);
    expect(detectNoAnswer('10時からです')).toBe(false);
  });

  test('extractUrlsAndPhones は URL と電話を拾う', () => {
    const found = extractUrlsAndPhones('詳しくは https://ex.com/a と 03-1234-5678 へ');
    expect(found).toContain('https://ex.com/a');
    expect(found.some((x) => x.replace(/[^\d]/g, '') === '0312345678')).toBe(true);
  });

  test('根拠に無い URL/電話を導入したら false', () => {
    const evidence = '10時から19時までです';
    expect(validateAnswerGrounding('10時から19時までです', evidence)).toBe(true);
    expect(validateAnswerGrounding('詳細は https://evil.example/x へ', evidence)).toBe(false);
    expect(validateAnswerGrounding('お電話は 03-9999-0000 まで', evidence)).toBe(false);
  });
});

describe('runFaqAiAnswer — 根拠なしエスカレーション (T-A3)', () => {
  test('(i) topScore < floor → escalate・provider を呼ばない', async () => {
    const mock = new MockLlmProvider({ text: '答え' });
    const out = await runFaqAiAnswer(db, detail(0.2), INPUT, rt(mock));
    expect(out.kind).toBe('escalate');
    expect(mock.calls).toHaveLength(0);
  });

  test('best/topScore が null → escalate', async () => {
    const mock = new MockLlmProvider({ text: '答え' });
    const out = await runFaqAiAnswer(db, detail(null), INPUT, rt(mock));
    expect(out.kind).toBe('escalate');
    expect(mock.calls).toHaveLength(0);
  });

  test('pre-flight: overLimit → generate せず escalate', async () => {
    const mock = new MockLlmProvider({ text: '答え' });
    const out = await runFaqAiAnswer(db, detail(0.5), { ...INPUT, overLimit: true }, rt(mock));
    expect(out.kind).toBe('escalate');
    expect(mock.calls).toHaveLength(0);
  });

  test('(iii) provider timeout/例外 → escalate', async () => {
    const mock = new MockLlmProvider({ throwError: true });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock));
    expect(out.kind).toBe('escalate');
  });

  test('(ii) LLM「分からない」(sentinel) → escalate', async () => {
    const mock = new MockLlmProvider({ text: FAQ_AI_UNKNOWN_SENTINEL });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock));
    expect(out.kind).toBe('escalate');
  });

  test('(iii) usage 欠損 → escalate (accounting できない=送らない)', async () => {
    const mock = new MockLlmProvider({ text: '10時から19時までです', usage: undefined });
    // MockLlmProvider は usage 未指定だと既定 usage を返すため、明示的に usage を消す provider を用意
    const noUsage: LlmProvider = {
      async generate() { return { text: '10時から19時までです' }; },
      async embed() { return []; },
    };
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(noUsage));
    expect(out.kind).toBe('escalate');
    void mock;
  });

  test('(iv) 根拠に無い URL を導入 → escalate', async () => {
    const mock = new MockLlmProvider({ text: '詳しくは https://phish.example へ' });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock));
    expect(out.kind).toBe('escalate');
  });
});

describe('runFaqAiAnswer — answer_mode (T-A4)', () => {
  test('auto + 根拠あり → auto_send(answer) / provider 1 回', async () => {
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock));
    expect(out).toEqual({ kind: 'auto_send', answer: '平日は10時から19時までです' });
    expect(mock.calls).toHaveLength(1);
  });

  test('draft + 根拠あり → ai_faq_drafts に pending 保存・送信しない', async () => {
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const out = await runFaqAiAnswer(db, detail(0.5), { ...INPUT, answerMode: 'draft' }, rt(mock));
    expect(out.kind).toBe('draft_saved');
    const row = raw.prepare(`SELECT * FROM ai_faq_drafts WHERE friend_id='f1'`).get() as Record<string, string>;
    expect(row.status).toBe('pending');
    expect(row.draft_answer).toBe('平日は10時から19時までです');
    expect(JSON.parse(row.evidence_faq_ids)).toEqual(['fq-1']);
  });
});

describe('runFaqAiAnswer — budget 配線 (T-A6)', () => {
  const DAY = utcDay();
  function seedUsage(account: string, neurons: number) {
    raw.prepare(`INSERT INTO ai_usage_budget (id, line_account_id, usage_date, llm_neurons) VALUES (?, ?, ?, ?)`)
      .run(`u-${account}`, account, DAY, neurons);
  }

  test('pre-flight: 全 account 合算がグローバル上限に到達 → generate せず escalate (別 account 消費でも)', async () => {
    seedUsage('acc-2', 9000); // 別 account が共有枠を使い切る
    const mock = new MockLlmProvider({ text: '答え' });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock)); // global=9000
    expect(out.kind).toBe('escalate');
    expect(mock.calls).toHaveLength(0);
  });

  test('pre-flight: 当該 account が per-account 上限に到達 → generate せず escalate', async () => {
    seedUsage('acc-1', 9000);
    const mock = new MockLlmProvider({ text: '答え' });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock, { dailyNeuronBudgetGlobal: 1_000_000 }));
    expect(out.kind).toBe('escalate');
    expect(mock.calls).toHaveLength(0);
  });

  test('pre-flight: 上限未満 → generate し、消費 neuron を token→neuron 換算で加算 (reply_count 1)', async () => {
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです', usage: { inputTokens: 100, outputTokens: 50 } });
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(mock));
    expect(out.kind).toBe('auto_send');
    const row = raw.prepare(`SELECT llm_neurons, reply_count FROM ai_usage_budget WHERE line_account_id='acc-1' AND usage_date=?`).get(DAY) as { llm_neurons: number; reply_count: number };
    // (100*4119 + 50*34868)/1e6 = ceil(2.15...) 以上 = 正の neuron
    expect(row.llm_neurons).toBeGreaterThan(0);
    expect(row.reply_count).toBe(1);
  });

  test('生成した以上は退避しても neuron を計上する (usage 欠損=推定でも加算後 escalate)', async () => {
    const noUsage: LlmProvider = { async generate() { return { text: '10時から19時までです' }; }, async embed() { return []; } };
    const out = await runFaqAiAnswer(db, detail(0.5), INPUT, rt(noUsage));
    expect(out.kind).toBe('escalate'); // usage 欠損 → 送らない
    const row = raw.prepare(`SELECT llm_neurons FROM ai_usage_budget WHERE line_account_id='acc-1' AND usage_date=?`).get(DAY) as { llm_neurons: number } | undefined;
    expect(row?.llm_neurons ?? 0).toBeGreaterThan(0); // 消費分は計上済
  });
});
