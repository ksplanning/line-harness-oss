-- Migration 096: ハーネス側フォルダ分類 (SoT) — formaloo_folders + formaloo_forms.folder_id (F6-3 / 本柱③)
--
-- WHY: owner がフォームを「フォルダ」で自由に仕分けて整理できるようにする。この分類は **ハーネス側が
--   単一の正 (SoT)** であり、一覧の絞り込み/整理の主軸になる。Formaloo 側フォルダとの自動連動は公式
--   v3.0 API が form↔folder 紐づけを read も write も露出しない (ROLLOUT_PLAN §3.3 実機 2 回確認 / N-19)
--   ため実装しない (UI に「自動連動しません」と正直表示)。フォルダは F6-2 の line_account_id 表示スコープ
--   と直交に効く (account スコープ内での分類 / フォルダ自体も account に属す)。
--
-- 設計:
--   - formaloo_folders.line_account_id は **NOT NULL** (フォルダは必ず account に属す / Codex M#3)。
--     nullable だと NULL account フォルダで cross-account 不変条件を迂回できるため NOT NULL で塞ぐ。
--   - parent_id TEXT (NULL=トップレベル / 入れ子)。循環 (A→B→A)・自己親・別 account 親はアプリ層で拒否。
--   - formaloo_forms.folder_id TEXT (NULL=未分類 / 後方互換 = 既存 079-095 行は NULL のまま挙動不変 / D-1)。
--   - FK は張らない (D1 は FK off・アプリ層解決 / M-5): folder_id→formaloo_folders.id /
--     parent_id→formaloo_folders.id / folder.line_account_id→line_accounts.id はアプリ層検証
--     (cross-account・循環・削除 cascade をアプリ層で原子的に処理)。
--
-- additive のみ (CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN [NULL] / CREATE INDEX IF NOT EXISTS)。
--   DROP/RENAME/CHECK 拡張・ALTER ADD COLUMN NOT NULL なし = check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。
--   formaloo_folders.line_account_id の NOT NULL は CREATE TABLE 本体 (新規テーブル) ゆえ additive 許容。
--   timestamp は JST ISO8601 (079/094/095 と同一慣習 / M-4)。
-- D-1 不可侵: 既存 formaloo_forms / formaloo_submissions / formaloo_field_map / formaloo_sync_state /
--   formaloo_workspaces / formaloo_account_bindings は無改変 (folder_id 追加のみ additive)。

CREATE TABLE IF NOT EXISTS formaloo_folders (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,                                 -- フォルダは必ず account に属す (Codex M#3 / FK off = アプリ層検証)
  name            TEXT NOT NULL,
  parent_id       TEXT,                                          -- NULL=トップレベル / 入れ子 (循環/自己親/別 account 親はアプリ層で拒否)
  position        INTEGER NOT NULL DEFAULT 0,                    -- 表示順 (並べ替え UI は最小 CRUD 外)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

ALTER TABLE formaloo_forms ADD COLUMN folder_id TEXT;  -- NULL=未分類 (後方互換 / ハーネス側フォルダ分類)

-- フォルダ一覧を account で絞る用 (listFormalooFolders)。
CREATE INDEX IF NOT EXISTS idx_formaloo_folders_account ON formaloo_folders (line_account_id);
-- 一覧の folder 絞り用 (listFormalooForms の ?folderId= / ?folderId=none)。
CREATE INDEX IF NOT EXISTS idx_formaloo_forms_folder ON formaloo_forms (folder_id);
