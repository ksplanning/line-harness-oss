-- Migration 114: self-hosted Google Sheets connection foundation.
--
-- This migration is deliberately independent of reserved migration 113/W1:
-- form_id stays opaque until the internal form/submission tables land.
-- Credentials are never stored in D1; the service-account JSON is a Worker secret.
-- This adds settings, a row fingerprint ledger, and immutable audit events only.
-- The recurring bidirectional sync engine belongs to W4 proper.
-- ============================================================
-- Self-hosted Google Sheets connections (migration 114)
-- Connection settings are independent of migration 113/W1. form_id is an
-- opaque application identifier until the internal-forms schema is available.
-- ============================================================
CREATE TABLE IF NOT EXISTS sheets_connections (
  id              TEXT PRIMARY KEY,
  -- Keep the connection/audit chain when an account is removed. The orphan
  -- trigger below deactivates the setting so it can never be synchronized.
  line_account_id TEXT REFERENCES line_accounts (id) ON DELETE SET NULL,
  form_id         TEXT NOT NULL CHECK (length(form_id) BETWEEN 1 AND 200),
  spreadsheet_id  TEXT NOT NULL CHECK (length(spreadsheet_id) BETWEEN 1 AND 512),
  sheet_name      TEXT NOT NULL DEFAULT 'Sheet1' CHECK (length(sheet_name) BETWEEN 1 AND 200),
  sync_direction  TEXT NOT NULL DEFAULT 'bidirectional'
                  CHECK (sync_direction IN ('to_sheets', 'from_sheets', 'bidirectional')),
  conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
                  CHECK (conflict_policy = 'last_write_wins'),
  -- LWW is ordered by a Worker-assigned sequence when a write is accepted.
  -- Sheets values.get exposes no trustworthy human-edit timestamp, so wall-clock
  -- observation time is deliberately not the conflict clock.
  conflict_clock  TEXT NOT NULL DEFAULT 'server_sequence'
                  CHECK (conflict_clock = 'server_sequence'),
  config_version  INTEGER NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  next_sync_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sync_sequence >= 1),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  deleted_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_connections_active_form
  ON sheets_connections (line_account_id, form_id)
  WHERE is_active = 1 AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sheets_connections_account
  ON sheets_connections (line_account_id, is_active, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_sheets_connections_orphan_deactivate
AFTER UPDATE OF line_account_id ON sheets_connections
WHEN NEW.line_account_id IS NULL AND NEW.is_active = 1
BEGIN DELETE FROM sheets_sync_ledger WHERE connection_id = NEW.id; UPDATE sheets_connections SET is_active = 0, deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE id = NEW.id; END;

-- One durable fingerprint per Harness record. This is only the ledger/data
-- shape; the polling/apply engine is deliberately deferred to W4 proper.
CREATE TABLE IF NOT EXISTS sheets_sync_ledger (
  connection_id      TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE CASCADE,
  connection_version INTEGER NOT NULL DEFAULT 1 CHECK (connection_version >= 1),
  record_key         TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 200),
  sheet_row_number   INTEGER CHECK (sheet_row_number IS NULL OR sheet_row_number >= 1),
  row_fingerprint    TEXT NOT NULL CHECK (length(row_fingerprint) BETWEEN 1 AND 256),
  harness_updated_at TEXT,
  -- API observation time is diagnostic only and is never used as the conflict clock.
  sheet_observed_at  TEXT,
  last_synced_at     TEXT NOT NULL,
  last_sync_direction TEXT NOT NULL CHECK (last_sync_direction IN ('to_sheets', 'from_sheets')),
  last_applied_sequence INTEGER NOT NULL CHECK (last_applied_sequence >= 1),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (connection_id, record_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_ledger_row
  ON sheets_sync_ledger (connection_id, sheet_row_number)
  WHERE sheet_row_number IS NOT NULL;

-- A delayed worker from an old configuration generation must fail closed.
CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_ledger_version_insert
BEFORE INSERT ON sheets_sync_ledger
WHEN NOT EXISTS (SELECT 1 FROM sheets_connections WHERE id = NEW.connection_id AND config_version = NEW.connection_version AND is_active = 1 AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_ledger connection version mismatch'); END;

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_ledger_version_update
BEFORE UPDATE ON sheets_sync_ledger
WHEN NOT EXISTS (SELECT 1 FROM sheets_connections WHERE id = NEW.connection_id AND config_version = NEW.connection_version AND is_active = 1 AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_ledger connection version mismatch'); END;

-- Append-only audit events. No updated_at column is intentional: conflict
-- decisions remain immutable evidence for last-write-wins reconciliation.
CREATE TABLE IF NOT EXISTS sheets_sync_audit_log (
  id                   TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE RESTRICT,
  connection_version   INTEGER NOT NULL CHECK (connection_version >= 1),
  apply_sequence       INTEGER NOT NULL CHECK (apply_sequence >= 1),
  -- Immutable target snapshot: later connection edits cannot rewrite history.
  line_account_id      TEXT NOT NULL,
  form_id              TEXT NOT NULL,
  spreadsheet_id       TEXT NOT NULL,
  sheet_name           TEXT NOT NULL,
  record_key           TEXT,
  sheet_row_number      INTEGER CHECK (sheet_row_number IS NULL OR sheet_row_number >= 1),
  direction             TEXT NOT NULL CHECK (direction IN ('to_sheets', 'from_sheets')),
  action                TEXT NOT NULL CHECK (action IN ('append', 'read', 'update', 'conflict')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('applied', 'skipped', 'failed')),
  conflict_resolution   TEXT CHECK (
    conflict_resolution IS NULL OR conflict_resolution IN ('harness_wins', 'sheet_wins', 'same_sequence')
  ),
  harness_updated_at    TEXT,
  sheet_observed_at     TEXT,
  before_fingerprint   TEXT,
  after_fingerprint    TEXT,
  error_code            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_audit_connection
  ON sheets_sync_audit_log (connection_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_audit_sequence
  ON sheets_sync_audit_log (connection_id, connection_version, apply_sequence);

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_audit_no_replace
BEFORE INSERT ON sheets_sync_audit_log
WHEN EXISTS (SELECT 1 FROM sheets_sync_audit_log WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_audit_no_update
BEFORE UPDATE ON sheets_sync_audit_log
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS trg_sheets_sync_audit_no_delete
BEFORE DELETE ON sheets_sync_audit_log
BEGIN SELECT RAISE(ABORT, 'sheets_sync_audit_log is append-only'); END;
