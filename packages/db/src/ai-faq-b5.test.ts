/**
 * B-5 (T-E4) — AI ログ/コスト可視化の read helper (listAiUsageForAccount / listAiUsageGlobal / listAiFaqDrafts)。
 *  - listAiUsageForAccount(db, accountId, days): ai_usage_budget を当該 account の usage_date DESC で日次一覧。
 *  - listAiUsageGlobal(db, days): GROUP BY usage_date + SUM (line_account_id は NOT NULL=global 専用行なし /
 *    accountId=null で global 行を引く設計は誤り / Codex B-5)。
 *  - listAiFaqDrafts(db, accountId, status?): ai_faq_drafts を created_at DESC で account スコープ (draft のみ)。
 * migration ゼロ (既存 089/090 表 read のみ)。他 account を混ぜない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  recordAiUsage,
  insertAiFaqDraft,
  listAiUsageForAccount,
  listAiUsageGlobal,
  listAiFaqDrafts,
} from './ai-faq.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean);
}
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of splitStatements(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))) {
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

let raw: Database.Database;
let DB: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('listAiUsageForAccount — 日次 neuron 一覧 (T-E4)', () => {
  test('当該 account の usage_date DESC で日次行を返す (他 account を混ぜない)', async () => {
    await recordAiUsage(DB, { lineAccountId: 'acc-1', usageDate: '2026-07-10', llmNeurons: 100, embedNeurons: 20 });
    await recordAiUsage(DB, { lineAccountId: 'acc-1', usageDate: '2026-07-11', llmNeurons: 300, replyCount: 5 });
    await recordAiUsage(DB, { lineAccountId: 'acc-2', usageDate: '2026-07-11', llmNeurons: 999 });
    const rows = await listAiUsageForAccount(DB, 'acc-1', 30);
    expect(rows.length).toBe(2);
    expect(rows[0].usage_date).toBe('2026-07-11'); // DESC
    expect(rows[0].llm_neurons).toBe(300);
    expect(rows[0].reply_count).toBe(5);
    expect(rows[1].usage_date).toBe('2026-07-10');
    // acc-2 の行は含まれない。
    expect(rows.some((r) => r.llm_neurons === 999)).toBe(false);
  });
  test('days で行数を上限 clamp する', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await recordAiUsage(DB, { lineAccountId: 'acc-1', usageDate: `2026-07-${String(i).padStart(2, '0')}`, llmNeurons: i });
    }
    const rows = await listAiUsageForAccount(DB, 'acc-1', 3);
    expect(rows.length).toBe(3);
    expect(rows[0].usage_date).toBe('2026-07-10'); // 最新 3 日
  });
});

describe('listAiUsageGlobal — 全 account 合算 SUM (line_account_id NOT NULL / T-E4)', () => {
  test('usage_date で GROUP BY + SUM (global 専用行は存在しない)', async () => {
    await recordAiUsage(DB, { lineAccountId: 'acc-1', usageDate: '2026-07-11', llmNeurons: 100, embedNeurons: 10, replyCount: 2 });
    await recordAiUsage(DB, { lineAccountId: 'acc-2', usageDate: '2026-07-11', llmNeurons: 200, embedNeurons: 5, replyCount: 3 });
    await recordAiUsage(DB, { lineAccountId: 'acc-1', usageDate: '2026-07-10', llmNeurons: 50 });
    const rows = await listAiUsageGlobal(DB, 30);
    expect(rows.length).toBe(2);
    const jul11 = rows.find((r) => r.usage_date === '2026-07-11')!;
    expect(jul11.llm_neurons).toBe(300); // 100+200 合算
    expect(jul11.embed_neurons).toBe(15);
    expect(jul11.reply_count).toBe(5);
    const jul10 = rows.find((r) => r.usage_date === '2026-07-10')!;
    expect(jul10.llm_neurons).toBe(50);
  });
});

describe('listAiFaqDrafts — AI 草案ログ (account スコープ / T-E4)', () => {
  test('account スコープ (global + 指定) で created_at DESC 一覧・他 account を混ぜない', async () => {
    await insertAiFaqDraft(DB, { lineAccountId: 'acc-1', friendId: 'fr-1', question: 'Q1', draftAnswer: 'A1' });
    await insertAiFaqDraft(DB, { lineAccountId: null, friendId: 'fr-2', question: 'Qg', draftAnswer: 'Ag' });
    await insertAiFaqDraft(DB, { lineAccountId: 'acc-2', friendId: 'fr-3', question: 'Qx', draftAnswer: 'Ax' });
    const rows = await listAiFaqDrafts(DB, 'acc-1');
    const questions = rows.map((r) => r.question).sort();
    expect(questions).toEqual(['Q1', 'Qg']); // acc-1 + global (acc-2 は含まない)
  });
  test('status で絞れる', async () => {
    const id1 = await insertAiFaqDraft(DB, { lineAccountId: 'acc-1', friendId: null, question: 'pending Q', draftAnswer: 'A' });
    await insertAiFaqDraft(DB, { lineAccountId: 'acc-1', friendId: null, question: 'other Q', draftAnswer: 'A' });
    raw.prepare(`UPDATE ai_faq_drafts SET status = 'approved' WHERE id = ?`).run(id1);
    const pending = await listAiFaqDrafts(DB, 'acc-1', 'pending');
    expect(pending.map((r) => r.question)).toEqual(['other Q']);
    const approved = await listAiFaqDrafts(DB, 'acc-1', 'approved');
    expect(approved.map((r) => r.question)).toEqual(['pending Q']);
  });
});
