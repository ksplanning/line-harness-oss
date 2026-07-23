ALTER TABLE formaloo_forms
ADD COLUMN on_submit_actions_json TEXT DEFAULT NULL
  CHECK (
    on_submit_actions_json IS NULL
    OR (
      json_valid(on_submit_actions_json)
      AND json_type(on_submit_actions_json) = 'array'
    )
  );
