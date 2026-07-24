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
import { buildRagPrompt } from './faq-ai.js';
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

interface SeedOptions {
  enabled?: boolean;
  answerMode?: string;
  omitAnswerMode?: boolean;
  threshold?: number;
  maxRepliesPerDay?: number;
  handoffMessage?: string;
  replyStyle?: { instructions: string; greeting: string };
  accountId?: string;
  friendId?: string;
  faqId?: string;
}

function seed(raw: Database.Database, opts: SeedOptions = {}) {
  const accountId = opts.accountId ?? 'acc-1';
  const friendId = opts.friendId ?? 'f1';
  const faqId = opts.faqId ?? 'fq1';
  // FK 親行 (messages_log/unmatched_questions → friends / faqs·account_settings → line_accounts)。
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, `channel-${accountId}`, accountId, `token-${accountId}`, `secret-${accountId}`);
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id) VALUES (?, ?, ?)`,
  ).run(friendId, `line-user-${friendId}`, accountId);
  const settings: Record<string, unknown> = {
    enabled: opts.enabled ?? true,
    threshold: opts.threshold ?? 2, // 常に match=null → AI 経路を決定的に
    handoffMessage: opts.handoffMessage ?? '',
    autoReplyNotice: '',
    maxRepliesPerDay: opts.maxRepliesPerDay ?? 5,
  };
  if (!opts.omitAnswerMode) settings.answerMode = opts.answerMode ?? 'auto';
  if (opts.replyStyle) settings.replyStyle = opts.replyStyle;
  const value = JSON.stringify(settings);
  raw.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value) VALUES (?, ?, 'faq_bot', ?)`,
  ).run(`settings-${accountId}`, accountId, value);
  // Phase B B-2: AI 後段の retrieval は FTS (search_text) 経由 → 実書込と同様に search_text を埋める。
  raw.prepare(
    `INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, search_text)
     VALUES (?, ?, '営業時間は何時ですか', '[]', '平日は10時から19時までです', 1, ?)`,
  ).run(faqId, accountId, buildFaqSearchText('営業時間は何時ですか', []));
}

function rt(provider: LlmProvider): FaqAiRuntime {
  return { provider, retrievalFloor: 0.3, timeoutMs: 5000, neuronPerMTokIn: 4119, neuronPerMTokOut: 34868, dailyNeuronBudgetGlobal: 9000, dailyNeuronBudgetPerAccount: 9000 };
}

