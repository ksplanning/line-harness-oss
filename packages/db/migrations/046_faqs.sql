CREATE TABLE IF NOT EXISTS faqs (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  question         TEXT NOT NULL,
  variants         TEXT NOT NULL DEFAULT '[]',
  answer           TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  hit_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
  -- Phase B reserved (add with additive ALTER in Phase B):
  --   answer_type TEXT DEFAULT 'text'
  --   embedding   BLOB
  --   source_doc_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_faqs_account_active ON faqs(line_account_id, is_active);
