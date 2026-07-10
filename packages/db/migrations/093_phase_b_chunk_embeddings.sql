-- Phase B batch B-4 (T-D6) — additive-only. chunk の embed 状態追跡列を knowledge_chunks に追加。
-- 番号: 台帳最大 092 (phase_b_knowledge_chunks) 超の最小未使用 (M-2 着工時 ledger 実測で 093 を claim)。
--   ROLLOUT_PLAN §13 の「059-063 予約」は stale (実台帳 089-092 使用済) につき無視。
-- embedded_at = null なら未 embed (Vectorize 未 upsert)。upsert 成功確認後にアプリ層 (markChunksEmbedded) が
--   セットする (Vectorize は eventual consistent。受付直後にセットすると失敗ベクトルが backfill 対象外に落ちる
--   ため。`embedded_at IS NULL` を backfill 対象クエリにする / spec §8)。
-- embed_model = どのモデルで embed したか。モデル変更時に再 embed 対象を特定する provenance。
-- ⚠️ additive-only: ADD COLUMN のみ (DROP/RENAME/_new なし)。列は NULL 許容 (NOT NULL なし) = 既存行は
--    NULL default で無改変。check-migrations POLICY_CUTOFF=041 additive pass (exception 追記不要)。
ALTER TABLE knowledge_chunks ADD COLUMN embedded_at TEXT;
ALTER TABLE knowledge_chunks ADD COLUMN embed_model TEXT;
