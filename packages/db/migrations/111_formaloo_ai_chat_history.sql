-- Migration 111: owner-gated Formaloo AI analysis history + atomic daily credit reservation.
-- The provider request shape is intentionally not stored here; official OpenAPI leaves it unspecified.
CREATE TABLE IF NOT EXISTS formaloo_ai_chat_history (
  id                  TEXT PRIMARY KEY,
  tenant_scope        TEXT NOT NULL,
  line_account_id     TEXT NOT NULL,
  form_id             TEXT NOT NULL REFERENCES formaloo_forms (id) ON DELETE CASCADE,
  question            TEXT NOT NULL,
  answer_json         TEXT,
  answer_text         TEXT,
  analysis_slug       TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  provider_status     TEXT,
  error_code          TEXT,
  error_message       TEXT,
  credits_consumed    INTEGER NOT NULL DEFAULT 0 CHECK (credits_consumed IN (0, 1)),
  credit_reserved     INTEGER NOT NULL DEFAULT 1 CHECK (credit_reserved IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_formaloo_ai_chat_history_scope
  ON formaloo_ai_chat_history (tenant_scope, line_account_id, form_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_formaloo_ai_chat_daily_guard
  ON formaloo_ai_chat_history (tenant_scope, credit_reserved, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_formaloo_ai_chat_one_pending
  ON formaloo_ai_chat_history (tenant_scope, line_account_id, form_id)
  WHERE status = 'pending';
