-- Migration 095: Formaloo フォームの表示スコープ + 作成先 workspace 配線 (F6-2 / 本柱②④)
--
-- WHY: 同じ Formaloo 鍵を複数 LINE アカウントで共有していても A のフォームが B の画面に混ざらない
--   ように、フォームを「どの LINE アカウント用か」でハーネス側に束縛して表示を仕分ける (line_account_id)。
--   さらにフォーム作成時に「どの Formaloo workspace(=どの鍵) に作るか」を記録し (workspace_id)、以後の
--   push/pull/sync がそのフォームの workspace 鍵で解決される (F6-1 resolveFormalooClient の引数)。
--
-- 表示スコープ ≠ アクセス強制 (N-17): 本 migration の line_account_id 列は「画面の仕分け(表示フィルタ)」の
--   基盤であり、別スタッフの URL 直打ちを遮断する強制境界ではない (強制は G2 依存)。line_account_id 列は
--   G2 で全 ID route に強制フィルタを掛ける際の先行基盤として整備する。
--
-- 設計:
--   - line_account_id TEXT (NULL=全アカウント共通表示 = 後方互換 / 既存 079-094 行は NULL のまま挙動不変)。
--   - workspace_id    TEXT (NULL=既定=env 単一鍵 fallback / F6-1 [FIX-4] と byte-equivalent)。
--   - FK は張らない (D1 は FK off・アプリ層解決 / M-5): line_account_id→line_accounts.id /
--     workspace_id→formaloo_workspaces.id は resolver の active 判定 + fail-soft で担保する。
--   - formaloo_account_bindings: 作成時に「明示 workspace 無 + lineAccountId 有」のとき既定 workspace を
--     server 解決するための軽量台帳 (line_account_id PK → default_workspace_id)。無効/未登録 workspace を
--     指す binding は解決時に active 判定で NULL に落とす (孤立 form を生まない / cascade 消去しない)。
--
-- additive のみ (ALTER TABLE ADD COLUMN [NULL] / CREATE INDEX IF NOT EXISTS / CREATE TABLE IF NOT EXISTS)。
--   DROP/RENAME/CHECK 拡張・NOT NULL 追加なし = check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。
--   timestamp は JST ISO8601 (079/094 と同一慣習 / M-4)。
-- D-1 不可侵: 既存 formaloo_submissions / formaloo_field_map / formaloo_sync_state / formaloo_workspaces は無改変。

ALTER TABLE formaloo_forms ADD COLUMN line_account_id TEXT;  -- NULL=全アカウント共通表示 (後方互換 / 表示スコープ)
ALTER TABLE formaloo_forms ADD COLUMN workspace_id    TEXT;  -- NULL=既定=env 単一鍵 fallback (作成先 workspace 鍵)

-- 一覧絞り込み用 index。query は WHERE deleted=0 AND (line_account_id=? OR line_account_id IS NULL)
-- ORDER BY updated_at DESC。複合 index でフィルタ + 並び順をまとめて効かせる。
CREATE INDEX IF NOT EXISTS idx_formaloo_forms_account ON formaloo_forms (line_account_id, deleted, updated_at);

-- 作成時の既定 workspace 解決台帳 (M-4 JST 慣習)。default_workspace_id は登録済 active workspace のみ
-- アプリ層で受理 (無効値は書かない / 参照整合性)。平文鍵は一切持たない (D-2)。
CREATE TABLE IF NOT EXISTS formaloo_account_bindings (
  line_account_id      TEXT PRIMARY KEY,                          -- LINE アカウント id (line_accounts.id / FK off)
  default_workspace_id TEXT,                                      -- 既定 Formaloo workspace (fw_... / NULL=env 既定)
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
