-- Migration 122: append-only audit metadata for FAQ personal-context injection.
-- Personal values and form answers are intentionally not persisted here.

CREATE TABLE IF NOT EXISTS faq_personal_context_audit_log (
  id                         TEXT PRIMARY KEY,
  line_account_id            TEXT NOT NULL,
  friend_id                  TEXT NOT NULL,
  display_name_included      INTEGER NOT NULL DEFAULT 0 CHECK (display_name_included IN (0, 1)),
  custom_field_ids_json      TEXT NOT NULL DEFAULT '[]',
  formaloo_submission_count  INTEGER NOT NULL DEFAULT 0 CHECK (formaloo_submission_count >= 0),
  internal_submission_count  INTEGER NOT NULL DEFAULT 0 CHECK (internal_submission_count >= 0),
  prompt_token_estimate      INTEGER NOT NULL DEFAULT 0 CHECK (prompt_token_estimate >= 0),
  was_truncated              INTEGER NOT NULL DEFAULT 0 CHECK (was_truncated IN (0, 1)),
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_faq_personal_context_audit_account_created
  ON faq_personal_context_audit_log (line_account_id, created_at);

CREATE INDEX IF NOT EXISTS idx_faq_personal_context_audit_friend_created
  ON faq_personal_context_audit_log (friend_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_faq_personal_context_audit_no_replace
BEFORE INSERT ON faq_personal_context_audit_log
WHEN EXISTS (SELECT 1 FROM faq_personal_context_audit_log WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'faq_personal_context_audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_faq_personal_context_audit_no_update
BEFORE UPDATE ON faq_personal_context_audit_log
BEGIN SELECT RAISE(ABORT, 'faq_personal_context_audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_faq_personal_context_audit_no_delete
BEFORE DELETE ON faq_personal_context_audit_log
BEGIN SELECT RAISE(ABORT, 'faq_personal_context_audit_log is append-only'); END;
