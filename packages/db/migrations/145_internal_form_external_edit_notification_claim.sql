-- Claim the latest edit-link notification before contacting LINE or email.
-- The stored value is the claimed external_edited_at revision, not proof of
-- delivery; a failed provider attempt remains consumed to guarantee at-most-once.

ALTER TABLE internal_form_submissions
  ADD COLUMN external_edit_notification_claimed_for_at TEXT;

ALTER TABLE internal_form_submissions
  ADD COLUMN external_edit_notification_claimed_for_version INTEGER;
