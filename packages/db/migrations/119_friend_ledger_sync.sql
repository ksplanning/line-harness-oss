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
  ON sheets_sync_audit_log (connection_id, webhook_event_id, IFNULL(record_key, ''))
  WHERE webhook_event_id IS NOT NULL;

-- Signed onEdit snapshots are accepted durably before attempting the sync.
-- Applied/dead rows retain only the event-id tombstone; payload_json (which may
-- temporarily contain a cell value) is erased on terminal completion.
CREATE TABLE IF NOT EXISTS sheets_sync_webhook_events (
  sequence           INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id      TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE CASCADE,
  line_account_id    TEXT NOT NULL,
  connection_version INTEGER NOT NULL CHECK (connection_version >= 1),
  event_id            TEXT NOT NULL CHECK (length(event_id) BETWEEN 16 AND 200),
  actor               TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('google_email', 'unavailable')),
  occurred_at         TEXT NOT NULL,
  payload_json        TEXT CHECK (payload_json IS NULL OR (json_valid(payload_json) AND json_type(payload_json) = 'object')),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dead')),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at        TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  applied_at          TEXT,
  last_error_code     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (connection_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_webhook_events_pending
  ON sheets_sync_webhook_events
     (line_account_id, connection_id, status, available_at, sequence);

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
