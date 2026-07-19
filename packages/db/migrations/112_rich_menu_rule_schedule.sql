-- Optional UTC ISO-8601 bounds for conditional rich-menu rules.
-- Admin date-times without an offset are interpreted as JST by the API before storage.
ALTER TABLE rich_menu_display_rules ADD COLUMN active_from TEXT;
ALTER TABLE rich_menu_display_rules ADD COLUMN active_until TEXT;

-- One durable cursor lets a later cron recover boundaries if a 15-minute scan is delayed.
CREATE TABLE IF NOT EXISTS rich_menu_rule_schedule_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rich_menu_rule_schedule_from
  ON rich_menu_display_rules(is_active, active_from, account_id) WHERE active_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rich_menu_rule_schedule_until
  ON rich_menu_display_rules(is_active, active_until, account_id) WHERE active_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rich_menu_rule_schedule_friends
  ON friends(line_account_id, is_following, id);
