CREATE TABLE IF NOT EXISTS friend_field_definitions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  default_value TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_field_definitions_name
  ON friend_field_definitions (name);

CREATE INDEX IF NOT EXISTS idx_friend_field_definitions_active_order
  ON friend_field_definitions (is_active, display_order, id);
