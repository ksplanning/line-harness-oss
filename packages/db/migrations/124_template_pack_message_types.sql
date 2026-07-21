-- Migration 124: outbound message_type CHECK expansion (D-3)
--
-- SQLite cannot widen a column CHECK constraint in place, so this migration
-- rebuilds template_pack_items and broadcasts. A pack is mirrored into
-- broadcasts.message_type from its first item, so broadcasts must accept sticker
-- as well as every pre-existing type. Explicit column lists are intentional:
-- they preserve text/JSON bytes and all 28 canonical runtime broadcast columns.
-- D1's migration runner applies table rebuilds with foreign_keys disabled (the
-- same contract as migration 054), so child rows are not cascade-deleted while
-- broadcasts is replaced. All four broadcast FKs and all three indexes are
-- recreated exactly from the current bootstrap schema.

ALTER TABLE template_pack_items RENAME TO template_pack_items_legacy;

CREATE TABLE template_pack_items (
  id               TEXT PRIMARY KEY,
  pack_id          TEXT NOT NULL REFERENCES template_packs(id) ON DELETE CASCADE,
  order_index      INTEGER NOT NULL,
  message_type     TEXT NOT NULL CHECK (message_type IN ('text', 'flex', 'image', 'video', 'audio', 'sticker', 'imagemap', 'richvideo')),
  message_content  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO template_pack_items (
  id, pack_id, order_index, message_type, message_content, created_at, updated_at
) SELECT
  id, pack_id, order_index, message_type, message_content, created_at, updated_at
FROM template_pack_items_legacy;

DROP TABLE template_pack_items_legacy;

CREATE INDEX IF NOT EXISTS idx_template_pack_items_pack
  ON template_pack_items(pack_id, order_index);

CREATE TABLE broadcasts_new (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video', 'audio', 'sticker', 'imagemap', 'richvideo')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)),
  dedup_progress     TEXT,
  batch_lock_at      TEXT,
  campaign_id        TEXT REFERENCES campaigns (id) ON DELETE SET NULL,
  sender_preset_id   TEXT REFERENCES sender_presets (id) ON DELETE SET NULL,
  ab_test_id         TEXT REFERENCES ab_tests (id) ON DELETE SET NULL,
  ab_variant         TEXT,
  messages           TEXT
);

INSERT INTO broadcasts_new (
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_account_id, alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
  account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at, campaign_id,
  sender_preset_id, ab_test_id, ab_variant, messages
) SELECT
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_account_id, alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
  account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at, campaign_id,
  sender_preset_id, ab_test_id, ab_variant, messages
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status);
CREATE INDEX IF NOT EXISTS idx_broadcasts_campaign ON broadcasts (campaign_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_ab_test_id ON broadcasts (ab_test_id);
