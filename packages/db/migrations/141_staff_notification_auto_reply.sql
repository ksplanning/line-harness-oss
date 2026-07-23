-- Migration 141: per-destination opt-in for inquiries handled by auto reply.
-- Existing and new destinations stay quiet for these events by default.

ALTER TABLE staff_notification_destinations
  ADD COLUMN notify_auto_reply INTEGER NOT NULL DEFAULT 0
  CHECK (notify_auto_reply IN (0, 1));
