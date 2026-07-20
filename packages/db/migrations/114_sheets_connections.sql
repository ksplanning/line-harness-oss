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
  line_account_id TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  form_id         TEXT NOT NULL CHECK (length(form_id) BETWEEN 1 AND 200),
  spreadsheet_id  TEXT NOT NULL CHECK (length(spreadsheet_id) BETWEEN 1 AND 512),
  sheet_name      TEXT NOT NULL DEFAULT 'Sheet1' CHECK (length(sheet_name) BETWEEN 1 AND 200),
  sync_direction  TEXT NOT NULL DEFAULT 'bidirectional'
                  CHECK (sync_direction IN ('to_sheets', 'from_sheets', 'bidirectional')),
  conflict_policy TEXT NOT NULL DEFAULT 'last_write_wins'
                  CHECK (conflict_policy = 'last_write_wins'),
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

-- One durable fingerprint per Harness record. This is only the ledger/data
-- shape; the polling/apply engine is deliberately deferred to W4 proper.
CREATE TABLE IF NOT EXISTS sheets_sync_ledger (
  connection_id      TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE CASCADE,
  record_key         TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 200),
  sheet_row_number   INTEGER CHECK (sheet_row_number IS NULL OR sheet_row_number >= 1),
  row_fingerprint    TEXT NOT NULL CHECK (length(row_fingerprint) BETWEEN 1 AND 256),
  harness_updated_at TEXT,
  sheet_updated_at   TEXT,
  last_synced_at     TEXT NOT NULL,
  last_sync_direction TEXT NOT NULL CHECK (last_sync_direction IN ('to_sheets', 'from_sheets')),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (connection_id, record_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_ledger_row
  ON sheets_sync_ledger (connection_id, sheet_row_number)
  WHERE sheet_row_number IS NOT NULL;

-- Append-only audit events. No updated_at column is intentional: conflict
-- decisions remain immutable evidence for last-write-wins reconciliation.
CREATE TABLE IF NOT EXISTS sheets_sync_audit_log (
  id                   TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE RESTRICT,
  record_key           TEXT,
  sheet_row_number      INTEGER CHECK (sheet_row_number IS NULL OR sheet_row_number >= 1),
  direction             TEXT NOT NULL CHECK (direction IN ('to_sheets', 'from_sheets')),
  action                TEXT NOT NULL CHECK (action IN ('append', 'read', 'update', 'conflict')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('applied', 'skipped', 'failed')),
  conflict_resolution   TEXT CHECK (
    conflict_resolution IS NULL OR conflict_resolution IN ('harness_wins', 'sheet_wins', 'timestamps_equal')
  ),
  harness_updated_at    TEXT,
  sheet_updated_at      TEXT,
  before_fingerprint   TEXT,
  after_fingerprint    TEXT,
  error_code            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_audit_connection
  ON sheets_sync_audit_log (connection_id, created_at);
