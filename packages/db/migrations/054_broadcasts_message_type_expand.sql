-- Migration 054: broadcasts.message_type CHECK 拡張 (F2 batch3 G4/G13/G14)
--
-- WHY
--   broadcasts.message_type は列 CHECK `IN ('text','image','flex')` を持つ。動画(video)/
--   音声(audio)/リッチメッセージ(imagemap)/リッチビデオ(richvideo) を配信できるよう CHECK を
--   広げる。SQLite は列 CHECK を ALTER で変更できない (migrations/027, 029 と同じ壁) ため、
--   表 rebuild (CREATE _new + INSERT SELECT + DROP + RENAME) が唯一の手段。
--
-- 最高リスク migration の安全弁 (spec §CHECK 拡張の方針判断 / Codex 独立チェック反映):
--   [1][2] 列テンプレの正典は bootstrap.sql の実行時集合 (= 053 適用済 broadcasts の 24 列)。
--          029(18列) や schema.sql(broadcasts で drift 済) をコピーしない。取りこぼし = データ喪失。
--          dedup_progress(030)/batch_lock_at(031)/campaign_id(052) を 1 列も落とさない。
--   [3]    sender 列は含めない。sender は 055 (054 の後) で sender_presets 表 + sender_preset_id
--          として additive に追加されるため、054 時点の broadcasts には存在しない。
--   [4]    in-migration PRAGMA foreign_keys トグルは書かない (D1 のトランザクション内で no-op)。
--          FK 保全は D1 が migration-time に FK 強制を停止する挙動に依る (029 rebuild が本番で
--          broadcast_insights を消さず生存した実証)。
--   [5]    scripts/check-migrations.ts の additive-only gate (POLICY_CUTOFF=041) は DROP/RENAME を
--          禁止するため、054 を documented 単一ファイル例外に登録済 (DOCUMENTED_REBUILD_EXCEPTIONS)。
--   本番   full replay 経路で 1 回だけ適用する (`--additive-only` は CHECK widen を適用できない)。
--          適用前に backup を取り、`_migrations` 台帳で 054 適用済なら runner がスキップして再 DROP しない。
--
-- FK 子表: broadcast_insights(broadcast_id → broadcasts ON DELETE CASCADE) /
--          messages_log(broadcast_id → broadcasts ON DELETE SET NULL)。
--          migration-time FK-off ゆえ DROP TABLE broadcasts は CASCADE を発火させず子行を保つ。
--          migration test が FK OFF(D1 パリティ)/ON(防御的・foreign_key_check 無違反) の両ケースで固定。

CREATE TABLE broadcasts_new (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video', 'audio', 'imagemap', 'richvideo')),
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
  campaign_id        TEXT REFERENCES campaigns (id) ON DELETE SET NULL
);

-- 明示列リスト (SELECT * を使わない・取りこぼし = その列のデータ喪失)。
-- 24 列 = bootstrap.sql の broadcasts 実行時集合と完全一致 (sender 列は非包含)。
INSERT INTO broadcasts_new (
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_account_id, alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
  account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at, campaign_id
) SELECT
  id, title, message_type, message_content, target_type, target_tag_id, status,
  scheduled_at, sent_at, total_count, success_count, created_at,
  line_account_id, alt_text, line_request_id, aggregation_unit, batch_offset, segment_conditions,
  account_ids, dedup_priority, failed_account_ids, dedup_progress, batch_lock_at, campaign_id
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;

-- 既存 index を再作成 (bootstrap.sql と同一)。
CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts (status);
CREATE INDEX IF NOT EXISTS idx_broadcasts_campaign ON broadcasts (campaign_id);
