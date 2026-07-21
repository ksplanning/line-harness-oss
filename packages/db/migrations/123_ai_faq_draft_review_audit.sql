-- chat-inline-draft-review: operator review actions for AI FAQ drafts.
-- The draft row remains the current-state snapshot; this table is the immutable audit trail.
CREATE TABLE IF NOT EXISTS ai_faq_draft_audit_log (
  id              TEXT PRIMARY KEY,
  draft_id        TEXT NOT NULL REFERENCES ai_faq_drafts(id) ON DELETE RESTRICT,
  line_account_id TEXT,
  friend_id       TEXT NOT NULL,
  actor_staff_id  TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('edited', 'approved', 'discarded', 'send_failed')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ai_faq_draft_audit_draft_created
  ON ai_faq_draft_audit_log (draft_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_faq_draft_audit_account_created
  ON ai_faq_draft_audit_log (line_account_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_ai_faq_draft_audit_no_replace
BEFORE INSERT ON ai_faq_draft_audit_log
WHEN EXISTS (SELECT 1 FROM ai_faq_draft_audit_log WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'ai_faq_draft_audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_ai_faq_draft_audit_no_update
BEFORE UPDATE ON ai_faq_draft_audit_log
BEGIN SELECT RAISE(ABORT, 'ai_faq_draft_audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_ai_faq_draft_audit_no_delete
BEFORE DELETE ON ai_faq_draft_audit_log
BEGIN SELECT RAISE(ABORT, 'ai_faq_draft_audit_log is append-only'); END;
