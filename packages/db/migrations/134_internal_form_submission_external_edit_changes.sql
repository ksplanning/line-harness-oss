-- Migration 134: keep the changed-field snapshot for the latest external edit.
-- Existing submissions stay neutral; edit-link and Sheets CAS updates replace
-- this nullable display-only history without copying the full answer object.

ALTER TABLE internal_form_submissions ADD COLUMN external_edit_changes_json TEXT;
