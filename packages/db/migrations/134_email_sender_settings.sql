-- Migration 134: per-LINE-account sender identity and public Resend domain state.
-- API credentials are intentionally not persisted; DNS records are public setup data.

CREATE TABLE IF NOT EXISTS email_sender_settings (
  line_account_id       TEXT NOT NULL PRIMARY KEY REFERENCES line_accounts (id) ON DELETE CASCADE,
  sender_email          TEXT NOT NULL,
  sender_name           TEXT,
  sender_domain         TEXT NOT NULL,
  resend_domain_id      TEXT,
  resend_domain_status  TEXT NOT NULL DEFAULT 'not_started',
  dns_records_json      TEXT NOT NULL DEFAULT '[]'
                        CHECK (
                          json_valid(dns_records_json)
                          AND json_type(dns_records_json) = 'array'
                        ),
  domain_checked_at     TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
