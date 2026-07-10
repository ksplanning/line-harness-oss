/**
 * T-C3 (Phase B B-3) — migration 092 が取込ナレッジの基盤を additive で足す検証。
 *   knowledge_documents   : 取込単位 (source_type 'url'|'text')。
 *   knowledge_chunks      : 分割チャンク (source_doc_id TEXT NOT NULL REFERENCES knowledge_documents(id)・
 *                           UNIQUE(source_doc_id, chunk_index)・search_text は worker 層が計算する索引列)。
 *   knowledge_chunks_fts  : standalone FTS5 仮想表 (unicode61) — faqs_fts (091) と別表・二重実装なし。
 *   同期トリガ 3 本        : NEW.search_text をコピーするだけ (SQL 内で normalize/ngrams を再現しない)。
 * additive のみ (CREATE TABLE/INDEX/VIRTUAL TABLE/TRIGGER IF NOT EXISTS)。DROP/RENAME/_new を含まない。
 * 既存 faqs / faqs_fts は無改変 (二重実装なし)。timestamp は JST strftime (列正典 drift 回避 / M-1)。
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
const MIG_092 = join(MIG_DIR, '092_phase_b_knowledge_chunks.sql');
const BENIGN = /duplicate column name|already exists/i;

// migration ファイルを実 splitter (全 replay テスト共通の /;\s*(?:\r?\n|$)/) で分割して適用。
// トリガの BEGIN...END が壊れないこと自体が「1 行トリガ」の回帰ガード。
function applySplit(db: Database.Database, sql: string) {
  for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
  }
}

// schema.sql + 全 migration を順に適用 (二重実装なし = faqs_fts 無改変を replayAll で直接証明)。
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    applySplit(db, readFileSync(join(MIG_DIR, f), 'utf8'));
  }
}

let raw: Database.Database;
beforeEach(() => {
  raw = new Database(':memory:');
});

describe('migration 092 — knowledge_documents/chunks + FTS5 (additive / T-C3)', () => {
  test('knowledge_documents / knowledge_chunks / knowledge_chunks_fts + トリガ3本が存在', () => {
    applySplit(raw, readFileSync(MIG_092, 'utf8'));
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge%'`).all() as { name: string }[]).map((t) => t.name).sort();
    expect(tables).toContain('knowledge_documents');
    expect(tables).toContain('knowledge_chunks');
    expect(tables).toContain('knowledge_chunks_fts');
    const vt = raw.prepare(`SELECT sql FROM sqlite_master WHERE name='knowledge_chunks_fts'`).get() as { sql: string };
    expect(vt.sql).toMatch(/CREATE VIRTUAL TABLE .*knowledge_chunks_fts .*fts5/i);
    const trig = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'knowledge_chunks_fts_%'`).all() as { name: string }[]).map((t) => t.name).sort();
    expect(trig).toEqual(['knowledge_chunks_fts_ad', 'knowledge_chunks_fts_ai', 'knowledge_chunks_fts_au']);
  });

  test('knowledge_chunks に source_doc_id REFERENCES + UNIQUE(source_doc_id, chunk_index) + JST timestamp', () => {
    const sql = readFileSync(MIG_092, 'utf8');
    expect(sql).toMatch(/source_doc_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+knowledge_documents\(id\)/i);
    expect(sql).toMatch(/UNIQUE\s*\(\s*source_doc_id\s*,\s*chunk_index\s*\)/i);
    // 実行 SQL (-- コメント除去後) が JST strftime を使い UTC datetime('now') を使わない / M-1。
    const exec = sql.split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    expect(exec).toMatch(/strftime\('%Y-%m-%dT%H:%M:%f','now','\+9 hours'\)/);
    expect(exec).not.toMatch(/datetime\('now'\)/i);
  });

  test('UNIQUE(source_doc_id, chunk_index) が重複 chunk_index を弾く', () => {
    applySplit(raw, readFileSync(MIG_092, 'utf8'));
    raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES ('d1','text')`).run();
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content) VALUES ('c1','d1',0,'a')`).run();
    expect(() =>
      raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content) VALUES ('c2','d1',0,'b')`).run(),
    ).toThrow(/UNIQUE/i);
  });

  test('AI トリガ: chunk insert が knowledge_chunks_fts に rowid 同期 / AU=freshness / AD=除去', () => {
    applySplit(raw, readFileSync(MIG_092, 'utf8'));
    raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES ('d1','text')`).run();
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content, search_text) VALUES ('c1','d1',0,'本文','ほん んぶ ぶん')`).run();
    const hit = raw.prepare(`SELECT c.id FROM knowledge_chunks_fts x JOIN knowledge_chunks c ON c.rowid=x.rowid WHERE x.search_text='ほん んぶ ぶん'`).get() as { id: string } | undefined;
    expect(hit?.id).toBe('c1');
    raw.prepare(`UPDATE knowledge_chunks SET search_text='あたら らし しい' WHERE id='c1'`).run();
    expect((raw.prepare(`SELECT search_text FROM knowledge_chunks_fts`).get() as { search_text: string }).search_text).toBe('あたら らし しい');
    raw.prepare(`DELETE FROM knowledge_chunks WHERE id='c1'`).run();
    expect((raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c).toBe(0);
  });

  test('トリガ本文は NEW.search_text コピーのみ (SQL に normalize/ngrams 再現なし)', () => {
    const exec = readFileSync(MIG_092, 'utf8').split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    expect(exec).not.toMatch(/NFKC|charCodeAt|substr\(|ngram/i);
    expect(exec).toMatch(/NEW\.search_text/);
  });

  test('additive-only: DROP/RENAME/_new を含まず check-migrations pass', () => {
    const sql = readFileSync(MIG_092, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS knowledge_documents/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS knowledge_chunks/i);
    expect(sql).toMatch(/CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/_new\b/i);
    expect(checkMigration(sql, MIG_092)).toEqual({ ok: true });
  });

  test('番号 092 は台帳最大 091 超の最小未使用 (最高番号ファイル)', () => {
    const nums = readdirSync(MIG_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).map((f) => f.slice(0, 3)).sort();
    expect(nums).toContain('092');
    expect(nums[nums.length - 1]).toBe('092'); // 092 が最高 (093+ を先取りしていない)
  });

  test('二重実装なし: replayAll 後も faqs_fts は無改変で機能し knowledge_chunks_fts と別表', () => {
    replayAll(raw);
    // 既存 faqs 経路は無改変で機能 (faqs_fts が別表として生きている)。
    raw.prepare(`INSERT INTO faqs (id, question, answer, search_text) VALUES ('f1','Q','A','えい いぎ ぎょ')`).run();
    const faqHit = raw.prepare(`SELECT f.id FROM faqs_fts x JOIN faqs f ON f.rowid=x.rowid WHERE x.search_text='えい いぎ ぎょ'`).get() as { id: string } | undefined;
    expect(faqHit?.id).toBe('f1');
    // knowledge_chunks_fts は独立 (faqs 挿入で汚染されない)。
    expect((raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c).toBe(0);
    // knowledge 側に入れても faqs_fts は 1 件のまま (別表)。
    raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES ('d1','text')`).run();
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content, search_text) VALUES ('c1','d1',0,'x','てす すと')`).run();
    expect((raw.prepare(`SELECT count(*) c FROM faqs_fts`).get() as { c: number }).c).toBe(1);
    expect((raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c).toBe(1);
  });
});
