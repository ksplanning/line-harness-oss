import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { createFormalooForm } from './formaloo.js';
import {
  completeFormalooAiChatHistory,
  failFormalooAiChatHistory,
  listFormalooAiChatHistory,
  reserveFormalooAiChatHistory,
} from './formaloo-ai-chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN_REPLAY_ERROR = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN_REPLAY_ERROR.test(error instanceof Error ? error.message : String(error))) throw error;
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

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('migration 111 — Formaloo AI chat history', () => {
  test('is additive and stores the question, answer, form, provider slug, and credit state', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '111_formaloo_ai_chat_history.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS formaloo_ai_chat_history/i);
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
    const columns = raw.prepare('PRAGMA table_info(formaloo_ai_chat_history)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'tenant_scope', 'line_account_id', 'form_id', 'question', 'answer_json', 'answer_text',
      'analysis_slug', 'credits_consumed', 'credit_reserved', 'status', 'provider_status',
    ]));
  });
});

describe('Formaloo AI chat history DAO', () => {
  test('atomically reserves no more than the tenant daily limit', async () => {
    const form = await createFormalooForm(db, { title: 'アンケート', lineAccountId: 'line-a' });
    const base = {
      tenantScope: 'tenant-a',
      lineAccountId: 'line-a',
      formId: form.id,
      dailyLimit: 1,
      now: '2026-07-20T10:00:00.000+09:00',
    };

    const first = await reserveFormalooAiChatHistory(db, { ...base, question: '今週の傾向は？' });
    const blocked = await reserveFormalooAiChatHistory(db, { ...base, question: 'もう一度分析して' });
    const otherTenant = await reserveFormalooAiChatHistory(db, {
      ...base,
      tenantScope: 'tenant-b',
      question: '別テナントの質問',
    });

    expect(first).toMatchObject({ status: 'pending', creditsConsumed: false, creditReserved: true });
    expect(blocked).toBeNull();
    expect(otherTenant).not.toBeNull();
  });

  test('atomically allows only one pending analysis for the same tenant account and form', async () => {
    const formA = await createFormalooForm(db, { title: '同時送信ガード', lineAccountId: 'line-a' });
    const formB = await createFormalooForm(db, { title: '別フォーム', lineAccountId: 'line-a' });
    const base = {
      tenantScope: 'tenant-a', lineAccountId: 'line-a', formId: formA.id,
      dailyLimit: 5, now: '2026-07-20T10:30:00.000+09:00',
    };

    const [first, duplicate] = await Promise.all([
      reserveFormalooAiChatHistory(db, { ...base, question: '最初の質問' }),
      reserveFormalooAiChatHistory(db, { ...base, question: '同時の質問' }),
    ]);
    const otherForm = await reserveFormalooAiChatHistory(db, {
      ...base, formId: formB.id, question: '別フォームの質問',
    });

    expect([first, duplicate].filter(Boolean)).toHaveLength(1);
    expect(otherForm).not.toBeNull();
  });

  test('a pre-credit failure releases the reservation, while an issued analysis remains counted', async () => {
    const form = await createFormalooForm(db, { title: '利用枠テスト', lineAccountId: 'line-a' });
    const base = {
      tenantScope: 'tenant-a', lineAccountId: 'line-a', formId: form.id,
      dailyLimit: 1, now: '2026-07-20T11:00:00.000+09:00',
    };
    const failed = await reserveFormalooAiChatHistory(db, { ...base, question: '枠切れになる質問' });
    expect(failed).not.toBeNull();
    await failFormalooAiChatHistory(db, failed!.id, {
      errorCode: 'credits_exhausted', errorMessage: '利用枠がありません',
      creditsConsumed: false, providerStatus: '402', now: base.now,
    });
    const retry = await reserveFormalooAiChatHistory(db, { ...base, question: '補充後の質問' });
    expect(retry).not.toBeNull();
    await completeFormalooAiChatHistory(db, retry!.id, {
      analysisSlug: 'analysis_1', answer: { summary: '回答が増えています' },
      answerText: '回答が増えています', providerStatus: 'completed', now: base.now,
    });
    await expect(reserveFormalooAiChatHistory(db, { ...base, question: '上限後の質問' })).resolves.toBeNull();
  });

  test('lists only the selected account/form and restores the saved answer', async () => {
    const formA = await createFormalooForm(db, { title: 'A', lineAccountId: 'line-a' });
    const formB = await createFormalooForm(db, { title: 'B', lineAccountId: 'line-b' });
    const a = await reserveFormalooAiChatHistory(db, {
      tenantScope: 'tenant-a', lineAccountId: 'line-a', formId: formA.id,
      question: '満足度は？', dailyLimit: 5, now: '2026-07-20T12:00:00.000+09:00',
    });
    await completeFormalooAiChatHistory(db, a!.id, {
      analysisSlug: 'analysis_a', answer: { score: 4.2 }, answerText: '平均は4.2です',
      providerStatus: 'completed', now: '2026-07-20T12:00:01.000+09:00',
    });
    await reserveFormalooAiChatHistory(db, {
      tenantScope: 'tenant-a', lineAccountId: 'line-b', formId: formB.id,
      question: '別フォーム', dailyLimit: 5, now: '2026-07-20T12:00:02.000+09:00',
    });

    const rows = await listFormalooAiChatHistory(db, {
      tenantScope: 'tenant-a', lineAccountId: 'line-a', formId: formA.id, limit: 20,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question: '満足度は？', answer: { score: 4.2 }, answerText: '平均は4.2です',
      analysisSlug: 'analysis_a', creditsConsumed: true, status: 'completed',
    });
  });
});
