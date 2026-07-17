-- Migration 101: form-edit-mail-link (弾L) の台帳基盤 — additive のみ。
--
-- WHY:
--   埋込式フォーム回答者へメールで届ける「編集用 URL」機能のフォーム単位設定 + 冪等/永続 outbox。
--   (a) formaloo_forms.allow_edit_mail = このフォームで編集 URL メールを送るか (0=送らない / 1=送る)。
--       既定 0 = 現状挙動 byte 同等 (機能 OFF = メール発火なし・公開編集 token 未発行)。allow_post_edit=1 と AND gate。
--       弾S 099 の allow_post_edit と完全同型の additive (NOT NULL DEFAULT 0 = 定数 DEFAULT)。
--   (b) formaloo_forms.edit_mail_field_slug = 送付先 email 欄の明示指定 (OD-3 / Codex G-1)。
--       複数メール欄・代理入力での第三者送信を防ぐため、送付先 slug を form 設定で固定する。NULL=未指定 (fire は skip)。
--   (c) formaloo_forms.edit_link_epoch = 失効世代 (Codex G-5)。stateless 署名トークンを一括失効する経路。
--       token payload に epoch を焼き、開封時 live gate で form 側 epoch と照合。bump で当該 form の既発行 URL を全失効。
--   (d) formaloo_edit_mail_sends = 冪等 + 永続 outbox (Codex G-3/G-4)。submission_id UNIQUE で「1 submission=1 送信」。
--       status=pending 予約 → provider ack で sent / 失敗で failed。claim 直後の障害でもメールが永久喪失しない。
--       cron(*/5) が pending/failed を bounded 再送し provider_idempotency_key で二重送信しない (再送は Phase B)。
--       recipient_hash のみ保存 (平文メールは D1 非保存 = PII / PUBLIC repo)。
--
-- 設計: DROP/RENAME/CHECK 拡張なし = check-migrations (POLICY_CUTOFF=041) 準拠 / 099・100 の additive 規律継承。

ALTER TABLE formaloo_forms ADD COLUMN allow_edit_mail INTEGER NOT NULL DEFAULT 0;
ALTER TABLE formaloo_forms ADD COLUMN edit_mail_field_slug TEXT;
ALTER TABLE formaloo_forms ADD COLUMN edit_link_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS formaloo_edit_mail_sends (
  id                       TEXT PRIMARY KEY,
  submission_id            TEXT NOT NULL UNIQUE,   -- 冪等 claim (1 submission = 1 送信 / 再配信で 2 通目を出さない)
  form_id                  TEXT NOT NULL,
  recipient_hash           TEXT NOT NULL,          -- 宛先メールの hash のみ (平文非保存 = PII / PUBLIC repo)
  requested_at             TEXT NOT NULL,          -- JST ISO8601 (claim/pending 予約時刻)
  status                   TEXT NOT NULL,          -- pending | sent | failed | skipped
  attempt_count            INTEGER NOT NULL DEFAULT 0,  -- 再送回数 (bounded 再送の上限判定 / Phase B)
  provider_idempotency_key TEXT,                   -- provider 側冪等キー (再送で provider 二重送信しない / Phase B)
  last_attempt_at          TEXT,                   -- 最終試行時刻 (JST ISO)
  provider_message_id      TEXT,                   -- provider ack の message id (送達証跡)
  error                    TEXT                    -- 失敗理由 (soft-200-safe 証跡)
);

-- outbox sweep (cron 再送 / Phase B): status ∈ {pending, failed} の行を新しい順に拾う索引。
CREATE INDEX IF NOT EXISTS idx_formaloo_edit_mail_sends_status ON formaloo_edit_mail_sends (status, requested_at);
CREATE INDEX IF NOT EXISTS idx_formaloo_edit_mail_sends_form ON formaloo_edit_mail_sends (form_id, requested_at);
