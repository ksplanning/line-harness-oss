-- Migration 103: form-edit-mail Phase B — Formaloo submit-time receipt metadata mirror.
-- Additive nullable columns only. Existing submissions remain valid and retries with missing metadata
-- preserve the first captured values in the DAO (COALESCE(existing, excluded)).

ALTER TABLE formaloo_submissions ADD COLUMN tracking_code TEXT;
ALTER TABLE formaloo_submissions ADD COLUMN submit_number TEXT;
ALTER TABLE formaloo_submissions ADD COLUMN pdf_link TEXT;
