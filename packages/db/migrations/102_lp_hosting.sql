-- harness-lp-hosting (Phase 1) — LP 置き場 registry + 閲覧計測。
-- additive-only: 既存テーブル無改変・CREATE TABLE IF NOT EXISTS で冪等 (再 apply 安全 / R-g)。
-- LP 実体 (HTML/asset の bytes) は R2 (lp/<slug>/ prefix) に置く。ここには metadata のみ (D-1)。

-- LP registry: slug が公開 URL のキー (worker 配下 /lp/:slug)。
--   status=active のみ公開 serve・stopped は 404 (status flip が serve を制御 / T-A5)。
--   entry_key = index.html の R2 key (upload 時に記録 / 未 upload は NULL)。
CREATE TABLE IF NOT EXISTS lp_pages (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  entry_key  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- LP 閲覧イベント: 匿名は常に記録 (friend_id NULL)・有効トークン時のみ friend 紐付き (§spec J)。
--   friend_name は記録時点の表示名を非正規化保持 (form_opens 型)。referrer は任意。
CREATE TABLE IF NOT EXISTS lp_views (
  id          TEXT PRIMARY KEY,
  lp_slug     TEXT NOT NULL,
  friend_id   TEXT,
  friend_name TEXT,
  referrer    TEXT,
  viewed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_lp_views_slug ON lp_views (lp_slug, viewed_at);
CREATE INDEX IF NOT EXISTS idx_lp_views_friend ON lp_views (friend_id);
