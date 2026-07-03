-- 051_campaigns.sql (F2 G3 キャンペーン集計)
--
-- 複数の配信 (broadcasts) を1つのキャンペーンとして束ね、まとめて成果を見るための
-- account-scoped な additive-only テーブル。account_id NOT NULL = 所有アカウントに紐付き、
-- 別アカウントのキャンペーン/成果は見えない (cross-account 漏洩ゼロ)。破壊操作ゼロ。
-- 配信の紐付けは 052 で broadcasts に追加する campaign_id 列で表現する (集計のグルーピングキー)。
-- 送信には一切関与しない (集計・紐付けのみ)。
-- 同一 DDL が packages/db/schema.sql (正本) にもある (schema replay とのドリフト防止)。
CREATE TABLE IF NOT EXISTS campaigns (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(account_id);
