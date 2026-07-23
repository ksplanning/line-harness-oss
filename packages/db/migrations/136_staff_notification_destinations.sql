-- Migration 135: account-scoped, pluggable staff notification destinations.
-- LINE linkage is intentionally isolated from the customer-facing friends table.

CREATE TABLE IF NOT EXISTS staff_notification_destinations (
  id                         TEXT NOT NULL PRIMARY KEY,
  line_account_id            TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  label                      TEXT NOT NULL,
  channel_type               TEXT NOT NULL CHECK (length(trim(channel_type)) > 0),
  config_json                TEXT NOT NULL DEFAULT '{}'
                             CHECK (
                               json_valid(config_json)
                               AND json_type(config_json) = 'object'
                             ),
  notify_inquiry             INTEGER NOT NULL DEFAULT 1 CHECK (notify_inquiry IN (0, 1)),
  notify_form_submission     INTEGER NOT NULL DEFAULT 1 CHECK (notify_form_submission IN (0, 1)),
  enabled                    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  line_user_id               TEXT,
  line_link_code_digest      TEXT,
  line_link_code_expires_at  TEXT,
  line_linked_at             TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_staff_notification_destinations_account
  ON staff_notification_destinations (line_account_id, enabled, channel_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notification_destinations_line_user
  ON staff_notification_destinations (line_account_id, line_user_id)
  WHERE channel_type = 'line' AND line_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notification_destinations_line_code
  ON staff_notification_destinations (line_account_id, line_link_code_digest)
  WHERE channel_type = 'line' AND line_link_code_digest IS NOT NULL;

CREATE TABLE IF NOT EXISTS staff_notification_delivery_logs (
  id               TEXT NOT NULL PRIMARY KEY,
  destination_id   TEXT REFERENCES staff_notification_destinations (id) ON DELETE SET NULL,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  status           TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_code       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_staff_notification_delivery_logs_account
  ON staff_notification_delivery_logs (line_account_id, created_at);
