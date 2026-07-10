-- Phase B batch B-2 (T-B1) — additive-only. FAQ 全文検索 (FTS5) の索引列 + standalone 仮想表 + 同期トリガ。
-- 番号: 台帳最大 090 超の最小未使用 (M-2 着工時 ledger 実測で 091 を claim)。
-- search_text はアプリ層 (worker faq-fts.ts) が normalize→2-gram→空白連結で計算して渡す列。
-- トリガは NEW.search_text をコピーするだけ (SQL 内で normalize/ngrams を再現しない = pre-tokenize 原則)。
-- ⚠️ トリガは 1 行で書く: 全 replay テスト共通の SQL 分割器 (セミコロン+改行 で分割) が BEGIN...END を
--    壊さないよう、トリガ内部のセミコロンの直後を改行にしない。本番は wrangler d1 execute --file が native 適用。
-- 仮想表 faqs_fts の shadow 表 (faqs_fts_data/_idx/_docsize/_config/_content) は SQLite が自動生成する派生物。
ALTER TABLE faqs ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
CREATE VIRTUAL TABLE IF NOT EXISTS faqs_fts USING fts5(search_text, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS faqs_fts_ai AFTER INSERT ON faqs BEGIN INSERT INTO faqs_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;
CREATE TRIGGER IF NOT EXISTS faqs_fts_ad AFTER DELETE ON faqs BEGIN DELETE FROM faqs_fts WHERE rowid = OLD.rowid; END;
CREATE TRIGGER IF NOT EXISTS faqs_fts_au AFTER UPDATE ON faqs BEGIN DELETE FROM faqs_fts WHERE rowid = OLD.rowid; INSERT INTO faqs_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text); END;
