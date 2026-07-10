/**
 * T-B5-a/c (Phase B B-2) — createFaq/updateFaq が additive `searchText` を search_text 列へ保存し、
 * 091 の同期トリガ経由で faqs_fts に反映されることを実 FTS5 (better-sqlite3) で検証。
 * db 層は保存のみ (計算しない = 依存方向: packages/db は apps/worker を import しない)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { createFaq, updateFaq, incrementFaqHitCount } from './faqs.js';

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
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

function ftsCount() { return (raw.prepare(`SELECT count(*) c FROM faqs_fts`).get() as { c: number }).c; }
function ftsSearchText(id: string) {
  return (raw.prepare(`SELECT x.search_text st FROM faqs_fts x JOIN faqs f ON f.rowid=x.rowid WHERE f.id=?`).get(id) as { st: string } | undefined)?.st;
}

describe('createFaq/updateFaq — additive searchText 保存 + FTS 反映 (T-B5-a/c)', () => {
  test('createFaq(searchText) が search_text 列に保存され AI トリガで faqs_fts へ反映', async () => {
    const faq = await createFaq(db, { question: 'Q', answer: 'A', searchText: '駐車 車場 場は' });
    const row = raw.prepare(`SELECT search_text FROM faqs WHERE id=?`).get(faq.id) as { search_text: string };
    expect(row.search_text).toBe('駐車 車場 場は');
    expect(ftsSearchText(faq.id)).toBe('駐車 車場 場は');
  });

  test('createFaq(searchText 省略) は search_text="" (additive default・実呼出は必ず渡す)', async () => {
    const faq = await createFaq(db, { question: 'Q', answer: 'A' });
    expect((raw.prepare(`SELECT search_text FROM faqs WHERE id=?`).get(faq.id) as { search_text: string }).search_text).toBe('');
  });

  test('updateFaq(searchText) が AU トリガで faqs_fts を新値に更新 (freshness)', async () => {
    const faq = await createFaq(db, { question: 'Q', answer: 'A', searchText: '古い ぐらむ' });
    await updateFaq(db, faq.id, { question: 'Q2', searchText: '新しい ぐらむ' });
    expect(ftsSearchText(faq.id)).toBe('新しい ぐらむ');
  });

  test('updateFaq(searchText 省略) は既存 search_text を保持 (answer だけ変更時)', async () => {
    const faq = await createFaq(db, { question: 'Q', answer: 'A', searchText: 'そのまま ngram' });
    await updateFaq(db, faq.id, { answer: 'A2' });
    expect(ftsSearchText(faq.id)).toBe('そのまま ngram');
    expect((raw.prepare(`SELECT answer FROM faqs WHERE id=?`).get(faq.id) as { answer: string }).answer).toBe('A2');
  });

  test('incrementFaqHitCount は search_text を変えない (対象外)', async () => {
    const faq = await createFaq(db, { question: 'Q', answer: 'A', searchText: '不変 ngram' });
    await incrementFaqHitCount(db, faq.id);
    expect(ftsSearchText(faq.id)).toBe('不変 ngram');
    expect((raw.prepare(`SELECT hit_count FROM faqs WHERE id=?`).get(faq.id) as { hit_count: number }).hit_count).toBe(1);
  });

  test('deleteFaq 経由の DELETE トリガで faqs_fts から除去', async () => {
    const faq = await createFaq(db, { question: 'Q', answer: 'A', searchText: 'x y' });
    expect(ftsCount()).toBe(1);
    raw.prepare(`DELETE FROM faqs WHERE id=?`).run(faq.id);
    expect(ftsCount()).toBe(0);
  });
});
