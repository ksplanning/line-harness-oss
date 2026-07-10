-- Phase B batch B-1 (T-A5) — additive-only. faqs 予約列 (046 コメント準拠) + AI draft 保存表。
-- 番号: 台帳最大 088 超の最小未使用 (M-2 着工時 ledger 実測で 089 を claim)。
-- embedding 列は追加しない (B-4 / Vectorize)。
ALTER TABLE faqs ADD COLUMN answer_type TEXT DEFAULT 'text';
ALTER TABLE faqs ADD COLUMN source_doc_id TEXT;

-- answer_mode=draft の AI 回答草案 (送信せず staff 承認待ち / 承認 UI は B-5)。
CREATE TABLE IF NOT EXISTS ai_faq_drafts (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT,
  friend_id         TEXT,
  question          TEXT NOT NULL,
  draft_answer      TEXT NOT NULL,
  evidence_faq_ids  TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_ai_faq_drafts_account_status ON ai_faq_drafts(line_account_id, status);
