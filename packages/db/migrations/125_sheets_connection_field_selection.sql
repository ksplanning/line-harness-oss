-- NULL preserves the legacy behavior: every eligible form field is synced.
-- A JSON array records an explicit selection, including [] for no form fields.
ALTER TABLE sheets_connections
  ADD COLUMN selected_form_field_ids_json TEXT
  CHECK (
    selected_form_field_ids_json IS NULL
    OR (
      json_valid(selected_form_field_ids_json)
      AND json_type(selected_form_field_ids_json) = 'array'
    )
  );
