-- 122_friend_imports.sql
-- Verified/premium LINE accounts can enumerate existing followers. Persist the
-- import as a resumable, account-scoped job and keep an append-only audit trail.
-- Existing friends are never updated by this migration or by the import path.

ALTER TABLE friends ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_friends_source
  ON friends (source);

CREATE TABLE IF NOT EXISTS friend_import_jobs (
  id                      TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running', 'completed', 'failed')),
  phase                   TEXT NOT NULL DEFAULT 'followers'
                          CHECK (phase IN ('followers', 'profiles', 'completed')),
  continuation_token      TEXT,
  fetched_count           INTEGER NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  new_count               INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  existing_count          INTEGER NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
  profile_processed_count INTEGER NOT NULL DEFAULT 0 CHECK (profile_processed_count >= 0),
  failed_count            INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  next_run_at             TEXT,
  lock_token              TEXT,
  locked_until            TEXT,
  last_error_code         TEXT,
  last_error              TEXT,
  requested_by_id         TEXT NOT NULL,
  requested_by_name       TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_import_jobs_one_running
  ON friend_import_jobs (account_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_friend_import_jobs_latest
  ON friend_import_jobs (account_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS friend_import_items (
  job_id         TEXT NOT NULL REFERENCES friend_import_jobs (id) ON DELETE CASCADE,
  line_user_id   TEXT NOT NULL,
  friend_id      TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('new', 'existing', 'conflict')),
  profile_status TEXT NOT NULL CHECK (profile_status IN ('pending', 'succeeded', 'failed', 'not_required')),
  profile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (profile_attempts >= 0),
  next_attempt_at TEXT,
  error_message  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (job_id, line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_import_items_profiles
  ON friend_import_items (job_id, outcome, profile_status, next_attempt_at, line_user_id);

CREATE TABLE IF NOT EXISTS friend_import_audit_log (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES friend_import_jobs (id) ON DELETE RESTRICT,
  account_id     TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  actor_name     TEXT NOT NULL,
  new_count      INTEGER NOT NULL CHECK (new_count >= 0),
  existing_count INTEGER NOT NULL CHECK (existing_count >= 0),
  failed_count   INTEGER NOT NULL CHECK (failed_count >= 0),
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_friend_import_audit_account
  ON friend_import_audit_log (account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_friend_import_audit_job
  ON friend_import_audit_log (job_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS trg_friend_import_audit_no_update BEFORE UPDATE ON friend_import_audit_log BEGIN SELECT RAISE(ABORT, 'friend_import_audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_friend_import_audit_no_delete BEFORE DELETE ON friend_import_audit_log BEGIN SELECT RAISE(ABORT, 'friend_import_audit_log is append-only'); END;
