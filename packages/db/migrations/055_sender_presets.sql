-- Migration 055: sender_presets (送信者プリセット) + broadcasts.sender_preset_id (F2 batch3 G25)
--
-- WHY (なりすまし防止・Codex 独立チェック HIGH[6] 方式 2)
--   1 通ごとに送信者の表示名・アイコンを切替えたい (キャンペーン別ペルソナ)。任意の name/iconUrl
--   をクライアントから送信者に設定できると別ブランドを騙る配信が可能になる。→ account-scoped な
--   sender_presets 表に登録済みのプリセットを id 参照するだけにし、送信時に server がプリセットから
--   name/iconUrl を解決する。broadcasts は生の sender_name/sender_icon_url を持たない = クライアントが
--   生 sender 文字列を注入する経路が構造的に存在しない (なりすまし不可)。
--
-- additive のみ (CREATE IF NOT EXISTS + ADD COLUMN)。054 (CHECK widen rebuild) の後に走らせ、
-- rebuild と混ぜない。check-migrations の additive-only policy に完全準拠 = 例外登録は不要 (054 のみ)。
-- ADD COLUMN ... REFERENCES は D1 で適用可 (migration 052 campaign_id の先例)。

CREATE TABLE IF NOT EXISTS sender_presets (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL REFERENCES line_accounts (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  icon_url        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sender_presets_account ON sender_presets (line_account_id);

-- broadcasts はプリセットを id 参照するのみ (生 name/iconUrl 列は持たない)。
-- ON DELETE SET NULL: プリセット削除で配信は消えず、送信者だけ既定に戻る。
ALTER TABLE broadcasts ADD COLUMN sender_preset_id TEXT REFERENCES sender_presets (id) ON DELETE SET NULL;
