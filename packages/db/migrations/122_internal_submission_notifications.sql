-- Migration 122: per-form respondent notifications and internal edit-link state.
-- Legacy submissions are embedded-form responses unless a newer caller records
-- a verified LINE origin (or the fail-closed `invalid` classification).

ALTER TABLE internal_form_submissions
  ADD COLUMN origin_channel TEXT NOT NULL DEFAULT 'embed'
  CHECK (origin_channel IN ('line', 'embed', 'invalid'));

ALTER TABLE internal_form_submissions
  ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 0
  CHECK (edit_version >= 0);

CREATE TABLE IF NOT EXISTS internal_form_notification_settings (
  form_id                  TEXT PRIMARY KEY REFERENCES formaloo_forms (id) ON DELETE CASCADE,
  enabled                  INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  recipient_email_field_id TEXT,
  message_template         TEXT,
  edit_link_epoch          INTEGER NOT NULL DEFAULT 0 CHECK (edit_link_epoch >= 0),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
