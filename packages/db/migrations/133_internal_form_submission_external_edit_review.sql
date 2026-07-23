-- Migration 133: track external edits that still need an administrator review.
-- Existing submissions remain neutral; only successful edit-link or Sheets CAS
-- updates populate these nullable columns.

ALTER TABLE internal_form_submissions ADD COLUMN external_edit_source TEXT
  CHECK (
    external_edit_source IS NULL
    OR external_edit_source IN ('edit_link', 'sheet')
  );

ALTER TABLE internal_form_submissions ADD COLUMN external_edited_at TEXT;

ALTER TABLE internal_form_submissions ADD COLUMN external_edit_approved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_internal_form_submissions_external_edit_review
  ON internal_form_submissions (form_id, external_edit_source, external_edit_approved_at)
  WHERE deleted_at IS NULL;
