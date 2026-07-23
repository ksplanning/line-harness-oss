-- Freeze the resolved recipients for a broadcast before delivery starts.
-- The table is additive: existing broadcasts and friends are not rewritten.
CREATE TABLE IF NOT EXISTS broadcast_recipient_snapshots (
  broadcast_id  TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_user_id  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (broadcast_id, friend_id)
);
