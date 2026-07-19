-- Migration 106: form 単位の Formaloo outbound webhook 登録台帳。
-- 既存 form は既定 OFF。登録を read-back 検証できた時だけ enabled=1 と remote id / callback secret / URL を保存する。
-- additive のみ（既存フォーム・既存回答・既存 webhook 経路は無改変）。
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_id TEXT;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_secret TEXT;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_url TEXT;
