-- Migration 083: Formaloo Google Sheets 連携状態 (F-5 / T-E1 / line-formaloo-forms) — 任意
--
-- WHY: 回答を Google スプレッドシートへニアリアルタイム同期する Formaloo native 連携 (R5) の
--   接続状態を管理画面に表示するため。owner が「シート連携」を押すと worker が Formaloo の
--   regenerate-gsheet-data を叩き、成功したら gsheet_connected=1 + gsheet_url を記録する。
--   ⚠️ Sheets の tier 制約 (Max で連携可否 / OAuth 所有者) は secret 未供給の dev では確定不能 →
--      worker 側で fail-soft (未連携表示 + sidecar 申し送り / G-7)。
--
-- 列:
--   gsheet_connected  0=未連携 | 1=連携済。
--   gsheet_url        連携先 Sheet URL (表示用 / NULL=未連携)。
--
-- additive のみ (ADD COLUMN NOT NULL DEFAULT / nullable)。既存 formaloo_forms 行の挙動不変。
--   check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。schema.sql 同期 + bootstrap 再生成 (M-1)。

ALTER TABLE formaloo_forms ADD COLUMN gsheet_connected INTEGER NOT NULL DEFAULT 0;

ALTER TABLE formaloo_forms ADD COLUMN gsheet_url TEXT;
