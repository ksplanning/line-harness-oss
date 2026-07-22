-- Durable, resumable progress for bounded friend-ledger synchronization.
CREATE TABLE IF NOT EXISTS sheets_sync_jobs (
  id                         TEXT PRIMARY KEY,
  connection_id              TEXT NOT NULL REFERENCES sheets_connections (id) ON DELETE RESTRICT,
  line_account_id            TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  config_version             INTEGER NOT NULL CHECK (config_version >= 1),
  source                     TEXT NOT NULL CHECK (source IN ('manual', 'polling', 'webhook')),
  actor                      TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 320),
  status                     TEXT NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running', 'completed', 'warning', 'failed')),
  total_count                INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count            INTEGER NOT NULL DEFAULT 0
                             CHECK (processed_count >= 0 AND processed_count <= total_count),
  last_friend_created_at     TEXT,
  last_record_key            TEXT,
  snapshot_friend_created_at TEXT,
  snapshot_record_key        TEXT,
  appended_rows              INTEGER NOT NULL DEFAULT 0 CHECK (appended_rows >= 0),
  updated_rows               INTEGER NOT NULL DEFAULT 0 CHECK (updated_rows >= 0),
  imported_fields            INTEGER NOT NULL DEFAULT 0 CHECK (imported_fields >= 0),
  ignored_identity_edits     INTEGER NOT NULL DEFAULT 0 CHECK (ignored_identity_edits >= 0),
  warning_message            TEXT CHECK (warning_message IS NULL OR length(warning_message) <= 500),
  error_code                 TEXT CHECK (error_code IS NULL OR length(error_code) <= 100),
  error_message              TEXT CHECK (error_message IS NULL OR length(error_message) <= 500),
  lock_token                 TEXT,
  locked_until               TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at               TEXT,
  CHECK ((lock_token IS NULL) = (locked_until IS NULL)),
  CHECK ((snapshot_friend_created_at IS NULL) = (snapshot_record_key IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_sync_jobs_one_running
  ON sheets_sync_jobs (connection_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_sheets_sync_jobs_runnable
  ON sheets_sync_jobs (status, locked_until, created_at, id);

CREATE INDEX IF NOT EXISTS idx_sheets_sync_jobs_connection_history
  ON sheets_sync_jobs (line_account_id, connection_id, created_at DESC, id DESC);
