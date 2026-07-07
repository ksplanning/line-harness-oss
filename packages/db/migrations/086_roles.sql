-- Migration 086: roles テーブル (G64 / カスタムロール + 機能単位 ON/OFF 権限)
--
-- WHY: owner が「顧客対応のみ」等のカスタムロールを自分で作れるようにする。built-in の
--   owner/admin/staff 3 preset は「コード定数」(worker BUILTIN_ROLE_PRESETS) として凍結し、
--   本テーブルには owner が作った custom role のみが入る (既存挙動を 1 バイトも変えない)。
--
-- 列の意味:
--   name        表示名 (例「チャット対応のみ」)。
--   description 素人向けの説明 (任意)。
--   base_role   custom role 作成時にマトリクス初期値をどの preset からコピーするかの「出発点」だけを表す。
--               ⚠️ runtime の未列挙 feature fallback には使わない (custom role は 19 feature を全て
--               role_permissions に明示保存し、行が無い feature は deny / Codex CRITICAL-1)。
--   is_builtin  予約列 (通常 custom は 0)。built-in はコード定数なので基本 0 のみ。
--
-- additive のみ (CREATE TABLE IF NOT EXISTS)。DROP/RENAME/CHECK 拡張なし = check-migrations 準拠。

CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  base_role   TEXT NOT NULL DEFAULT 'staff',
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
