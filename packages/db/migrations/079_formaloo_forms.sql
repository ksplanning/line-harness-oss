-- Migration 079: Formaloo ミラー基盤 4 テーブル (F-1 / line-formaloo-forms)
--
-- WHY: Formaloo Max Tier を土台にした高機能フォームを LINE ハーネスへ統合する (§4 SoT)。
--   Formaloo = フォーム定義/レンダリング/ファイル/Sheets の正本。ハーネス D1 = マッピング台帳 +
--   回答ミラー + 同期状態の正本。native forms (007_forms.sql) は無改変で併存 (D-1 / 後方互換)。
--
-- SoT (§4): D1 の formaloo_forms は「表示用キャッシュ」であって権威ではない。builder open 時に
--   Formaloo から pull して最新化する (N-8 drift 対策)。回答は webhook で formaloo_submissions へ
--   冪等 upsert (PK = Formaloo submission id / N-3 dedup)。
--
-- additive のみ (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)。DROP/RENAME/CHECK 拡張なし
--   = check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。timestamp は JST ISO8601 (086 と同一慣習 / M-4)。
--   publish gate の状態機械列は 080 で ADD COLUMN (builder 状態 additive)。

-- 1) 台帳: harness id ↔ Formaloo slug + 定義キャッシュ + LINE 後処理設定
CREATE TABLE IF NOT EXISTS formaloo_forms (
  id                    TEXT PRIMARY KEY,                         -- harness id (fa_...)
  formaloo_slug         TEXT,                                     -- Formaloo form slug/address (NULL = 未 push draft)
  title                 TEXT NOT NULL DEFAULT '',
  description           TEXT,
  definition_json       TEXT NOT NULL DEFAULT '{}',               -- 定義スナップショット (fields/logic) = 表示用キャッシュ
  on_submit_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,       -- 回答時タグ付与 (native forms 流用)
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,  -- 回答時シナリオ開始
  submit_message        TEXT,                                     -- 回答後メッセージ (任意)
  submit_count          INTEGER NOT NULL DEFAULT 0,
  deleted               INTEGER NOT NULL DEFAULT 0,               -- N-11 tombstone (Formaloo 側削除でミラー無効化)
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_formaloo_forms_slug ON formaloo_forms (formaloo_slug);

-- 2) 回答ミラー: 検索/統計/G11 を D1 で高速に。PK = Formaloo submission id で冪等 upsert (N-3)
CREATE TABLE IF NOT EXISTS formaloo_submissions (
  id            TEXT PRIMARY KEY,                                 -- Formaloo submission/row id (dedup キー / N-3)
  form_id       TEXT NOT NULL,                                    -- formaloo_forms.id (FK はアプリ層で解決 / D1 FK off = M-5)
  formaloo_slug TEXT,                                             -- webhook 経路の照合冗長キー
  friend_id     TEXT,                                             -- 照合できた LINE friend (任意)
  answers_json  TEXT NOT NULL DEFAULT '{}',                       -- 回答ミラー (TRINA PII を含み得る / N-9)
  submitted_at  TEXT NOT NULL,                                    -- Formaloo 側 submit 時刻 (ISO8601)
  synced_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_formaloo_submissions_form ON formaloo_submissions (form_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_formaloo_submissions_friend ON formaloo_submissions (friend_id);

-- 3) field 種別マッピング: harness field ↔ Formaloo field slug + MVP subset 種別 (N-13)
CREATE TABLE IF NOT EXISTS formaloo_field_map (
  id                  TEXT PRIMARY KEY,                           -- harness field id
  form_id             TEXT NOT NULL,                              -- formaloo_forms.id
  formaloo_field_slug TEXT,                                       -- Formaloo field slug (NULL = 未 push)
  field_type          TEXT NOT NULL,                              -- MVP subset: text/textarea/choice/dropdown/multiple_select/number/email/phone/date/file
  label               TEXT NOT NULL DEFAULT '',
  position            INTEGER NOT NULL DEFAULT 0,
  config_json         TEXT NOT NULL DEFAULT '{}',                 -- required/max_length/choices/allowed_extensions/logic 等
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_formaloo_field_map_form ON formaloo_field_map (form_id, position);

-- 4) 同期状態: last push/pull + 部分 push 失敗バッジ (N-13) / fail-soft (N-6)
CREATE TABLE IF NOT EXISTS formaloo_sync_state (
  form_id        TEXT PRIMARY KEY,                                -- formaloo_forms.id (1:1)
  last_pushed_at TEXT,
  last_pulled_at TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'idle',                    -- idle | pushing | pulling | out_of_sync | error
  last_error     TEXT,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
