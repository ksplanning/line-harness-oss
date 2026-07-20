-- Migration 119: account-scoped friend ledger bidirectional sync.
-- Extends the landed migration 114 foundation without changing Formaloo tables.

ALTER TABLE sheets_connections
  ADD COLUMN friend_field_mappings_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(friend_field_mappings_json) AND json_type(friend_field_mappings_json) = 'array');

-- Existing migration-114 connections may point at unrelated answer sheets.
-- Only a settings save through the friend-ledger UI opts a connection in.
ALTER TABLE sheets_connections
  ADD COLUMN friend_ledger_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (friend_ledger_enabled IN (0, 1));

ALTER TABLE sheets_connections ADD COLUMN last_sync_at TEXT;

ALTER TABLE sheets_connections
  ADD COLUMN last_sync_status TEXT NOT NULL DEFAULT 'idle'
  CHECK (last_sync_status IN ('idle', 'running', 'success', 'warning', 'error'));

ALTER TABLE sheets_connections ADD COLUMN last_sync_warning TEXT;
ALTER TABLE sheets_connections ADD COLUMN last_sync_error_code TEXT;
ALTER TABLE sheets_connections ADD COLUMN sync_lock_token TEXT;
ALTER TABLE sheets_connections ADD COLUMN sync_lock_expires_at TEXT;

ALTER TABLE sheets_sync_ledger
  ADD COLUMN canonical_snapshot_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(canonical_snapshot_json) AND json_type(canonical_snapshot_json) = 'object');

-- The parent audit row retains the immutable target/sequence/fingerprint.
-- Details make every accepted or ignored cell edit observable in plain terms.
CREATE TABLE IF NOT EXISTS sheets_sync_audit_details (
  id          TEXT PRIMARY KEY,
  audit_id    TEXT NOT NULL REFERENCES sheets_sync_audit_log (id) ON DELETE RESTRICT,
  actor       TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  column_name TEXT NOT NULL CHECK (length(column_name) BETWEEN 1 AND 200),
  old_value   TEXT,
  new_value   TEXT,
  source      TEXT NOT NULL CHECK (source IN ('webhook', 'polling', 'manual')),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('custom_field', 'identity_sync', 'identity_ignored', 'conflict')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_audit_details_parent
  ON sheets_sync_audit_details (audit_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_audit_details_no_replace
BEFORE INSERT ON sheets_sync_audit_details
WHEN EXISTS (SELECT 1 FROM sheets_sync_audit_details WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_details is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_audit_details_no_update
BEFORE UPDATE ON sheets_sync_audit_details
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_details is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_audit_details_no_delete
BEFORE DELETE ON sheets_sync_audit_details
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_details is append-only'); END;
