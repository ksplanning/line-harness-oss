# Formaloo KEK secret 投入 & ローテーション手順書 (F6-1 / S-1)

> **実行者 = closer / infra-ops**。generator は本手順書 + mock KEK テストまで。
> **本番の KEK 生値を repo / wrangler.toml / D1 / ログ / REPORT / この手順書 に書かない** (D-2 / N-15)。

## 1. FORMALOO_KEK とは

Formaloo workspace の API キー (KEY/SECRET) を D1 に **平文で置かない** ための envelope 暗号化の
親鍵 (KEK = Key Encryption Key)。AES-256-GCM 用の **base64 エンコードした 32 byte 乱数**。

- D1 (`formaloo_workspaces`) には暗号文 + IV だけを保存する。復号には KEK が必須。
- KEK は Cloudflare Workers の **secret** に置く (D1 の外・repo の外)。
- 未投入 (dev / S-1 前) は `resolveFormalooClient` の登録 workspace 解決が `null` に落ち、
  env 単一鍵 fallback (`workspaceId=null`) のみ動作する = **dark-ship 安全**。

## 2. 投入手順 (dark-ship deploy 時 / closer)

```bash
# 1) KEK を生成 (base64 32 byte)。この値は端末外に出さない。
openssl rand -base64 32          # => 例: 44 文字の base64 (末尾 '=')

# 2) Cloudflare Workers secret に投入 (apps/worker で実行)。プロンプトに 1) の値を貼る。
cd apps/worker
wrangler secret put FORMALOO_KEK

# 3) Box BOLT に控えを escrow (secrets-bolt-unification / 鍵消失時の復旧用)。
#    生値はここ (repo) には残さない。
```

投入後の確認:

```bash
# secret 一覧に FORMALOO_KEK が載る (値は表示されない)
wrangler secret list

# repo / D1 に生値が無いこと (0 件であるべき)
git grep -n 'FORMALOO_KEK' -- . ':!docs/formaloo-kek-secret-runbook.md'   # 参照はコード/型定義のみ・生値なし
gitleaks detect --no-banner                                              # 0 findings
```

deploy 後の health (S-1 done_condition):
- キー管理 UI (`/settings/formaloo-workspaces`) で owner が 1 件登録 → 疎通テスト 200 → 保存できる。
- 暗号化 round-trip が緑 (登録した workspace で `resolveFormalooClient` が正 client を返す)。
- repo grep で KEK 生値 0 件 / gitleaks 0。

## 3. KEK ローテーション手順 (将来 / kek_version 列で前方互換)

`formaloo_workspaces.kek_version` 列 (migration 094 で先行確保済 / F6-1 は version=1 単一運用)。
full rotation フローの実装は F6-1 スコープ外。将来 rotation する際の設計:

1. 新 KEK を生成し、**新旧両方**を Worker に配備 (例 `FORMALOO_KEK` = 新 / `FORMALOO_KEK_PREV` = 旧)。
2. 復号は `kek_version` を見て旧/新どちらの KEK を使うか分岐する (旧 version=1 は旧 KEK、新規は version=2)。
3. バッチで全 workspace を **旧 KEK で復号 → 新 KEK で再暗号化** し、`kek_version` を 2 に更新。
4. 全件 version=2 になったら旧 KEK (`FORMALOO_KEK_PREV`) を破棄。

- rotation 中も AAD (workspace id + field 名) は不変ゆえ差替え耐性は維持される。
- **破壊的 migration は不要** (列は 094 で確保済 / additive のみ)。

## 4. 不変条件 (どの工程でも守る)

- 本番 KEK 生値 / API KEY / API SECRET を repo・wrangler.toml・D1 平文・ログ・REPORT に **書かない**。
- テストは **mock KEK** (`Buffer.from(new Uint8Array(32).fill(n)).toString('base64')`) のみ使用
  (`formaloo-crypto.test.ts` / `formaloo-resolver.test.ts` / `formaloo-workspaces.test.ts`)。
- owner 実フォーム (Z5IEH85R) をテストで触らない。
