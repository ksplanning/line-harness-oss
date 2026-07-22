-- Migration 129: form-scoped branch-driver edit permission for respondent edit links.
-- Existing forms remain fail-closed: branch-driving fields cannot be changed until
-- an owner explicitly enables the setting in the builder.

ALTER TABLE formaloo_forms ADD COLUMN allow_branch_edit INTEGER NOT NULL DEFAULT 0;
