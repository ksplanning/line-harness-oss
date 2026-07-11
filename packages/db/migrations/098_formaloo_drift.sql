-- Migration 098: Formaloo 定義 drift の定期検知 + 監査履歴 (formaloo-auto-pull / owner 必須発注)
--
-- WHY: 運用者が Formaloo 管理画面で直接編集したフォーム定義 (drift) を cron が定期検知し、安全な変更は
--   自動反映・危険な変更/ローカル競合は通知のみに振り分け、取り込み忘れによる二重管理のズレを無くす。
--
-- 設計:
--   - formaloo_sync_state に drift 追跡列を additive 追加 (既存 idle/pushing/pulling/out_of_sync/error の
--     sync_status とは直交する別軸 = drift_status)。既定値は後方互換 (既存行は drift_status='none' 相当)。
--   - remote_definition_hash = 最後に確認/合意した Formaloo 側定義 fingerprint (NULL=未 bootstrap)。
--   - pending_remote_hash = 通知中 (未適用) drift の fingerprint (6h 毎の重複履歴を防ぐ dedup キー)。
--   - drift_status = none|detected|applied|conflict (UI badge 優先順位の入力)。
--   - drift_detected_at = 最新 drift 検知時刻 (JST ISO)。remote_updated_at = list timestamp フィルタ用
--     (Formaloo list 応答に per-form timestamp が実在する時のみ使う optional 最適化 / closer live-check で採否)。
--   - formaloo_drift_events = 自動反映/通知/競合/bootstrap の監査履歴 (R5 / 後から追える)。
--
-- additive のみ (ALTER TABLE ADD COLUMN [NULL or 定数 DEFAULT] / CREATE TABLE IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS)。DROP/RENAME/CHECK 拡張・ADD COLUMN NOT NULL(非定数 DEFAULT) なし
--   = check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。
-- 🚨 D1/SQLite の ALTER ADD COLUMN は DEFAULT に非定数式 (strftime 等) を使えないため、timestamp 系
--   (drift_detected_at / remote_updated_at) は既定 NULL (定数)。drift_status のみ定数 'none' を DEFAULT。
-- D-1 不可侵: 既存 formaloo_forms / formaloo_submissions / formaloo_field_map / formaloo_workspaces /
--   formaloo_account_bindings / formaloo_folders は無改変 (sync_state への additive 列追加のみ)。

-- 1) 同期状態に drift 追跡列を additive 追加。
ALTER TABLE formaloo_sync_state ADD COLUMN remote_definition_hash TEXT;                 -- baseline fingerprint (NULL=未 bootstrap)
ALTER TABLE formaloo_sync_state ADD COLUMN pending_remote_hash    TEXT;                 -- 通知中 drift の fingerprint (dedup キー)
ALTER TABLE formaloo_sync_state ADD COLUMN drift_status           TEXT NOT NULL DEFAULT 'none'; -- none|detected|applied|conflict
ALTER TABLE formaloo_sync_state ADD COLUMN drift_detected_at      TEXT;                 -- 最新 drift 検知時刻 (JST ISO)
ALTER TABLE formaloo_sync_state ADD COLUMN remote_updated_at      TEXT;                 -- optional: list timestamp フィルタ用 (live 実在時)

-- 2) 監査履歴テーブル (R5)。
CREATE TABLE IF NOT EXISTS formaloo_drift_events (
  id             TEXT PRIMARY KEY,                 -- de_...
  form_id        TEXT NOT NULL,                    -- formaloo_forms.id (FK はアプリ層 / D1 FK off)
  detected_at    TEXT NOT NULL,                    -- 検知時刻 (JST ISO)
  action         TEXT NOT NULL,                    -- notified | auto_applied | conflict_held | bootstrapped
  remote_hash    TEXT,                             -- 検知した Formaloo fingerprint
  prev_hash      TEXT,                             -- 直前 baseline (差分の起点)
  has_warnings   INTEGER NOT NULL DEFAULT 0,       -- 弱化 warnings 有無 (1/0)
  warnings_json  TEXT,                             -- warnings 文言 (任意)
  sync_status_at TEXT,                             -- 検知時の sync_status (競合判定の証跡)
  detail         TEXT,                             -- 補足 (任意)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- form 単位の履歴を新しい順に引く用。
CREATE INDEX IF NOT EXISTS idx_formaloo_drift_events_form ON formaloo_drift_events (form_id, detected_at);
