# Piecemaker 双方向伝播 runbook（3 段）

> 正本: `.plans/2026-07-15-piecemaker-line-harness/plan.md §5 + §10 B-5`。
> owner 要件「Ksplanning の機能実装をそのまま Piecemaker にも連動、逆も然り」を **機械化した手順**。

## 大前提（honest な限界）

**dual-push は Git の SHA を両 remote で揃えるだけ**で、deploy / D1 migration / secret / binding は伝播しない。
∴「片方を直せば両方に効く」は **code push だけでは未達**。コードが揃っただけでは本番挙動は変わらない。
「機能伝播」を成立させるには下の **3 段すべて** を通す必要がある。

共有戦略: コードは 1 tree（`/root/.openclaw/line-harness-ks` checkout）。remote は 2 本
（`origin` = ksplanning / `piecemaker` = Sukedachi mirror）。テナント差は `wrangler.<tenant>.toml` の
`[vars]` flag と CF リソース・secrets だけ（コード分岐なし）。

---

## 段 1 — code を両 remote に dual-push（同一 SHA）

line-harness コードに触れた案件は closer 工程で必ず両 remote へ push する（片側単発 push 禁止）。

```bash
cd /root/.openclaw/line-harness-ks
git push origin <branch>       # ks 経路 (ksplanning)
git push piecemaker <branch>   # Piecemaker 経路 (Sukedachi mirror)

# H-5: dual-push 非原子性の即時検知（2 本目 push 失敗を週次まで放置しない）
scripts/verify-tenant-sync.sh  # 両 remote の main HEAD SHA 一致を確認。不一致→非ゼロ exit→再 push
```

- `piecemaker` remote 未登録の間（P1-2 未実施）は `verify-tenant-sync.sh` が exit 2 を返す（drift とは別事象）。
- force-push 禁止（git destructive guard で block）。競合は 1 tree 前提で原則起きない。別 checkout が生じたら fast-forward のみ。

## 段 2 — 両テナントを各 config で re-deploy

コードが両 remote に載っても、**両テナントを再 deploy しない限り本番は旧コードのまま**。
deploy は必ずテナント固有 build env で再 build する（ks 値の使い回し厳禁＝§10 B-4 / build-env-rebuild.md 参照）。

```bash
# ── ks (Ksplanning / TRINA)
cd apps/worker && VITE_LIFF_ID=<ks> VITE_BOT_BASIC_ID=<ks> VITE_WORKER_ORIGIN=<ks worker URL> pnpm build
CLOUDFLARE_API_TOKEN=<ks> CLOUDFLARE_ACCOUNT_ID=<ks> \
  npx wrangler deploy dist/line_harness/index.js --config wrangler.ks.toml
# admin Pages (ks 値で再 build → out/)
(cd apps/web && NEXT_PUBLIC_API_URL=<ks worker URL> ... pnpm build)
npx wrangler pages deploy apps/web/out --project-name=line-harness-ks-admin

# ── Piecemaker (Sukedachi)
cd apps/worker && VITE_LIFF_ID=<pm> VITE_BOT_BASIC_ID=<pm> VITE_WORKER_ORIGIN=<pm worker URL> pnpm build
CLOUDFLARE_API_TOKEN=<pm> CLOUDFLARE_ACCOUNT_ID=<pm> \
  npx wrangler deploy dist/line_harness/index.js --config wrangler.piecemaker.toml
(cd apps/web && NEXT_PUBLIC_API_URL=<pm worker URL> ... pnpm build)
npx wrangler pages deploy apps/web/out --project-name=line-harness-piecemaker-admin
```

各テナントは別 CF account / token / D1 / R2 / Vectorize / Pages / secrets（100% 分離）。
deploy 先が `--config` で決まる＝config を取り違えなければ顧客混線は構造的に起きない。

## 段 3 — 新規 migration があれば両テナント D1 に安全適用

コード変更に **新規 migration ファイル**（`packages/db/migrations/NNN_*.sql`）が含まれる場合のみ実施。
無ければ本段はスキップ（大半の機能変更は migration 不要）。

両テナントとも **既存（非空）D1** への適用なので additive・benign-tolerant・backup 先行の安全規律で行う:

```bash
# ── ks: 既存 apply-*-ks.sh パターン（TRINA 事前 assert line_accounts=1 → backup → 適用 → 台帳 → 事後 assert）
CLOUDFLARE_API_TOKEN=<ks> CLOUDFLARE_ACCOUNT_ID=<ks> scripts/apply-<feature>-migrations-ks.sh

# ── Piecemaker: 同型の incremental applier を piecemaker 用に用意して適用
#    （fresh bootstrap は bootstrap-piecemaker-tenant.sh。既存 D1 への追加 migration は別 applier）
#    安全規律は同一: 事前 assert（対象が Piecemaker D1 = database_id 一致 / line_accounts>=1）→
#    backup export → 079-083 型の順次適用（benign 許容）→ account_migrations/_migrations 台帳。
CLOUDFLARE_API_TOKEN=<pm> CLOUDFLARE_ACCOUNT_ID=<pm> DB_NAME=line-harness-piecemaker \
  scripts/apply-<feature>-migrations-piecemaker.sh   # ← 後続 run で feature 毎に用意（本 run では未作成）
```

> **両 D1 migration の requirement を満たすため**、機能に migration が伴う案件では
> ks 用 applier と piecemaker 用 applier を**対で**用意する（片側だけ当てるとスキーマ drift）。
> Piecemaker 用 incremental applier のスケルトンは feature 発生時に `apply-*-ks.sh` を雛形に作る
> （`--config wrangler.piecemaker.toml` / database_id 一致 assert / backup 先行）。

---

## 3 段の要約（machine acceptance）

| 段 | 目的 | 実行物 | これを飛ばすと |
|---|---|---|---|
| 1 | SHA を両 remote で一致 | `git push origin` + `git push piecemaker` + `verify-tenant-sync.sh` | 片側 repo が旧コード |
| 2 | 本番反映（両テナント） | 各 `--config` で再 build + deploy（worker + admin Pages） | 本番は旧挙動のまま |
| 3 | スキーマ整合（migration 時のみ） | 両 D1 に backup 先行の additive applier | 片側 DB がカラム欠落で 500 |

**段 1 だけ（dual-push だけ）では「コードが揃っただけ」**。段 2・3 を伴って初めて owner の
「そのまま連動」が本番で成立する。
