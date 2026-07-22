-- Migration 130: retain deleted internal-form answers for recovery while
-- excluding them from every active admin, edit, and Sheets-sync path.

ALTER TABLE internal_form_submissions ADD COLUMN deleted_at TEXT;
