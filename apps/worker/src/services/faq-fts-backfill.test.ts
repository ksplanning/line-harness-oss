/**
 * T-B5-b/d (Phase B B-2) — backfillFaqsSearchText: migration 091 適用直後 (既存行 search_text='')
 * の全行に JS 計算値を埋め、AU トリガ経由で faqs_fts を構築する。件数一致 + rowid 正結合 + 再実行 idempotent。
 * D1 実行互換 (T-B5-e) は closer の live-check (dark-ship・送信ゼロ / spec §4-#8)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { backfillFaqsSearchText, retrieveFaqCandidates, buildFaqSearchText } from './faq-fts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function migrationFiles() {
  return readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort();
}
function applySplit(db: Database.Database, sql: string) {
  for (const s of sql.split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
    try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
  }
}
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of migrationFiles()) applySplit(db, readFileSync(join(DB_ROOT, 'migrations', f), 'utf8'));
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
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','t','s')`).run();
  // migration 091 適用直後を模す: 既存行 search_text='' (未索引相当)。
  raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, search_text) VALUES ('b1','acc-1','駐車場はありますか','["車で来店できますか"]','A',1,'')`).run();
  raw.prepare(`INSERT INTO faqs (id, line_account_id, question, variants, answer, is_active, search_text) VALUES ('b2','acc-1','営業時間を教えてください','[]','A',1,'')`).run();
});

function ftsCount() { return (raw.prepare(`SELECT count(*) c FROM faqs_fts`).get() as { c: number }).c; }
function searchTextOf(id: string) { return (raw.prepare(`SELECT search_text FROM faqs WHERE id=?`).get(id) as { search_text: string }).search_text; }

describe('backfillFaqsSearchText (T-B5-b/d)', () => {
  test('backfill 前は search_text="" で retrieve が当たらない', async () => {
    const cands = await retrieveFaqCandidates(db, '車を停める場所はありますか？', 'acc-1', 5);
    expect(cands).toEqual([]);
  });

  test('backfill で全行に正しい search_text を書き faqs_fts 件数一致 + rowid 正結合', async () => {
    const n = await backfillFaqsSearchText(db);
    expect(n).toBe(2);
    expect(ftsCount()).toBe(2); // count(faqs_fts) == count(faqs)
    // search_text が buildFaqSearchText の計算値と一致。
    expect(searchTextOf('b1')).toBe(buildFaqSearchText('駐車場はありますか', ['車で来店できますか']));
    // rowid JOIN で言い換えクエリが正しい faq を surface する。
    const cands = await retrieveFaqCandidates(db, '車を停める場所はありますか？', 'acc-1', 5);
    expect(cands.map((c) => c.id)).toContain('b1');
  });

  test('backfill 再実行は idempotent (件数・索引内容不変)', async () => {
    await backfillFaqsSearchText(db);
    const before = raw.prepare(`SELECT rowid, search_text FROM faqs_fts ORDER BY rowid`).all();
    const n2 = await backfillFaqsSearchText(db);
    expect(n2).toBe(2);
    const after = raw.prepare(`SELECT rowid, search_text FROM faqs_fts ORDER BY rowid`).all();
    expect(after).toEqual(before);
    expect(ftsCount()).toBe(2);
  });

  test('migration 091 の再適用は idempotent (IF NOT EXISTS で仮想表/トリガ重複なし)', () => {
    const sql091 = readFileSync(join(DB_ROOT, 'migrations', '091_phase_b_faq_fts.sql'), 'utf8');
    expect(() => applySplit(raw, sql091)).not.toThrow(); // ADD COLUMN は benign duplicate、他は IF NOT EXISTS
    const vt = (raw.prepare(`SELECT count(*) c FROM sqlite_master WHERE name='faqs_fts'`).get() as { c: number }).c;
    expect(vt).toBe(1);
    const trig = (raw.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='trigger' AND name LIKE 'faqs_fts_%'`).get() as { c: number }).c;
    expect(trig).toBe(3);
  });
});
