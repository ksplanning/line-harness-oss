-- Migration 094: Formaloo workspace registry (F6-1 / envelope 暗号化キー管理)
--
-- WHY: 複数 Formaloo workspace の API キーを設定管理する台帳。owner は workspace 毎に違う鍵
--   (KEY/SECRET) を UI から登録・切替・疎通テストできる。鍵は D1 に **平文で置かない** (D-2)。
--   AES-256-GCM の envelope 暗号化で暗号文だけを保存し、復号用の親鍵 (KEK) は worker secret
--   (FORMALOO_KEK) に置く (closer 工程 S-1 で wrangler secret put / repo に生値なし)。
--
-- 暗号化設計 (§ROLLOUT_PLAN §4 / T-A1):
--   - KEY と SECRET を個別に暗号化 (各 12-byte random IV / AAD = workspace id + field 名で束縛)。
--   - key_ciphertext/secret_ciphertext = base64 暗号文 (GCM auth tag 込み)、*_iv = base64 IV。
--   - 平文鍵列 (api_key/api_secret 等) は **持たない** (列名 key_ciphertext は暗号文専用)。
--   - kek_version (Codex gap #4): 将来の KEK ローテーション (旧+新 KEK 併用復号→再暗号化) を
--     破壊的 migration なしで足すための前方互換列。F6-1 は version=1 単一運用。
--   - is_active: enable/disable の soft-delete。F6-1 の「切替」= 有効化/無効化 + 再登録 (per-form
--     の作成先選択は F6-2 / migration 095)。
--
-- additive のみ (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)。DROP/RENAME/CHECK 拡張なし
--   = check-migrations (POLICY_CUTOFF=041) 準拠 / M-2。timestamp は JST ISO8601 (079 と同一慣習 / M-4)。
-- D-1 不可侵: 既存 formaloo_forms / formaloo_submissions / formaloo_field_map / formaloo_sync_state は無改変。

CREATE TABLE IF NOT EXISTS formaloo_workspaces (
  id                 TEXT PRIMARY KEY,                          -- workspace 台帳 id (fw_...)
  label              TEXT NOT NULL DEFAULT '',                  -- owner 命名 (表示用 / 例「A社アカウント」)
  business_slug      TEXT,                                      -- Formaloo business slug (疎通テストで取得 / 任意)
  key_ciphertext     TEXT NOT NULL,                             -- AES-GCM(base64) 暗号文: API KEY (平文非保持)
  key_iv             TEXT NOT NULL,                             -- KEY 用 12-byte IV (base64)
  secret_ciphertext  TEXT NOT NULL,                             -- AES-GCM(base64) 暗号文: API SECRET (平文非保持)
  secret_iv          TEXT NOT NULL,                             -- SECRET 用 12-byte IV (base64)
  kek_version        INTEGER NOT NULL DEFAULT 1,                -- KEK ローテーション前方互換 (Codex gap #4)
  is_active          INTEGER NOT NULL DEFAULT 1,                -- 1=有効 / 0=無効 (soft-delete = enable/disable)
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_formaloo_workspaces_active ON formaloo_workspaces (is_active);
