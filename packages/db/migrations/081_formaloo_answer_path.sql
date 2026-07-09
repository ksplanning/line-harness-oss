-- Migration 081: Formaloo 回答データ経路 (F-3 / T-C1 / line-formaloo-forms)
--
-- WHY: Formaloo webhook 受信で回答を formaloo_submissions へ冪等 upsert (PK=submission id / N-3) し、
--   LINE 後処理 (tag/scenario/flex) を submission ごとに **1 回だけ** 発火させる。再送・順序非依存でも
--   二重発火しないよう「発火済」を claim フラグで表す (line_processed)。
--   N-12 (未署名 webhook の spoof/replay 対策): webhook が署名しない場合は payload を隔離し、LINE 後処理を
--   即発火させない。verified=0 の間は隔離状態 = 後段 (rows API pull-verify / closer live) で確定させる。
--   署名検証 or pull-verify に成功したら verified=1 に上げてから後処理を発火する。
--
-- 列の意味:
--   line_processed  0=未処理 | 1=LINE 後処理発火済。`UPDATE ... WHERE id=? AND line_processed=0` の
--                   atomic claim (changes=1 のときだけ後処理) で再送二重発火を防ぐ (N-3)。
--   verified        0=未検証 (未署名隔離 / N-12) | 1=署名 or pull-verify 済。verified=1 かつ published の
--                   フォームだけが LINE 後処理の発火対象 (N-7)。
--
-- additive のみ (ADD COLUMN NOT NULL DEFAULT / CREATE INDEX IF NOT EXISTS)。既存 formaloo_submissions 行
--   (079) の挙動不変。check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。native forms は無改変 (D-1)。

ALTER TABLE formaloo_submissions ADD COLUMN line_processed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE formaloo_submissions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;

-- 未検証 (未署名隔離) submission の後段 pull-verify 走査用 (N-12 reconcile)。
CREATE INDEX IF NOT EXISTS idx_formaloo_submissions_unverified ON formaloo_submissions (form_id, verified);
