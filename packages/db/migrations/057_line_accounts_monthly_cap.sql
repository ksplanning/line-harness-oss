-- Migration 057: line_accounts.monthly_cap (F2 batch4 G2 配信通数の月次上限ガード)
--
-- WHY (従量課金の予算事故を防ぐ送信ブロック)
--   LINE の従量課金で「今月の送信通数」が予算を超えないよう、account ごとに月次の送信上限を設定できる
--   ようにする。NULL = 無制限 (=既定挙動を一切変えない = 誤爆ゼロ)。上限超過時に送信をブロックする判定は
--   application 層 (services/monthly-cap.ts) が「今月送信数 + 今回予定数 > cap」で行う。計測式は表示
--   (messagesThisMonth) と同一の共有 helper に単一化する。test-send は delivery_type='test' で計測除外。
--
-- additive のみ (ADD COLUMN・NULL 許容)。CHECK は付けない (NULL 許容・正整数は application 検証)。
--   check-migrations の additive-only policy に完全準拠 (documented 例外登録は不要)。

ALTER TABLE line_accounts ADD COLUMN monthly_cap INTEGER;
