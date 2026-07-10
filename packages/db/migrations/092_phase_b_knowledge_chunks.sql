-- Phase B batch B-3 (T-C3) — additive-only. 取込ナレッジの資料 (documents) + 分割チャンク (chunks) + FTS5 索引。
-- 番号: 台帳最大 091 (phase_b_faq_fts) 超の最小未使用 (M-2 着工時 ledger 実測で 092 を claim)。
-- knowledge_documents = 取込単位 (source_type 'url'|'text')。knowledge_chunks = 分割チャンク。
-- source_doc_id は宣言 FK (REFERENCES)。D1 は migration-time FK off (M-5) につき削除はアプリ側で
--   chunks→document の順に明示 (services/knowledge.deleteKnowledgeDocument) し CASCADE に依存しない。
-- search_text はアプリ層 (worker services/knowledge.ts) が normalize→2-gram→空白連結で計算して渡す列。
--   faqs (091) と同方式・faqs_fts とは別表 knowledge_chunks_fts (二重実装なし / F5・T-C3)。
-- トリガは NEW.search_text をコピーするだけ (SQL 内で normalize/ngrams を再現しない = pre-tokenize 原則)。
-- ⚠️ トリガは 1 行で書く: 全 replay テスト共通の SQL 分割器 (セミコロン+改行 で分割) が BEGIN...END を
--    壊さないよう、トリガ内部のセミコロンの直後を改行にしない。本番は wrangler d1 execute --file が native 適用。
-- knowledge_chunks_fts の shadow 表 (_data/_idx/_docsize/_config/_content) は SQLite 自動生成の派生物で
--   generate-bootstrap.mjs の汎用 virtual-table 除外により bootstrap から自動除外される (無改修 / D-3)。
-- timestamp は既存表 (faqs 等) と同一の JST strftime。datetime('now') (UTC) は使わない (列正典 drift 回避 / M-1)。
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  source_type     TEXT NOT NULL,
  source_url      TEXT,
  title           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              TEXT PRIMARY KEY,
  source_doc_id   TEXT NOT NULL REFERENCES knowledge_documents(id),
  line_account_id TEXT,
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  search_text     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  UNIQUE(source_doc_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(source_doc_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_acct ON knowledge_chunks(line_account_id);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(search_text, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_ai AFTER INSERT ON knowledge_chunks BEGIN INSERT INTO knowledge_chunks_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_ad AFTER DELETE ON knowledge_chunks BEGIN DELETE FROM knowledge_chunks_fts WHERE rowid = OLD.rowid; END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_au AFTER UPDATE ON knowledge_chunks BEGIN DELETE FROM knowledge_chunks_fts WHERE rowid = OLD.rowid; INSERT INTO knowledge_chunks_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;
