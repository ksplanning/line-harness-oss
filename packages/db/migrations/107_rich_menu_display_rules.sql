-- Conditional rich-menu rules (account-scoped). No rule-count limit is imposed.
CREATE TABLE IF NOT EXISTS rich_menu_display_rules (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  condition_type  TEXT NOT NULL CHECK (condition_type IN ('tag_exists', 'tag_not_exists', 'metadata_equals', 'metadata_not_equals', 'metadata_contains', 'metadata_not_contains', 'tag_name_contains', 'tag_name_not_contains')),
  condition_value TEXT NOT NULL CHECK (length(condition_value) BETWEEN 1 AND 10000),
  rich_menu_id    TEXT NOT NULL CHECK (length(rich_menu_id) BETWEEN 1 AND 200),
  priority        INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000000 AND 1000000),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- Successful per-friend state. rich_menu_id=NULL means the per-user override was removed.
CREATE TABLE IF NOT EXISTS rich_menu_friend_assignments (
  friend_id    TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  rule_id      TEXT REFERENCES rich_menu_display_rules(id) ON DELETE SET NULL,
  rich_menu_id TEXT,
  applied_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- Dirty-friend queue. One row per friend deduplicates rapid tag/metadata changes.
CREATE TABLE IF NOT EXISTS rich_menu_rule_evaluation_queue (
  friend_id    TEXT PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- Account sweep jobs are processed in bounded cron batches.
CREATE TABLE IF NOT EXISTS rich_menu_rule_reapply_jobs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed')),
  total_count     INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  applied_count   INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  skipped_count   INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count    INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  last_friend_id  TEXT,
  locked_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_rich_menu_display_rules_winner
  ON rich_menu_display_rules(account_id, is_active, priority DESC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_rich_menu_friend_assignments_account
  ON rich_menu_friend_assignments(account_id, friend_id);
CREATE INDEX IF NOT EXISTS idx_rich_menu_rule_queue_ready
  ON rich_menu_rule_evaluation_queue(available_at, friend_id);
CREATE INDEX IF NOT EXISTS idx_rich_menu_rule_reapply_jobs_latest
  ON rich_menu_rule_reapply_jobs(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rich_menu_rule_reapply_jobs_one_running
  ON rich_menu_rule_reapply_jobs(account_id) WHERE status = 'running';

CREATE TRIGGER IF NOT EXISTS trg_rich_menu_rule_tag_insert AFTER INSERT ON friend_tags BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, updated_at) VALUES (NEW.friend_id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at; END;
CREATE TRIGGER IF NOT EXISTS trg_rich_menu_rule_tag_delete AFTER DELETE ON friend_tags BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, updated_at) SELECT OLD.friend_id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') WHERE EXISTS (SELECT 1 FROM friends WHERE id = OLD.friend_id) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at; END;
CREATE TRIGGER IF NOT EXISTS trg_rich_menu_rule_tag_name_update AFTER UPDATE OF name ON tags WHEN OLD.name IS NOT NEW.name BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, updated_at) SELECT ft.friend_id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') FROM friend_tags ft WHERE ft.tag_id = NEW.id ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at; END;
CREATE TRIGGER IF NOT EXISTS trg_rich_menu_rule_friend_update AFTER UPDATE OF metadata, line_account_id ON friends WHEN OLD.metadata IS NOT NEW.metadata OR OLD.line_account_id IS NOT NEW.line_account_id BEGIN INSERT INTO rich_menu_rule_evaluation_queue (friend_id, attempts, available_at, last_error, updated_at) VALUES (NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'), NULL, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')) ON CONFLICT(friend_id) DO UPDATE SET attempts = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at; END;
