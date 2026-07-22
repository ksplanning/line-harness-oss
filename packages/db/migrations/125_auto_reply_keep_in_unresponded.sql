-- Migration 125: auto_replies 未対応リスト残存の per-rule opt-in (additive)
ALTER TABLE auto_replies ADD COLUMN keep_in_unresponded INTEGER NOT NULL DEFAULT 0;
