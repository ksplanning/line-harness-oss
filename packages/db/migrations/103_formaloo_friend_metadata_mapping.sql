-- row-status-friend-sync: form 単位の Formaloo field → friend.metadata mapping。
-- [] は機能 OFF。Formaloo definition/pull/drift と直交する local-only additive 設定。
ALTER TABLE formaloo_forms ADD COLUMN friend_metadata_mappings_json TEXT NOT NULL DEFAULT '[]';
