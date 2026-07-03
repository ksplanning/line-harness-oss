-- 049_saved_searches.sql (G10 保存済み検索 / セグメント)
--
-- 友だち絞込条件を名前付きで保存・再利用する additive-only テーブル。
-- conditions は broadcast が消費する SegmentCondition JSON ({operator, rules[]}) と同一形式
-- (将来 broadcast の配信対象選択へ流用する橋渡し)。破壊操作ゼロ。
-- 同一 DDL が packages/db/schema.sql (正本) にもある (schema replay とのドリフト防止)。
CREATE TABLE IF NOT EXISTS saved_searches (
  id               TEXT PRIMARY KEY,
  line_account_id  TEXT DEFAULT NULL,
  name             TEXT NOT NULL,
  conditions       TEXT NOT NULL DEFAULT '{"operator":"AND","rules":[]}',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_account ON saved_searches(line_account_id);
