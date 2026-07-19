-- Migration 109: form-scoped mirror and idempotency ledger for Formaloo recurring submissions.
-- Provider truth is committed only after a fresh detail read-back. Pending/failed rows retain the
-- request key and candidate slug so retries do not blindly create a duplicate remote schedule.
CREATE TABLE IF NOT EXISTS formaloo_recurring_submissions (
  id                   TEXT PRIMARY KEY,
  form_id              TEXT NOT NULL REFERENCES formaloo_forms (id) ON DELETE CASCADE,
  idempotency_key      TEXT NOT NULL,
  remote_slug          TEXT,
  schedule_json        TEXT NOT NULL,
  submission_data_json TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'resumed' CHECK (status IN ('resumed', 'paused', 'cancelled')),
  sync_state           TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced', 'failed')),
  last_error           TEXT,
  operation_token      TEXT,
  operation_lock_until INTEGER,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (form_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_formaloo_recurring_remote_slug
  ON formaloo_recurring_submissions (form_id, remote_slug)
  WHERE remote_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_formaloo_recurring_form
  ON formaloo_recurring_submissions (form_id, created_at DESC);
