-- 053_template_packs.sql (F2 G16 テンプレパック)
--
-- 「あいさつ→案内→CTA」のような複数吹き出しのセットを1パックとして保存し、配信作成時に
-- まとめて呼び出す (挿入) ための account-scoped な additive-only テーブル群。
-- account_id NOT NULL = 所有アカウントに紐付き、別アカウントのパック文面は list/選択に出ない
-- (文面漏洩+誤挿入の防止 / cross-account 漏洩ゼロ)。既存 message_templates (単発テンプレ) とは
-- 別責務・別表 (message_templates は無変更)。挿入 UI は broadcast-form の state に載せるだけで
-- 送信経路には一切触れない。破壊操作ゼロ。
-- 同一 DDL が packages/db/schema.sql (正本) にもある (schema replay とのドリフト防止)。
CREATE TABLE IF NOT EXISTS template_packs (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_template_packs_account ON template_packs(account_id);

CREATE TABLE IF NOT EXISTS template_pack_items (
  id               TEXT PRIMARY KEY,
  pack_id          TEXT NOT NULL REFERENCES template_packs(id) ON DELETE CASCADE,
  order_index      INTEGER NOT NULL,
  message_type     TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content  TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_template_pack_items_pack ON template_pack_items(pack_id, order_index);
