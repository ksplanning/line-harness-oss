-- Migration 056: ab_tests (A/B テスト配信) + broadcasts.ab_test_id / ab_variant (F2 batch4 G1)
--
-- WHY (A/B テスト = 2 案を分割配信 → 開封率/クリック率で勝ちを判定 → 勝ちを残りに配信)
--   配信を A/B 2 案に分割して送り、どちらが効いたかを開封率/クリック率で比べて勝ち案を残り全員に
--   配信したい。ab_tests は account-scoped な A/B テスト定義 (名前・比較指標・状態・勝ち broadcast)。
--   broadcasts.ab_test_id / ab_variant で「どの配信がどの A/B テストの案 A/B か」を紐付ける。
--   決定論的な audience 分割・比較・勝ち選定は application 層 (services/ab-split.ts)。実 A/B 分割送信・
--   勝ち全配信の実発火は owner 立会 gated (本 migration は表と列を足すだけ・送信はしない)。
--
-- additive のみ (CREATE TABLE IF NOT EXISTS + ADD COLUMN + CREATE INDEX IF NOT EXISTS)。
--   054 のような CHECK 拡張の表 rebuild は無い = check-migrations の additive-only policy に完全準拠
--   (documented 例外登録は不要)。broadcasts への ADD COLUMN は末尾追記 (054/055 後の実列順の後ろ) の
--   ため列ズレは起きない (createBroadcast/getBroadcastById は名前指定 INSERT / SELECT b.* + 名前 map)。
--   ADD COLUMN ... REFERENCES は D1 で適用可 (migration 052 campaign_id / 055 sender_preset_id の先例)。

CREATE TABLE IF NOT EXISTS ab_tests (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  metric              TEXT NOT NULL CHECK (metric IN ('open_rate', 'click_rate')),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'decided')),
  winner_broadcast_id TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_account ON ab_tests (account_id);

-- broadcasts は A/B テストを id 参照するのみ。ab_variant は 'A'/'B' 等 (NULL = 非 A/B)。
-- CHECK は付けない (将来 A/B/C 多変種への拡張余地を残す・NULL 許容)。
-- ON DELETE SET NULL: A/B テスト削除で配信は消えず、紐付けだけ外れる。
ALTER TABLE broadcasts ADD COLUMN ab_test_id TEXT REFERENCES ab_tests (id) ON DELETE SET NULL;
ALTER TABLE broadcasts ADD COLUMN ab_variant TEXT;

CREATE INDEX IF NOT EXISTS idx_broadcasts_ab_test_id ON broadcasts (ab_test_id);
