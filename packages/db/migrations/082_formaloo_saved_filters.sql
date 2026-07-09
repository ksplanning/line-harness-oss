-- Migration 082: Formaloo データコックピット 保存フィルタ (F-4 / T-D1 / line-formaloo-forms)
--
-- WHY: 専用データページ (/forms-advanced/[id]/data) で回答ミラーを絞り込む条件 (フリーワード q /
--   field 別条件 / 期間 / sort) を、form 単位で名前付き保存し再利用する (既存 saved_searches=049 と同型)。
--   owner「よく使う絞り込み」をワンタップで呼び出せるようにする (非エンジニア向け UX)。
--
-- additive のみ (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)。既存テーブル無改変 (D-1)。
--   check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。timestamp は JST ISO8601 (M-4)。
--   同一 DDL を schema.sql (正本) にも置く (bootstrap 再生成とのドリフト防止 / M-1)。

CREATE TABLE IF NOT EXISTS formaloo_saved_filters (
  id          TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL,                              -- formaloo_forms.id (FK はアプリ層 / D1 FK off = M-5)
  name        TEXT NOT NULL,
  filter_json TEXT NOT NULL DEFAULT '{}',                 -- { q, field, op, value, from, to, sort, dir } の正規化 JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_formaloo_saved_filters_form ON formaloo_saved_filters (form_id);
