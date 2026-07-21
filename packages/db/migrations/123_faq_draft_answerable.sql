-- AI 草案が資料だけで実質回答できたかを明示保存する。
-- 既存草案と決定的 FAQ 草案は DEFAULT 1、構造化自己申告 false のみ 0。
ALTER TABLE ai_faq_drafts
  ADD COLUMN answerable INTEGER NOT NULL DEFAULT 1 CHECK (answerable IN (0, 1));
