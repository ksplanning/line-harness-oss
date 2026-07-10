/**
 * T-A5 (Phase B B-1) — migration 089 が faqs に Phase B 予約列を additive で足し、
 * AI draft 保存表 ai_faq_drafts を新設する検証。
 *   faqs.answer_type   : 'text' 既定 (046 コメント準拠)。
 *   faqs.source_doc_id : 取込元 doc 参照 (NULL 可 / B-3+)。
 *   embedding は追加しない (B-4 / Vectorize)。
 * additive のみ (ADD COLUMN with DEFAULT / nullable / CREATE TABLE IF NOT EXISTS)。
 * 既存 faqs 行の挙動不変。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('migration 089 — faqs 予約列 + ai_faq_drafts (additive / T-A5)', () => {
  test('faqs に answer_type / source_doc_id 列が生える (embedding は生えない)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(faqs)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('answer_type');
    expect(cols).toContain('source_doc_id');
    expect(cols).not.toContain('embedding'); // B-4 で追加
  });

  test('新規 faq は answer_type=text 既定 / source_doc_id=NULL', () => {
    raw.prepare(`INSERT INTO faqs (id, question, answer) VALUES ('fq1','Q','A')`).run();
    const row = raw.prepare(`SELECT answer_type, source_doc_id FROM faqs WHERE id='fq1'`).get() as { answer_type: string; source_doc_id: string | null };
    expect(row.answer_type).toBe('text');
    expect(row.source_doc_id).toBeNull();
  });

  test('既存 faqs 列は不変 (question/variants/answer/is_active/hit_count)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(faqs)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'line_account_id', 'question', 'variants', 'answer', 'is_active', 'hit_count', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  test('ai_faq_drafts 表が新設され期待列を持つ', () => {
    const cols = (raw.prepare(`PRAGMA table_info(ai_faq_drafts)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'line_account_id', 'friend_id', 'question', 'draft_answer', 'evidence_faq_ids', 'status', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  test('新規 ai_faq_drafts は status=pending / evidence_faq_ids=[] 既定', () => {
    raw.prepare(`INSERT INTO ai_faq_drafts (id, question, draft_answer) VALUES ('d1','Q','A')`).run();
    const row = raw.prepare(`SELECT status, evidence_faq_ids FROM ai_faq_drafts WHERE id='d1'`).get() as { status: string; evidence_faq_ids: string };
    expect(row.status).toBe('pending');
    expect(row.evidence_faq_ids).toBe('[]');
  });

  test('idx_ai_faq_drafts_account_status インデックスが存在', () => {
    const idx = (raw.prepare(`PRAGMA index_list(ai_faq_drafts)`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('idx_ai_faq_drafts_account_status');
  });
});
