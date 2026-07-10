-- Phase B batch B-1 (T-A6) — additive-only. Workers AI 無料枠の neuron 積算 (UTC 日 bucket)。
-- 番号: 台帳最大 088 超の連番 2 本目 (M-2 着工時 ledger 実測で 090 を claim)。
-- usage_date は UTC 日 'YYYY-MM-DD' (Cloudflare 無料枠は 00:00 UTC リセット = 日付等値キーで窓歪みなし)。
-- UNIQUE(line_account_id, usage_date) は 1 account/日 1 行 = UPSERT 積算の土台。
CREATE TABLE IF NOT EXISTS ai_usage_budget (
  id                TEXT PRIMARY KEY,
  line_account_id   TEXT NOT NULL,
  usage_date        TEXT NOT NULL,
  llm_neurons       INTEGER NOT NULL DEFAULT 0,
  embed_neurons     INTEGER NOT NULL DEFAULT 0,
  image_neurons     INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  UNIQUE(line_account_id, usage_date)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_budget_date ON ai_usage_budget(usage_date);
