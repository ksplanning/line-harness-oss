-- 052_broadcasts_campaign_id.sql (F2 G3 キャンペーン集計)
--
-- broadcasts に campaign_id を追加し、配信をキャンペーンに紐付ける (集計のグルーピングキー)。
-- NULL 許容 = 既存の全配信は未紐付け (NULL) のまま = 既定挙動不変 (集計/送信は camapaign_id を
-- 無視すれば従来通り)。ON DELETE SET NULL = キャンペーン削除で配信自体は消えず紐付けだけ外れる。
-- additive-only: 単純 ADD COLUMN のみ (表 rebuild を誘発しない)。message_type CHECK には触らない。
-- 先例: 020/021 が tracked_links への `ADD COLUMN ... REFERENCES ... ON DELETE SET NULL` を実施済。
-- 同一 DDL が packages/db/schema.sql (正本) にもある (schema replay とのドリフト防止)。
ALTER TABLE broadcasts ADD COLUMN campaign_id TEXT REFERENCES campaigns (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_broadcasts_campaign ON broadcasts(campaign_id);
