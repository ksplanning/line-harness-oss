-- Add the account-scoped AI reply-style setting without changing existing
-- FAQ tuning or any send behavior. Empty values are the backward-compatible
-- state: prompt assembly remains byte-for-byte unchanged.

INSERT OR IGNORE INTO account_settings (id, line_account_id, key, value)
SELECT
  'faq_bot_' || lower(hex(randomblob(16))),
  line_accounts.id,
  'faq_bot',
  '{"enabled":false,"threshold":0.6,"handoffMessage":"","autoReplyNotice":"","maxRepliesPerDay":5,"answerMode":"draft","replyStyle":{"instructions":"","greeting":""}}'
FROM line_accounts;

UPDATE account_settings
SET
  value = json_set(
    value,
    '$.replyStyle',
    json('{"instructions":"","greeting":""}')
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE key = 'faq_bot'
  AND json_valid(value)
  AND json_type(value) = 'object'
  AND json_type(value, '$.replyStyle') IS NULL;
