-- Migration 097: broadcasts.messages 追加 (combo messages / additive)
-- WHY: 1配信=1メッセージ (message_type/message_content) の構造制約を解き、順序付きメッセージ列(最大5)を
--      保持可能にする。additive ADD COLUMN のみ (破壊的 rebuild 禁止・id12 の51本再適用事故を踏襲しない)。
-- messages: JSON MessageBlock[] (len 1..5) | NULL(=従来 single)。妥当性は route/DB 層で担保 (inline CHECK 無し)。
--   MessageBlock = { type: BroadcastMessageType, content: string, altText?: string }
--   先頭ミラー不変条件: messages 非NULL なら message_type=messages[0].type / message_content=messages[0].content /
--     alt_text=messages[0].altText を同一書込で同期する (NOT NULL 制約 + 既存 read 経路の不変を守る・route 層責務)。
-- 注: inline CHECK (json_valid 等) は付けない。D1/SQLite の ADD COLUMN は制約付き列を拒否し得るため、
--     JSON 妥当性は route 検証 + DB 層 JSON.stringify で担保する (plan §5 R-2)。
ALTER TABLE broadcasts ADD COLUMN messages TEXT;
