-- Migration 127: separate form-results tab with its own bidirectional sync.
-- The friend ledger keeps 1 friend = 1 row; the results tab keeps
-- 1 submission = 1 row (sheets_sync_ledger record_key = 'sub:<submission_id>').
-- Default 0 preserves the combined-sheet behavior of existing connections.

ALTER TABLE sheets_connections
  ADD COLUMN form_results_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (form_results_enabled IN (0, 1));

-- Second tab of the SAME spreadsheet, chosen from the inspect tab list.
ALTER TABLE sheets_connections ADD COLUMN form_results_sheet_name TEXT;

-- Harness-owned answer headings on the results tab (same shape as
-- form_answer_headers_json: [{fieldId, header}]).
ALTER TABLE sheets_connections
  ADD COLUMN form_results_headers_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(form_results_headers_json) AND json_type(form_results_headers_json) = 'array');

-- Each accepted onEdit snapshot belongs to exactly one sync target so a flag
-- flip can invalidate its own queue without touching the other target.
ALTER TABLE sheets_sync_webhook_events
  ADD COLUMN target TEXT NOT NULL DEFAULT 'ledger'
  CHECK (target IN ('ledger', 'form_results'));

-- Extends the migration-119 trigger: a target move (or a flag flip, which
-- always advances config_version through the settings API) re-baselines only
-- the affected target's rows. Results rows are record_key LIKE 'sub:%'.
DROP TRIGGER IF EXISTS trg_sheets_sync_ledger_connection_changed;
CREATE TRIGGER trg_sheets_sync_ledger_connection_changed
AFTER UPDATE OF config_version, spreadsheet_id, sheet_name, form_results_sheet_name, friend_ledger_enabled, form_results_enabled ON sheets_connections
WHEN NEW.config_version <> OLD.config_version
  OR NEW.friend_ledger_enabled <> OLD.friend_ledger_enabled
  OR NEW.form_results_enabled <> OLD.form_results_enabled
BEGIN DELETE FROM sheets_sync_ledger WHERE connection_id = NEW.id AND record_key NOT LIKE 'sub:%' AND (NEW.spreadsheet_id <> OLD.spreadsheet_id OR NEW.sheet_name <> OLD.sheet_name OR NEW.friend_ledger_enabled <> OLD.friend_ledger_enabled); DELETE FROM sheets_sync_ledger WHERE connection_id = NEW.id AND record_key LIKE 'sub:%' AND (NEW.spreadsheet_id <> OLD.spreadsheet_id OR NEW.form_results_sheet_name IS NOT OLD.form_results_sheet_name OR NEW.form_results_enabled <> OLD.form_results_enabled); UPDATE sheets_sync_ledger SET connection_version = NEW.config_version, version = version + 1 WHERE connection_id = NEW.id AND NEW.config_version <> OLD.config_version; END;

-- Extends the migration-119 trigger: a generation change, deactivation, or
-- tenant move still clears every pending event (no stranded PII). A flag flip
-- that does not advance the generation kills only its own target's queue.
DROP TRIGGER IF EXISTS trg_sheets_sync_webhook_events_connection_changed;
CREATE TRIGGER trg_sheets_sync_webhook_events_connection_changed
AFTER UPDATE OF config_version, friend_ledger_enabled, form_results_enabled, is_active, deleted_at, line_account_id
ON sheets_connections
WHEN NEW.config_version <> OLD.config_version
  OR NEW.friend_ledger_enabled <> OLD.friend_ledger_enabled
  OR NEW.form_results_enabled <> OLD.form_results_enabled
  OR NEW.is_active <> OLD.is_active
  OR NEW.deleted_at IS NOT OLD.deleted_at
  OR NEW.line_account_id IS NOT OLD.line_account_id
BEGIN
  UPDATE sheets_sync_webhook_events
  SET status = 'dead', payload_json = NULL, actor = 'redacted', actor_kind = 'unavailable',
      processing_token = NULL, processing_expires_at = NULL,
      completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
      last_error_code = 'connection_changed'
  WHERE connection_id = NEW.id AND status = 'pending'
    AND (
      NEW.config_version <> OLD.config_version
      OR NEW.is_active <> OLD.is_active
      OR NEW.deleted_at IS NOT OLD.deleted_at
      OR NEW.line_account_id IS NOT OLD.line_account_id
      OR (target = 'ledger' AND NEW.friend_ledger_enabled <> OLD.friend_ledger_enabled)
      OR (target = 'form_results' AND NEW.form_results_enabled <> OLD.form_results_enabled)
    ); END;

-- Each tab owns its own row-number space: the ledger tab and the results tab
-- may both use sheet row N of the same connection. Uniqueness stays enforced
-- within each target.
DROP INDEX IF EXISTS idx_sheets_sync_ledger_row;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_ledger_row_ledger
  ON sheets_sync_ledger (connection_id, sheet_row_number)
  WHERE sheet_row_number IS NOT NULL AND record_key NOT LIKE 'sub:%';
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_ledger_row_form_results
  ON sheets_sync_ledger (connection_id, sheet_row_number)
  WHERE sheet_row_number IS NOT NULL AND record_key LIKE 'sub:%';
