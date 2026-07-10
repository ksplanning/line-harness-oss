/**
 * T-B1 (Phase B B-2) — migration 091 が faqs に FTS5 全文検索を additive で足す検証。
 *   faqs.search_text : アプリ層 (worker faq-fts.ts) が計算する 2-gram 空白連結列 (NOT NULL DEFAULT '')。
 *   faqs_fts         : standalone FTS5 仮想表 (unicode61)。
 *   同期トリガ 3 本   : NEW.search_text をコピーするだけ (SQL 内で normalize/ngrams を再現しない)。
 * additive のみ (ADD COLUMN with DEFAULT / CREATE VIRTUAL TABLE IF NOT EXISTS / CREATE TRIGGER IF NOT EXISTS)。
 * DROP/RENAME/_new を含まない。既存 faqs 行の question/variants/answer/is_active は不変。
 * backfill は migration の責務でない (C4/worker) → 適用直後 faqs_fts は空 (既存行は未索引)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIG_DIR = join(PKG_ROOT, 'migrations');
const MIG_091 = join(MIG_DIR, '091_phase_b_faq_fts.sql');
const BENIGN = /duplicate column name|already exists/i;

// migration ファイルを実 splitter (全 replay テスト共通の /;\s*(?:\r?\n|$)/) で分割して適用。
// トリガの BEGIN...END が壊れないこと自体が「1 行トリガ」の回帰ガード。
function applySplit(db: Database.Database, sql: string) {
  for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
  }
}

// post-089 の faqs (search_text 無し) を手組みし、既存行を入れてから 091 を適用する
// = 「faqs 既存行入り db に 091 を適用して無改変」を直接証明する (isolated migration test)。
const FAQS_PRE_091 = `CREATE TABLE faqs (
  id TEXT PRIMARY KEY, line_account_id TEXT, question TEXT NOT NULL,
  variants TEXT NOT NULL DEFAULT '[]', answer TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
  hit_count INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT,
  answer_type TEXT DEFAULT 'text', source_doc_id TEXT
);`;

let raw: Database.Database;
beforeEach(() => {
  raw = new Database(':memory:');
});

describe('migration 091 — faqs FTS5 索引 (additive / T-B1)', () => {
  test('既存 faqs 行入り db に 091 を適用しても行は無改変・search_text は additive で ""', () => {
    raw.exec(FAQS_PRE_091);
    raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, hit_count) VALUES ('e1','acc-1','営業時間は？','["何時まで"]','10-19時',1,3)`).run();
    applySplit(raw, readFileSync(MIG_091, 'utf8'));
    const row = raw.prepare(`SELECT * FROM faqs WHERE id='e1'`).get() as Record<string, unknown>;
    expect(row.question).toBe('営業時間は？');
    expect(row.variants).toBe('["何時まで"]');
    expect(row.answer).toBe('10-19時');
    expect(row.is_active).toBe(1);
    expect(row.hit_count).toBe(3);
    expect(row.search_text).toBe(''); // additive DEFAULT
    // backfill は migration の責務でない → 既存行は未索引 (faqs_fts は空)。
    expect((raw.prepare(`SELECT count(*) c FROM faqs_fts`).get() as { c: number }).c).toBe(0);
  });

  test('faqs_fts 仮想表 + 同期トリガ3本 (ai/ad/au) が存在', () => {
    raw.exec(FAQS_PRE_091);
    applySplit(raw, readFileSync(MIG_091, 'utf8'));
    const vt = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='faqs_fts'`).get() as { sql: string } | undefined;
    expect(vt?.sql).toMatch(/CREATE VIRTUAL TABLE .*faqs_fts .*fts5/i);
    const trig = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'faqs_fts_%'`).all() as { name: string }[]).map((t) => t.name).sort();
    expect(trig).toEqual(['faqs_fts_ad', 'faqs_fts_ai', 'faqs_fts_au']);
  });

  test('AI トリガ: 091 適用後の新規 insert が faqs_fts に rowid 同期', () => {
    raw.exec(FAQS_PRE_091);
    applySplit(raw, readFileSync(MIG_091, 'utf8'));
    raw.prepare(`INSERT INTO faqs (id, question, answer, search_text) VALUES ('n1','Q','A','駐車 車場')`).run();
    const fts = raw.prepare(`SELECT f.id FROM faqs_fts x JOIN faqs f ON f.rowid=x.rowid WHERE x.search_text='駐車 車場'`).get() as { id: string } | undefined;
    expect(fts?.id).toBe('n1');
  });

  test('AU/AD トリガ: UPDATE で search_text 反映 (freshness) / DELETE で除去', () => {
    raw.exec(FAQS_PRE_091);
    applySplit(raw, readFileSync(MIG_091, 'utf8'));
    raw.prepare(`INSERT INTO faqs (id, question, answer, search_text) VALUES ('u1','Q','A','古い ngram')`).run();
    raw.prepare(`UPDATE faqs SET search_text='新しい ngram' WHERE id='u1'`).run();
    expect((raw.prepare(`SELECT search_text FROM faqs_fts`).get() as { search_text: string }).search_text).toBe('新しい ngram');
    raw.prepare(`DELETE FROM faqs WHERE id='u1'`).run();
    expect((raw.prepare(`SELECT count(*) c FROM faqs_fts`).get() as { c: number }).c).toBe(0);
  });

  test('トリガ本文は NEW.search_text コピーのみ (SQL に normalize/ngrams 再現なし)', () => {
    // 実行 SQL (-- コメント除去後) にアプリ層 pre-tokenize の再実装が無いこと。
    const exec = readFileSync(MIG_091, 'utf8').split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    expect(exec).not.toMatch(/NFKC|charCodeAt|substr\(|ngram/i);
    expect(exec).toMatch(/NEW\.search_text/);
  });

  test('additive-only: DROP/RENAME/_new を含まず check-migrations pass', () => {
    const sql = readFileSync(MIG_091, 'utf8');
    expect(sql).toMatch(/ALTER TABLE faqs ADD COLUMN search_text TEXT NOT NULL DEFAULT ''/i);
    expect(sql).toMatch(/CREATE VIRTUAL TABLE IF NOT EXISTS faqs_fts/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/_new\b/i);
    expect(checkMigration(sql, MIG_091)).toEqual({ ok: true });
  });

  test('番号 091 は台帳の 090 の直後 (additive・連番・後続 092+ を許容)', () => {
    const nums = readdirSync(MIG_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3)).sort();
    expect(nums).toContain('091');
    // 091 は 090 の直後 (連番・番号 skip なし)。最高である必要はない (B-3 で 092 が additive 追加・092 側の test が最高を保証)。
    expect(nums[nums.indexOf('091') - 1]).toBe('090');
  });
});