const OPTS = (text: string, accountId = 'acc-1', friendId = 'f1') => ({
  friend: { id: friendId, line_account_id: accountId },
  incomingText: text,
  lineAccountId: accountId,
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
  test('answerMode 欠落 + 根拠あり → 安全側 draft で保存し送信しない', async () => {
    seed(raw, { omitAnswerMode: true });
    const mock = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock));

    expect(res).toEqual({ replied: false, handoff: false });
    expect(mock.calls).toHaveLength(1);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(1);
    expect(countFaqOutgoing()).toBe(0);
    expect(countUnmatched()).toBe(0);
  });

  test('決定的 match + draft → FAQ 回答を草案保存し replyMessage は 0 回', async () => {
    seed(raw, { answerMode: 'draft', threshold: 0.6 });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'));

    expect(res).toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(1);
    expect(countFaqOutgoing()).toBe(0);
    expect(countUnmatched()).toBe(0);
    const draft = raw.prepare(
      `SELECT question, draft_answer, evidence_faq_ids, status FROM ai_faq_drafts LIMIT 1`,
    ).get() as { question: string; draft_answer: string; evidence_faq_ids: string; status: string };
    expect(draft).toEqual({
      question: '営業時間は何時ですか',
      draft_answer: '平日は10時から19時までです',
      evidence_faq_ids: '["fq1"]',
      status: 'pending',
    });
  });

  test('決定的 match + explicit auto → 従来どおり即返信し草案は作らない', async () => {
    seed(raw, { answerMode: 'auto', threshold: 0.6 });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'));

    expect(res).toEqual({ replied: true, handoff: false });
    expect(lineClient.replyMessage).toHaveBeenCalledTimes(1);
    expect(countDrafts()).toBe(0);
    expect(countFaqOutgoing()).toBe(1);
    expect(countUnmatched()).toBe(0);
  });

  test('draft 上限到達後の決定的 match は新しい草案を作らず未対応へ退避する', async () => {
    seed(raw, { answerMode: 'draft', threshold: 0.6, maxRepliesPerDay: 1 });

    await expect(tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか')))
      .resolves.toEqual({ replied: false, handoff: false });
    await expect(tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか')))
      .resolves.toEqual({ replied: false, handoff: false });

    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(1);
    expect(countFaqOutgoing()).toBe(0);
    expect(countUnmatched()).toBe(1);
    expect((raw.prepare(`SELECT hit_count FROM faqs WHERE id = 'fq1'`).get() as { hit_count: number }).hit_count).toBe(1);
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

  test('draft + answerable=false → 資料不足草案を残し未対応へ1件だけ登録・送信しない', async () => {
    seed(raw, { answerMode: 'draft' });
    const mock = new MockLlmProvider({
      text: 'この資料だけでは申し込み開始日を確認できません',
      answerable: false,
    });

    await expect(tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock)))
      .resolves.toEqual({ replied: false, handoff: false });
    await expect(tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock)))
      .resolves.toEqual({ replied: false, handoff: false });

    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(2);
    expect(countUnmatched()).toBe(1);
    const rows = raw.prepare(`SELECT draft_answer, answerable FROM ai_faq_drafts ORDER BY created_at`).all() as Array<{
      draft_answer: string;
      answerable: number;
    }>;
    expect(rows).toEqual([
      { draft_answer: 'この資料だけでは申し込み開始日を確認できません', answerable: 0 },
      { draft_answer: 'この資料だけでは申し込み開始日を確認できません', answerable: 0 },
    ]);
  });

  test('answerMode欠落の既定draft + answerable=false → handoffを送らず草案と未対応を残す', async () => {
    seed(raw, { omitAnswerMode: true, handoffMessage: '担当者に確認します' });
    const mock = new MockLlmProvider({
      text: 'この資料だけでは申し込み開始日を確認できません',
      answerable: false,
    });

    await expect(tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(mock)))
      .resolves.toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(1);
    expect(countUnmatched()).toBe(1);
  });

  test('壊れた構造化出力 → fail-closedで未対応1件・草案0件・送信0件', async () => {
    seed(raw, { omitAnswerMode: true, handoffMessage: '担当者に確認します' });
    const malformed: LlmProvider = {
      async generate() {
        return { text: '{not-json', usage: { inputTokens: 10, outputTokens: 5 } };
      },
      async embed() { return []; },
    };

    await expect(tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか'), rt(malformed)))
      .resolves.toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countDrafts()).toBe(0);
    expect(countUnmatched()).toBe(1);
  });

  test('ai runtime 無し → match=null は従来通り recordUnmatchedQuestion (Phase A 非回帰)', async () => {
    seed(raw, { answerMode: 'auto' });
    const res = await tryFaqReply(db, lineClient, OPTS('営業時間は何時ですか')); // ai 引数なし
    expect(res).toEqual({ replied: false, handoff: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(countUnmatched()).toBe(1);
  });

  test('auto と draft は同じ専用スロット付き prompt を通り、同じ名乗りを冒頭に付ける', async () => {
    const replyStyle = {
      instructions: 'です・ます調で、親しみやすく簡潔に。',
      greeting: '◯◎です。',
    };

    const run = async (answerMode: 'auto' | 'draft') => {
      const scenarioRaw = new Database(':memory:');
      replayAll(scenarioRaw);
      seed(scenarioRaw, { answerMode, replyStyle });
      const scenarioDb = d1(scenarioRaw);
      const scenarioClient = { replyMessage: vi.fn().mockResolvedValue({}) };
      const provider = new MockLlmProvider({ text: '平日は10時から19時までです' });

      await tryFaqReply(
        scenarioDb,
        scenarioClient,
        OPTS('営業時間は何時ですか'),
        rt(provider),
      );

      const sentMessages = scenarioClient.replyMessage.mock.calls[0]?.[1] as
        | Array<{ type: string; text: string }>
        | undefined;
      const draft = scenarioRaw.prepare(
        `SELECT draft_answer FROM ai_faq_drafts LIMIT 1`,
      ).get() as { draft_answer: string } | undefined;
      return {
        prompt: provider.calls[0],
        answer: answerMode === 'auto' ? sentMessages?.[0]?.text : draft?.draft_answer,
      };
    };

    const auto = await run('auto');
    const draft = await run('draft');

    expect(auto.prompt).toEqual(draft.prompt);
    expect(auto.prompt.system).toContain('返信スタイル専用スロット');
    expect(auto.prompt.system).toContain(JSON.stringify(replyStyle));
    expect(auto.prompt.system).toMatch(/事実|根拠/);
    expect(auto.prompt.user).not.toContain(replyStyle.instructions);
    expect(auto.prompt.user).not.toContain(replyStyle.greeting);
    expect(auto.answer).toBe('◯◎です。\n平日は10時から19時までです');
    expect(draft.answer).toBe('◯◎です。\n平日は10時から19時までです');
  });

  test('未設定時は auto / draft とも旧 prompt と生成文を1バイトも変えない', async () => {
    const expectedPrompt = buildRagPrompt(
      [{ question: '営業時間は何時ですか', answer: '平日は10時から19時までです' }],
      [],
      '営業時間は何時ですか',
    );

    for (const answerMode of ['auto', 'draft'] as const) {
      const scenarioRaw = new Database(':memory:');
      replayAll(scenarioRaw);
      seed(scenarioRaw, { answerMode });
      const provider = new MockLlmProvider({ text: '平日は10時から19時までです' });
      const scenarioClient = { replyMessage: vi.fn().mockResolvedValue({}) };

      await tryFaqReply(
        d1(scenarioRaw),
        scenarioClient,
        OPTS('営業時間は何時ですか'),
        rt(provider),
      );

      expect(provider.calls[0]).toEqual(expectedPrompt);
      if (answerMode === 'auto') {
        const messages = scenarioClient.replyMessage.mock.calls[0]?.[1] as Array<{ text: string }>;
        expect(messages[0]?.text).toBe('平日は10時から19時までです');
      } else {
        expect(scenarioRaw.prepare(
          `SELECT draft_answer FROM ai_faq_drafts LIMIT 1`,
        ).get()).toEqual({ draft_answer: '平日は10時から19時までです' });
      }
    }
  });

  test('アカウント A の返信スタイルを B の生成 prompt に混ぜない', async () => {
    seed(raw, {
      accountId: 'account-a',
      friendId: 'friend-a',
      faqId: 'faq-a',
      answerMode: 'auto',
      replyStyle: {
        instructions: 'アカウントAだけの口調。',
        greeting: '店舗Aです。',
      },
    });
    seed(raw, {
      accountId: 'account-b',
      friendId: 'friend-b',
      faqId: 'faq-b',
      answerMode: 'auto',
    });
    const providerA = new MockLlmProvider({ text: '平日は10時から19時までです' });
    const providerB = new MockLlmProvider({ text: '平日は10時から19時までです' });

    await tryFaqReply(
      db,
      lineClient,
      OPTS('営業時間は何時ですか', 'account-a', 'friend-a'),
      rt(providerA),
    );
    await tryFaqReply(
      db,
      lineClient,
      OPTS('営業時間は何時ですか', 'account-b', 'friend-b'),
      rt(providerB),
    );

    expect(providerA.calls[0]?.system).toContain('アカウントAだけの口調。');
    expect(providerB.calls[0]).toEqual(buildRagPrompt(
      [{ question: '営業時間は何時ですか', answer: '平日は10時から19時までです' }],
      [],
      '営業時間は何時ですか',
    ));
  });
});
