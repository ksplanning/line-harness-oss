-- Owner directive (2026-07-21): enable the FAQ bot while keeping every reply
-- in draft mode by default. This data migration is shared by both tenant D1s.
-- Existing tuning values are preserved; only the two owner-directed keys change.

INSERT OR IGNORE INTO account_settings (id, line_account_id, key, value)
SELECT
  'faq_bot_' || lower(hex(randomblob(16))),
  line_accounts.id,
  'faq_bot',
  '{"enabled":true,"threshold":0.6,"handoffMessage":"","autoReplyNotice":"","maxRepliesPerDay":5,"answerMode":"draft"}'
FROM line_accounts;

UPDATE account_settings
SET
  value = json_patch(
    CASE WHEN json_valid(value) THEN value ELSE '{}' END,
    '{"enabled":true,"answerMode":"draft"}'
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE key = 'faq_bot'
  AND (
    json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.enabled') IS NOT 1
    OR json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.answerMode') IS NOT 'draft'
  );
