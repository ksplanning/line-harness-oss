/**
 * T-A6 (Phase B B-1) — ai_usage_budget helper の積算/合算/判定と ai_faq_drafts 保存を実 SQLite で検証。
 *   recordAiUsage      : UTC 日 bucket に UPSERT で neuron/reply を積算 (2 回目は加算)。
 *   getAiUsageToday    : account/日 の合計 neuron (llm+embed+image)。
 *   getAiUsageGlobalToday : 全 account 合算 (Cloudflare 共有無料枠の主判定)。
 *   isOverAiBudget     : (a)全合算 vs global 上限 と (b)account vs per-account 上限 の OR。
 *   insertAiFaqDraft   : status='pending' で草案保存 (送信しない)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  recordAiUsage,
  getAiUsageToday,
  getAiUsageGlobalToday,
  isOverAiBudget,
  insertAiFaqDraft,
  utcDay,
} from './ai-faq.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
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

let raw: Database.Database;
let db: D1Database;
const DAY = '2026-07-10';
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('utcDay', () => {
  test('UTC の YYYY-MM-DD を返す', () => {
    expect(utcDay(new Date('2026-07-10T23:59:59.000Z'))).toBe('2026-07-10');
    expect(utcDay(new Date('2026-07-11T00:00:01.000Z'))).toBe('2026-07-11');
  });
});

describe('recordAiUsage (UPSERT 積算)', () => {
  test('初回は insert / 2 回目は同 account・同日で加算 (UNIQUE 衝突しない)', async () => {
    await recordAiUsage(db, { lineAccountId: 'acc-1', usageDate: DAY, llmNeurons: 100, replyCount: 1 });
    await recordAiUsage(db, { lineAccountId: 'acc-1', usageDate: DAY, llmNeurons: 40, replyCount: 1 });
    const row = raw.prepare(`SELECT llm_neurons, reply_count FROM ai_usage_budget WHERE line_account_id='acc-1' AND usage_date=?`).get(DAY) as { llm_neurons: number; reply_count: number };
    expect(row.llm_neurons).toBe(140);
    expect(row.reply_count).toBe(2);
    // 1 account/日 1 行
    expect((raw.prepare(`SELECT COUNT(*) c FROM ai_usage_budget`).get() as { c: number }).c).toBe(1);
  });
});

describe('getAiUsageToday / getAiUsageGlobalToday', () => {
  test('account 別合計と全 account 合算', async () => {
    await recordAiUsage(db, { lineAccountId: 'acc-1', usageDate: DAY, llmNeurons: 100, embedNeurons: 10 });
    await recordAiUsage(db, { lineAccountId: 'acc-2', usageDate: DAY, llmNeurons: 200, imageNeurons: 5 });
    expect(await getAiUsageToday(db, 'acc-1', DAY)).toBe(110);
    expect(await getAiUsageToday(db, 'acc-2', DAY)).toBe(205);
    expect(await getAiUsageGlobalToday(db, DAY)).toBe(315);
    // 別日は 0
    expect(await getAiUsageToday(db, 'acc-1', '2026-07-11')).toBe(0);
    expect(await getAiUsageGlobalToday(db, '2026-07-11')).toBe(0);
  });
});

describe('isOverAiBudget (global + account OR)', () => {
  test('両方未満 → false', async () => {
    await recordAiUsage(db, { lineAccountId: 'acc-1', usageDate: DAY, llmNeurons: 100 });
    expect(await isOverAiBudget(db, { lineAccountId: 'acc-1', usageDate: DAY, globalBudget: 1000, perAccountBudget: 500 })).toBe(false);
  });

  test('全 account 合算がグローバル上限に到達 → true (別 account 消費でも退避)', async () => {
    await recordAiUsage(db, { lineAccountId: 'acc-2', usageDate: DAY, llmNeurons: 1000 });
    // acc-1 自身は 0 でも共有枠が尽きていれば退避
    expect(await isOverAiBudget(db, { lineAccountId: 'acc-1', usageDate: DAY, globalBudget: 1000, perAccountBudget: 500 })).toBe(true);
  });

  test('当該 account が per-account 上限に到達 → true (グローバルは余裕あり)', async () => {
    await recordAiUsage(db, { lineAccountId: 'acc-1', usageDate: DAY, llmNeurons: 500 });
    expect(await isOverAiBudget(db, { lineAccountId: 'acc-1', usageDate: DAY, globalBudget: 100000, perAccountBudget: 500 })).toBe(true);
  });
});

describe('insertAiFaqDraft', () => {
  test('status=pending で草案保存し evidence を JSON 化', async () => {
    const id = await insertAiFaqDraft(db, {
      lineAccountId: 'acc-1',
      friendId: 'f1',
      question: '営業時間は？',
      draftAnswer: '10-19時です',
      evidenceFaqIds: ['fq-1', 'fq-2'],
    });
    const row = raw.prepare(`SELECT * FROM ai_faq_drafts WHERE id=?`).get(id) as Record<string, string>;
    expect(row.status).toBe('pending');
    expect(row.draft_answer).toBe('10-19時です');
    expect(JSON.parse(row.evidence_faq_ids)).toEqual(['fq-1', 'fq-2']);
    expect(row.answerable).toBe(1);
  });

  test('answerable=false を資料不足ラベル用に保存する', async () => {
    const id = await insertAiFaqDraft(db, {
      lineAccountId: 'acc-1',
      friendId: 'f1',
      question: '申し込みはいつから？',
      draftAnswer: 'この資料だけでは確認できません',
      answerable: false,
    });
    const row = raw.prepare(`SELECT answerable FROM ai_faq_drafts WHERE id=?`).get(id) as { answerable: number };
    expect(row.answerable).toBe(0);
  });
});
