CREATE TABLE IF NOT EXISTS unmatched_questions (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  friend_id        TEXT REFERENCES friends(id) ON DELETE SET NULL,
  question         TEXT NOT NULL,
  top_score        REAL,
  resolved_faq_id  TEXT REFERENCES faqs(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_unmatched_account_created ON unmatched_questions(line_account_id, created_at);
