-- 048_response_schedules.sql (G28 応答時間帯スケジュール)
--
-- 営業時間内はオペレーター対応 / 時間外は自動応答 or 不在メッセージ を保存する。
-- additive-only: CREATE TABLE / CREATE INDEX IF NOT EXISTS のみ。破壊操作ゼロ。
-- 同一 DDL が packages/db/schema.sql (正本) にもある (schema replay とのドリフト防止)。
--
-- is_enabled は既定 0 (OFF) = 既存 auto-reply 挙動の非回帰。
-- weekly_hours は JSON 文字列 (faqs.variants と同流儀): [{day:0..6, closed:bool, open:'HH:MM', close:'HH:MM'}]
--   day は JS getUTCDay 準拠 (0=日曜 .. 6=土曜)。判定は Asia/Tokyo 壁時計 (受信時 / cron 非依存)。
-- line_account_id NULL = 全アカ共通の既定 (アプリ層 upsert で単一行担保)。
CREATE TABLE IF NOT EXISTS response_schedules (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT DEFAULT NULL,
  is_enabled         INTEGER NOT NULL DEFAULT 0,
  timezone           TEXT NOT NULL DEFAULT 'Asia/Tokyo'
                     CHECK (timezone = 'Asia/Tokyo'),
  outside_hours_mode TEXT NOT NULL DEFAULT 'auto_reply'
                     CHECK (outside_hours_mode IN ('auto_reply','away_message','none')),
  away_message       TEXT DEFAULT NULL,
  weekly_hours       TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_response_schedules_account ON response_schedules(line_account_id);
