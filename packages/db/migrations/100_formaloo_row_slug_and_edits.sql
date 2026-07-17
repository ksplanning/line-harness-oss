-- Migration 100: あと編集 (弾M form-post-edit) の台帳基盤 — additive のみ。
--
-- WHY:
--   (a) formaloo_submissions.formaloo_row_slug = Formaloo row 編集の addressable identifier。
--       planner live spike 実測3: 編集は `PATCH /v3.0/rows/{row_slug}/` (row_slug 必須)。
--       harness stored id = submit_code は edit API で 404 (global/form-scoped 両方) ゆえ row_slug を
--       additive 保存する。NULL 可 = 既存行は legacy (webhook root.slug 未 capture) → rows-list resolver で
--       lazy backfill (updateSubmissionRowSlug)。forward-only (既存を落とさない COALESCE upsert)。
--   (b) formaloo_submission_edits = ①管理者編集の最小監査 (誰が いつ どの row の どの項目を 前値→後値)。
--       PII を含み得る (回答値) ため参照は owner-gated (既存 isOwner 慣習継承・route 側)。
--
-- 設計: DROP/RENAME/CHECK 拡張なし = check-migrations (POLICY_CUTOFF=041) 準拠 / 099 の additive 規律継承。
--   ADD COLUMN は TEXT (NULL 可・DEFAULT 無し = 既存行 NULL) = 定数 DEFAULT 不要な nullable additive。

ALTER TABLE formaloo_submissions ADD COLUMN formaloo_row_slug TEXT;

CREATE TABLE IF NOT EXISTS formaloo_submission_edits (
  id              TEXT PRIMARY KEY,
  submission_id   TEXT NOT NULL,
  form_id         TEXT NOT NULL,
  editor_staff_id TEXT,                 -- 編集した staff (認証文脈から解決 / NULL=不明系)
  edited_at       TEXT NOT NULL,        -- JST ISO8601
  field_slug      TEXT NOT NULL,        -- Formaloo field slug (編集した項目)
  old_value       TEXT,                 -- 前値 (表示用スナップショット)
  new_value       TEXT                  -- 後値
);

-- edits の参照経路: submission 単位 (最終編集表示) と form 単位 (監査) の新しい順。
CREATE INDEX IF NOT EXISTS idx_formaloo_submission_edits_submission ON formaloo_submission_edits (submission_id, edited_at);
CREATE INDEX IF NOT EXISTS idx_formaloo_submission_edits_form ON formaloo_submission_edits (form_id, edited_at);

-- ②本人再入場 prefill の getFriendLatestSubmission(form_id, friend_id) ORDER BY submitted_at DESC を支える複合索引。
CREATE INDEX IF NOT EXISTS idx_formaloo_submissions_friend_latest ON formaloo_submissions (form_id, friend_id, submitted_at);
