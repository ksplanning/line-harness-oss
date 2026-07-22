-- Migration 128: sheets sync jobs carry a sync target so the friend ledger and
-- the form-results tab can each keep one durable resumable job per connection.
-- Existing rows default to 'ledger' (today's only target).

ALTER TABLE sheets_sync_jobs
  ADD COLUMN target TEXT NOT NULL DEFAULT 'ledger'
  CHECK (target IN ('ledger', 'form_results'));

-- Replace the one-running-per-connection slot with one per (connection, target).
-- Safe on existing data: every row currently has target = 'ledger' and the old
-- index already guaranteed at most one running row per connection.
DROP INDEX IF EXISTS idx_sheets_sync_jobs_one_running;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_jobs_one_running
  ON sheets_sync_jobs (connection_id, target)
  WHERE status = 'running';
