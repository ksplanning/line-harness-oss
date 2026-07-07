-- Migration 087: role_permissions テーブル (G64 / 機能単位 ON/OFF の実体)
--
-- WHY: custom role の機能権限を role_id × feature_key × allowed で保存する。custom role は 19 feature を
--   全て明示 ON/OFF する厳格 allowlist であり、行が無い feature は deny 固定 (base_role へ fallback しない
--   / Codex CRITICAL-1)。これで「チャット対応のみ」ロールが他機能へ漏れる穴を塞ぐ。
--
-- 列の意味:
--   role_id     roles.id (アプリ層で FK 整合 / D1 は migration-time FK off = M-5)。
--   feature_key 19 feature_key のいずれか (packages/shared FEATURE_KEYS)。
--   allowed     1 = 許可 / 0 = 拒否。
--
-- UNIQUE(role_id, feature_key) で 1 ロール 1 feature 1 行を保証 (upsert の土台)。
-- additive のみ (CREATE TABLE / CREATE UNIQUE INDEX は additive-only policy で許可)。

CREATE TABLE IF NOT EXISTS role_permissions (
  id          TEXT PRIMARY KEY,
  role_id     TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  allowed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_role_permissions_role_feature
  ON role_permissions(role_id, feature_key);
