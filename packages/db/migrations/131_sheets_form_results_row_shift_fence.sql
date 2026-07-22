-- A successful physical row deletion shifts every lower Google Sheets row.
-- Keep a dedicated fence so queued row-number webhooks can be rejected
-- without treating an unrelated failed sync as a structural generation.
ALTER TABLE sheets_connections ADD COLUMN form_results_row_shifted_at TEXT;

-- Set before the external delete call. If its response is lost, this
-- conservative upper bound keeps old row-number webhooks fail-closed.
ALTER TABLE sheets_connections ADD COLUMN form_results_row_shift_pending_until TEXT;
