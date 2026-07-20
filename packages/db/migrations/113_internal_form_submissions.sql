-- Migration 113: self-hosted advanced form backend (W1 backbone).
-- Existing forms stay on Formaloo because the additive flag defaults to `formaloo`.
-- Internal answers use a separate table so the Formaloo mirror and API path remain unchanged.

ALTER TABLE formaloo_forms ADD COLUMN render_backend TEXT NOT NULL DEFAULT 'formaloo';

CREATE TABLE IF NOT EXISTS internal_form_submissions (
  id           TEXT PRIMARY KEY,
  form_id      TEXT NOT NULL,
  friend_id    TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_internal_form_submissions_form
  ON internal_form_submissions (form_id, submitted_at);

CREATE INDEX IF NOT EXISTS idx_internal_form_submissions_friend
  ON internal_form_submissions (friend_id);
