-- Migration 123: auto_replies.response_messages 追加 (複数吹き出し / additive)
-- NULL は従来の response_type/response_content/template_id 単一応答をそのまま使う。
-- 非 NULL は順序付き AutoReplyResponseMessage[] (1..5)。妥当性は API/送信層で検証する。
ALTER TABLE auto_replies ADD COLUMN response_messages TEXT;
