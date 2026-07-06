-- Migration 076: staff_members に ID/PASS ログイン用の列を additive 追加 (batch F / flex-complete-idpass)
--
-- WHY (管理画面ログインを API キー発行 → ID/PASS 方式へ)
--   owner の要望: 「今 Line ハーネスのログインは API キー発行だが、これを ID PASS 方式に変更して欲しい」。
--   既存の cookie 認証機構 (cookie 値 = api_key) はそのまま流用し、password を「同じ cookie を得る新しい
--   入口」にする (minimal-safe / M-22)。よって本 migration は staff_members に password 列を足すだけで、
--   既存行 (api_key ログイン) の認証は一切変えない (login_id/password は NULL のまま = 現状維持)。
--
-- 列の意味:
--   login_id            正規化済みログイン ID (LOWER(TRIM()) して保存 / GC-5)。未設定は NULL。
--   password_hash       PBKDF2-SHA256 ハッシュ (hex)。平文は保存しない。
--   password_salt       ソルト (hex, 16B)。
--   password_algo       ハッシュ方式ラベル (将来の方式移行に備える)。既定 'pbkdf2-sha256'。
--   password_iterations PBKDF2 反復回数 (明示保存 = 将来の強度引き上げに耐える)。
--   password_updated_at 最終パスワード変更時刻 (JST 文字列)。
--   failed_login_count  連続ログイン失敗回数 (D1 権威 lockout / M-23)。既定 0。
--   locked_until        この時刻まで account を lock (JST 文字列 / julianday 比較 / M-4)。NULL = 未 lock。
--
-- additive のみ (ADD COLUMN・NULL 許容 or DEFAULT つき)。CREATE UNIQUE INDEX は additive-only policy で
--   明示的に許可される経路 (ADD UNIQUE 制約ではない / check-migrations 準拠)。partial index (WHERE
--   login_id IS NOT NULL) なので既存行 (login_id=NULL) は衝突せず、UNIQUE 違反は運用時の重複登録でのみ出る。

ALTER TABLE staff_members ADD COLUMN login_id TEXT;
ALTER TABLE staff_members ADD COLUMN password_hash TEXT;
ALTER TABLE staff_members ADD COLUMN password_salt TEXT;
ALTER TABLE staff_members ADD COLUMN password_algo TEXT DEFAULT 'pbkdf2-sha256';
ALTER TABLE staff_members ADD COLUMN password_iterations INTEGER;
ALTER TABLE staff_members ADD COLUMN password_updated_at TEXT;
ALTER TABLE staff_members ADD COLUMN failed_login_count INTEGER DEFAULT 0;
ALTER TABLE staff_members ADD COLUMN locked_until TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_members_login_id
  ON staff_members(login_id) WHERE login_id IS NOT NULL;
