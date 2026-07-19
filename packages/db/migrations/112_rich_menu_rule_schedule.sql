-- Optional UTC ISO-8601 bounds for conditional rich-menu rules.
-- Admin date-times without an offset are interpreted as JST by the API before storage.
ALTER TABLE rich_menu_display_rules ADD COLUMN active_from TEXT;
ALTER TABLE rich_menu_display_rules ADD COLUMN active_until TEXT;
