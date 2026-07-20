-- Rebuild messages_log so databases that previously ran migration 009 accept
-- delivery_type='test'. Migration 026 only documented the intent and did not
-- alter SQLite's CHECK constraint.
CREATE TABLE messages_log_with_test (
  id                  TEXT PRIMARY KEY,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type        TEXT NOT NULL,
  content             TEXT NOT NULL,
  broadcast_id        TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  scenario_step_id    TEXT REFERENCES scenario_steps (id) ON DELETE SET NULL,
  template_id_at_send TEXT,
  delivery_type       TEXT CHECK (delivery_type IN ('push', 'reply', 'test')),
  source              TEXT,
  line_account_id     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO messages_log_with_test (
  id, friend_id, direction, message_type, content, broadcast_id,
  scenario_step_id, template_id_at_send, delivery_type, source,
  line_account_id, created_at
)
SELECT
  id, friend_id, direction, message_type, content, broadcast_id,
  scenario_step_id, template_id_at_send, delivery_type, source,
  line_account_id, created_at
FROM messages_log;

DROP TABLE messages_log;
ALTER TABLE messages_log_with_test RENAME TO messages_log;

CREATE INDEX IF NOT EXISTS idx_messages_log_broadcast_id ON messages_log (broadcast_id);
CREATE INDEX IF NOT EXISTS idx_messages_log_friend_id ON messages_log (friend_id);
CREATE INDEX IF NOT EXISTS idx_messages_log_created_at ON messages_log (created_at);
CREATE INDEX IF NOT EXISTS idx_messages_log_friend_source ON messages_log (friend_id, source);
CREATE INDEX IF NOT EXISTS idx_messages_log_friend_direction_created ON messages_log (friend_id, direction, created_at);

-- A client-generated operation key is atomically claimed before any LINE call.
-- Replays return the cached result and concurrent duplicates never send twice.
CREATE TABLE IF NOT EXISTS test_send_requests (
  idempotency_key TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  source           TEXT NOT NULL,
  request_payload  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
  response_json    TEXT,
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_test_send_requests_account_created
  ON test_send_requests (line_account_id, created_at);
