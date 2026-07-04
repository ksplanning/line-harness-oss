-- Migration 058: rich_menu_groups.schedule_start / schedule_end (F2 batch4 G17 期間限定リッチメニュー)
--
-- WHY (キャンペーン期間だけメニューを自動で切替える)
--   期間限定メニューの開始/終了日時を設定できるようにする。schedule_start <= now < schedule_end の
--   期間だけ対象メニューを公開し、期間外は既定メニューに戻す判定は scheduled handler に入るが、
--   RICH_MENU_SCHEDULE_ENABLED flag OFF (既定) + KS 本番 crons=[] で二重に dark-ship (発火しない)。
--   実切替は owner 立会後 (flag ON + cron 設定)。本 migration は列を足すだけ (切替はしない)。
--
-- additive のみ (ADD COLUMN・NULL 許容・ISO8601 JST 文字列)。CHECK なし。
--   check-migrations の additive-only policy に完全準拠 (documented 例外登録は不要)。

ALTER TABLE rich_menu_groups ADD COLUMN schedule_start TEXT;
ALTER TABLE rich_menu_groups ADD COLUMN schedule_end TEXT;
