-- Inquiry console state is additive to the existing chats/messages/staff model.
ALTER TABLE chats ADD COLUMN assigned_staff_id TEXT;
ALTER TABLE chats ADD COLUMN read_at TEXT;
ALTER TABLE messages_log ADD COLUMN staff_member_id TEXT;
ALTER TABLE staff_members ADD COLUMN reply_signature_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (reply_signature_enabled IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_chats_assigned_staff
  ON chats (assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_messages_log_staff_member
  ON messages_log (staff_member_id);
