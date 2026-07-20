import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { buildRagPrompt, runFaqAiAnswer } from './faq-ai.js';
import { MockLlmProvider } from './llm/mock-provider.js';
import type { FaqAiRuntime } from './llm/runtime.js';
import type { FaqMatchDetail, MatchableFaq } from './faq-match.js';
import type { AssembledFaqPersonalContext } from './faq-personal-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(statement); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const FAQ = {
  id: 'faq-payment',
  line_account_id: 'account-a',
  question: '入金確認について',
  variants: [],
  answer: '登録されている入金状態をご案内します。',
  is_active: 1,
  hit_count: 0,
  created_at: '',
  updated_at: '',
} as MatchableFaq;

const NO_GENERAL_EVIDENCE: FaqMatchDetail = { match: null, best: null, topScore: null };
const FAQ_EVIDENCE: FaqMatchDetail = {
  match: null,
  best: { faq: FAQ, score: 0.8 },
  topScore: 0.8,
};

function runtime(provider: MockLlmProvider): FaqAiRuntime {
  return {
    provider,
    retrievalFloor: 0.3,
    timeoutMs: 5_000,
    neuronPerMTokIn: 4_119,
    neuronPerMTokOut: 34_868,
    dailyNeuronBudgetGlobal: 9_000,
    dailyNeuronBudgetPerAccount: 9_000,
  };
}

let raw: Database.Database;
let db: D1Database;

function seed(personalEnabled = true) {
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-a', 'channel-a', 'A', 'synthetic-token', 'synthetic-secret')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id, display_name, metadata)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
  ).run(
    'friend-a', 'synthetic-user-a', 'account-a', '利用者A', JSON.stringify({ 入金状態: '確認済み-A' }),
    'friend-b', 'synthetic-user-b', 'account-a', '利用者B', JSON.stringify({ 入金状態: '未確認-B-MARKER' }),
  );
  raw.prepare(
    `INSERT INTO friend_field_definitions
       (id, name, default_value, display_order, is_active)
     VALUES ('field-payment', '入金状態', '未確認', 1, 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value)
     VALUES ('setting-a', 'account-a', 'faq_bot', ?)`,
  ).run(JSON.stringify({
    personalContext: {
      enabled: personalEnabled,
      selectedCustomFieldIds: ['field-payment'],
      includeFormAnswers: false,
      maxTokens: 1_200,
    },
  }));
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('buildRagPrompt — personal context data boundary', () => {
  test('optional本人contextだけを独立nonce fenceで足し、未指定時は旧promptとbyte同一', () => {
    const personal: AssembledFaqPersonalContext = {
      text: '質問者本人の登録情報:\n入金状態: 確認済み-A',
      tokenEstimate: 64,
      audit: {
        displayNameIncluded: false,
        customFieldIds: ['field-payment'],
        formalooSubmissionCount: 0,
        internalSubmissionCount: 0,
        wasTruncated: false,
      },
    };
    const legacy = buildRagPrompt([{ question: FAQ.question, answer: FAQ.answer }], [], '入金確認は？');
    const disabled = buildRagPrompt([{ question: FAQ.question, answer: FAQ.answer }], [], '入金確認は？', null);
    const enabled = buildRagPrompt([{ question: FAQ.question, answer: FAQ.answer }], [], '入金確認は？', personal);

    expect(disabled).toEqual(legacy);
    expect(enabled.user).toContain('[[PERSONAL_CONTEXT:');
    expect(enabled.user).toContain('入金状態: 確認済み-A');
    expect(enabled.system).toContain('質問者本人への回答にだけ');
    expect(legacy.user).not.toContain('PERSONAL_CONTEXT');
  });
});

describe('runFaqAiAnswer — exact-friend personal context', () => {
  test('一般FAQ根拠なしでも本人値で「入金確認」草案を作り、別人値を混ぜない', async () => {
    seed(true);
    const provider = new MockLlmProvider({ text: '入金は確認済み-Aです。' });

    const outcome = await runFaqAiAnswer(db, NO_GENERAL_EVIDENCE, {
      question: '入金確認どうなってますか',
      answerMode: 'draft',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      overLimit: false,
    }, runtime(provider));

    expect(outcome).toEqual({ kind: 'draft_saved' });
    expect(provider.calls).toHaveLength(1);
    const prompt = `${provider.calls[0].system}\n${provider.calls[0].user}`;
    expect(prompt).toContain('入金状態: 確認済み-A');
    expect(prompt).not.toContain('未確認-B-MARKER');
    expect(prompt).not.toContain('friend-a');
    expect(prompt).not.toContain('friend-b');

    const draft = raw.prepare(
      `SELECT draft_answer FROM ai_faq_drafts WHERE friend_id = 'friend-a'`,
    ).get();
    expect(draft).toEqual({ draft_answer: '入金は確認済み-Aです。' });
    const audit = raw.prepare(
      `SELECT custom_field_ids_json, formaloo_submission_count,
              internal_submission_count, prompt_token_estimate
         FROM faq_personal_context_audit_log`,
    ).get() as Record<string, unknown>;
    expect(audit).toMatchObject({
      custom_field_ids_json: '["field-payment"]',
      formaloo_submission_count: 0,
      internal_submission_count: 0,
    });
    expect(audit.prompt_token_estimate).toEqual(expect.any(Number));
    expect(JSON.stringify(audit)).not.toContain('確認済み-A');
  });

  test('設定OFF時は旧promptとbyte同一で、監査行も作らない', async () => {
    seed(false);
    const provider = new MockLlmProvider({ text: FAQ.answer });
    const expected = buildRagPrompt(
      [{ question: FAQ.question, answer: FAQ.answer }],
      [],
      '入金確認は？',
    );

    const outcome = await runFaqAiAnswer(db, FAQ_EVIDENCE, {
      question: '入金確認は？',
      answerMode: 'auto',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      overLimit: false,
    }, runtime(provider));

    expect(outcome).toEqual({ kind: 'auto_send', answer: FAQ.answer });
    expect(provider.calls[0]).toEqual(expected);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM faq_personal_context_audit_log').get())
      .toEqual({ count: 0 });
  });

  test('監査保存に失敗したら本人値をproviderへ渡さず従来の退避動作', async () => {
    seed(true);
    raw.exec('DROP TABLE faq_personal_context_audit_log');
    const provider = new MockLlmProvider({ text: '入金は確認済み-Aです。' });

    const outcome = await runFaqAiAnswer(db, NO_GENERAL_EVIDENCE, {
      question: '入金確認どうなってますか',
      answerMode: 'draft',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      overLimit: false,
    }, runtime(provider));

    expect(outcome).toEqual({ kind: 'escalate', reason: 'below_retrieval_floor' });
    expect(provider.calls).toHaveLength(0);
  });

  test('表示名しかなく生成しない場合は「注入した」という監査行を作らない', async () => {
    seed(true);
    raw.exec('DELETE FROM friend_field_definitions');
    raw.prepare("UPDATE friends SET metadata = '{}' WHERE id = 'friend-a'").run();
    const provider = new MockLlmProvider({ text: '答え' });

    const outcome = await runFaqAiAnswer(db, NO_GENERAL_EVIDENCE, {
      question: '登録にない質問',
      answerMode: 'draft',
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      overLimit: false,
    }, runtime(provider));

    expect(outcome).toEqual({ kind: 'escalate', reason: 'below_retrieval_floor' });
    expect(provider.calls).toHaveLength(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM faq_personal_context_audit_log').get())
      .toEqual({ count: 0 });
  });
});
