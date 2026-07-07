-- Migration 088: staff_members.role_id (G64 / staff の所属カスタムロール)
--
-- WHY: staff に custom role を割り当てる FK。**NULL = built-in preset (既存 enum staff_members.role) で
--   従来通り解決** = 既存 staff 行 (全て role_id=NULL) の挙動は 1 バイトも変わらない (回帰ゼロの要)。
--   role_id が設定された時だけ custom role の権限 (role_permissions) が適用される。
--
-- additive のみ (ADD COLUMN nullable / CREATE INDEX IF NOT EXISTS)。既存行に影響しない (DEFAULT NULL)。
-- D1 FK は migration-time off = M-5。roles.id との整合はアプリ層 (削除時の再割当 / 孤児防止 = §5) で担保。

ALTER TABLE staff_members ADD COLUMN role_id TEXT;

CREATE INDEX IF NOT EXISTS idx_staff_members_role_id ON staff_members(role_id);
