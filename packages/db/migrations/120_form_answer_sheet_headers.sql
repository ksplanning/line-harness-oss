-- Persist the form-build-driven answer headings separately from the friend
-- ledger headings. This snapshot lets sync detect owner-renamed headings
-- without treating them as missing generated columns.
ALTER TABLE sheets_connections
  ADD COLUMN form_answer_headers_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(form_answer_headers_json)
    AND json_type(form_answer_headers_json) = 'array'
  );
