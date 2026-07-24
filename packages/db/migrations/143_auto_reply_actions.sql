ALTER TABLE auto_replies
ADD COLUMN on_reply_actions_json TEXT DEFAULT NULL
  CHECK (
    on_reply_actions_json IS NULL
    OR (
      json_valid(on_reply_actions_json)
      AND json_type(on_reply_actions_json) = 'array'
    )
  );
