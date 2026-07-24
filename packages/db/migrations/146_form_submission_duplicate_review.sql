-- Persist only the operator's row-level review decision. Duplicate groups are
-- derived from active submissions so deleting one side resolves the queue.

ALTER TABLE internal_form_submissions
  ADD COLUMN duplicate_reviewed_at TEXT;

ALTER TABLE formaloo_submissions
  ADD COLUMN duplicate_reviewed_at TEXT;
