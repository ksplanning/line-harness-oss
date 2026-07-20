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

-- Remembers which Harness-owned headings were generated. This remains valid
-- even when there are zero friends (and therefore no ledger rows), so a later
-- owner rename is warned about instead of silently creating a replacement.
ALTER TABLE sheets_connections
  ADD COLUMN friend_ledger_headers_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(friend_ledger_headers_json) AND json_type(friend_ledger_headers_json) = 'array');

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

ALTER TABLE sheets_sync_audit_log ADD COLUMN webhook_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_audit_webhook_event
  ON sheets_sync_audit_log (connection_id, webhook_event_id)
  WHERE webhook_event_id IS NOT NULL;

-- Signed onEdit snapshots are accepted durably before attempting the sync.
-- Applied/dead rows retain a non-sensitive event tombstone; payload_json and
-- actor (which may contain cell/editor PII) are erased on terminal completion.
CREATE TABLE IF NOT EXISTS sheets_sync_webhook_events (
  sequence           INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id      TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE CASCADE,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  connection_version INTEGER NOT NULL CHECK (connection_version >= 1),
  event_id            TEXT NOT NULL CHECK (length(event_id) BETWEEN 16 AND 200),
  actor               TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('google_email', 'unavailable')),
  occurred_at         TEXT NOT NULL,
  payload_json        TEXT CHECK (payload_json IS NULL OR (json_valid(payload_json) AND json_type(payload_json) = 'object')),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dead')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at        TEXT NOT NULL,
  processing_token    TEXT,
  processing_expires_at TEXT,
  received_at         TEXT NOT NULL,
  completed_at        TEXT,
  last_error_code     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (connection_id, event_id),
  CHECK ((processing_token IS NULL) = (processing_expires_at IS NULL)),
  CHECK (processing_token IS NULL OR length(processing_token) BETWEEN 8 AND 200),
  CHECK (julianday(occurred_at) IS NOT NULL),
  CHECK (julianday(available_at) IS NOT NULL),
  CHECK (julianday(received_at) IS NOT NULL),
  CHECK (processing_expires_at IS NULL OR julianday(processing_expires_at) IS NOT NULL),
  CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  CHECK (
    (status = 'pending' AND payload_json IS NOT NULL AND completed_at IS NULL)
    OR
    (status IN ('applied', 'dead') AND payload_json IS NULL
      AND processing_token IS NULL AND completed_at IS NOT NULL
      AND actor = 'redacted' AND actor_kind = 'unavailable')
  )
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_webhook_events_pending
  ON sheets_sync_webhook_events
     (line_account_id, connection_id, status, available_at, sequence);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_webhook_events_lifecycle
  ON sheets_sync_webhook_events (status, received_at, sequence);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_webhook_events_terminal
  ON sheets_sync_webhook_events (status, completed_at, sequence);

-- Keep row ownership when settings change without moving to another sheet.
-- This lets a later poll scrub a friend deleted between save and sync. A real
-- target move discards the old sheet's row coordinates instead.
CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_ledger_connection_changed
AFTER UPDATE OF config_version, spreadsheet_id, sheet_name ON sheets_connections
WHEN NEW.config_version <> OLD.config_version
BEGIN DELETE FROM sheets_sync_ledger WHERE connection_id = NEW.id AND (NEW.spreadsheet_id <> OLD.spreadsheet_id OR NEW.sheet_name <> OLD.sheet_name); UPDATE sheets_sync_ledger SET connection_version = NEW.config_version, version = version + 1 WHERE connection_id = NEW.id AND NEW.spreadsheet_id = OLD.spreadsheet_id AND NEW.sheet_name = OLD.sheet_name; END;

-- A settings generation change or removal invalidates the signed target. Clear
-- transient values and editor identity immediately instead of stranding PII in
-- a queue that is no longer eligible for polling.
CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_webhook_events_connection_changed
AFTER UPDATE OF config_version, friend_ledger_enabled, is_active, deleted_at, line_account_id
ON sheets_connections
WHEN NEW.config_version <> OLD.config_version
  OR NEW.friend_ledger_enabled <> OLD.friend_ledger_enabled
  OR NEW.is_active <> OLD.is_active
  OR NEW.deleted_at IS NOT OLD.deleted_at
  OR NEW.line_account_id IS NOT OLD.line_account_id
BEGIN
  UPDATE sheets_sync_webhook_events
  SET status = 'dead', payload_json = NULL, actor = 'redacted', actor_kind = 'unavailable',
      processing_token = NULL, processing_expires_at = NULL,
      completed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
      last_error_code = 'connection_changed'
  WHERE connection_id = NEW.id AND status = 'pending'; END;

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
