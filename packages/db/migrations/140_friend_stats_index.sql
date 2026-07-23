-- Friend statistics are read by account and bounded registration date.
-- This additive index keeps the 30/90-day trend query off a full friends scan.
CREATE INDEX IF NOT EXISTS idx_friends_account_created
  ON friends (line_account_id, created_at);
