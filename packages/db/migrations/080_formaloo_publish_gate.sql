-- Migration 080: formaloo_forms publish gate 状態機械列 (F-2 / T-B3 / line-formaloo-forms)
--
-- WHY: 高機能フォームの誤配信防止 (N-7)。draft の間は公開/埋め込み URL を無効にし、owner の明示
--   publish で初めて有効化する状態機械 (draft → in_review → published)。TRINA 実顧客への誤送信を防ぐ。
--
-- 列の意味:
--   builder_status  draft (編集中) | in_review (owner レビュー待ち) | published (公開済 = URL 有効)。
--                   既定 draft。公開 URL / 埋め込みコードは builder_status='published' の時だけ発行される。
--   published_at    初回公開時刻 (NULL = 未公開)。unpublish で draft に戻しても記録は残す。
--
-- additive のみ (ADD COLUMN with DEFAULT / nullable)。既存 formaloo_forms 行 (全て draft 相当) の挙動不変。
-- check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。

ALTER TABLE formaloo_forms ADD COLUMN builder_status TEXT NOT NULL DEFAULT 'draft';

ALTER TABLE formaloo_forms ADD COLUMN published_at TEXT;
