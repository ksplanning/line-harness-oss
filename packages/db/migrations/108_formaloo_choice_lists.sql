-- treasure-b3-calc-dynamic: Harness-managed source lists for Formaloo choice_fetch fields.
-- Additive only. The public endpoint resolves rows by both form_id and list id.
CREATE TABLE IF NOT EXISTS formaloo_choice_lists (
  id         TEXT PRIMARY KEY,
  form_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_formaloo_choice_lists_form
  ON formaloo_choice_lists (form_id, updated_at);
