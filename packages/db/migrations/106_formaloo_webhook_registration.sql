-- Migration 106: form 単位の Formaloo outbound webhook 登録台帳。
-- 既存 form は既定 OFF。登録を read-back 検証できた時だけ enabled=1 と remote id / callback secret / URL を保存する。
-- additive のみ（既存フォーム・既存回答・既存 webhook 経路は無改変）。
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_id TEXT;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_secret TEXT;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_url TEXT;
-- D1 の atomic UPDATE を分散 lock として使い、別 Worker isolate からの同時 ON/OFF を直列化する。
-- lock は owner token でのみ解除し、request 中断時も期限切れ後に回収できる。
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_lock_token TEXT;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_lock_until INTEGER;
-- callback は世代を durable dirty bit として加算する。processed 未到達の世代だけを form-global に claim する。
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_pull_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_pull_processed_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_pull_lock_token TEXT;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_pull_lock_until INTEGER;
ALTER TABLE formaloo_forms ADD COLUMN formaloo_webhook_pull_not_before INTEGER NOT NULL DEFAULT 0;
