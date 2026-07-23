-- Migration 132: durable state for Sheets sync outage and Discord alert timing.
-- Additive-only: existing sync/conflict behavior and rows remain unchanged.

ALTER TABLE sheets_connections ADD COLUMN sync_error_started_at TEXT;
ALTER TABLE sheets_connections ADD COLUMN sync_alerted_at TEXT;
ALTER TABLE sheets_connections ADD COLUMN sync_alert_claimed_at TEXT;
ALTER TABLE sheets_connections ADD COLUMN sync_recovery_pending_at TEXT;
