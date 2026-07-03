-- 050_canned_responses.sql (G23 チャット定型文 / canned responses)
--
-- 個別 1:1 チャットの返信に「差し込む」定型文を名前付きで保存・再利用する
-- additive-only テーブル。既存 message_templates (配信テンプレ) とは別責務。
-- 挿入 UI は本文を入力欄に貼るだけで、送信経路 (POST /api/chats/:id/send) には
-- 一切触れない。破壊操作ゼロ。
-- 同一 DDL が packages/db/schema.sql (正本) にもある (schema replay とのドリフト防止)。
CREATE TABLE IF NOT EXISTS canned_responses (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,          -- NULL = 全アカ共通 / それ以外 = account スコープ
  title            TEXT NOT NULL,              -- 定型文の見出し (一覧・ピッカー表示用)
  content          TEXT NOT NULL,              -- 挿入される本文 (テキスト)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_canned_responses_account ON canned_responses(line_account_id);
