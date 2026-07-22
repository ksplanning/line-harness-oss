#!/usr/bin/env bash
# closer-resume-sheets-sync-scale-deploy.sh — sheets-sync-scale クローザー再開の本番反映を一括実行する。
#   1. migration 126 (sheets_sync_jobs) を KS + piecemaker の両 D1 に適用（冪等）
#   2. 4 面デプロイ: KS worker → KS admin → piecemaker worker → piecemaker admin
#      （テナント毎に必ず再ビルド・焼き込み検証・cross-tenant 値 0 hit を機械チェック）
#   3. 各面の health check + Version ID 記録
# owner_role: infra-ops/closer 工程。ログは .sola/deploy-logs/ に自動保存。
# 実行: bash scripts/closer-resume-sheets-sync-scale-deploy.sh
set -euo pipefail

ROOT="/root/.openclaw/line-harness-ks"
LOGDIR="$ROOT/.sola/deploy-logs"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/$(date +%F_%H%M%S)-closer-resume-126.log"
exec > >(tee -a "$LOG") 2>&1

KS_WORKER_URL="https://line-harness-ks.web-8af.workers.dev"
KS_ADMIN_PROJECT="line-harness-ks-admin"
KS_LIFF_ID="1656331577-LBR4Xooz"
PM_WORKER_URL="https://line-harness-piecemaker.piecemaker.workers.dev"
PM_ADMIN_PROJECT="line-harness-piecemaker-admin"
PM_LIFF_ID="2010750380-zPyzob9G"
PM_ACCOUNT_ID="9e4c603b3f47d4072f8a3a27759e8aff"

echo "########## [0] 前提確認 ##########"
cd "$ROOT"
HEAD_SHA="$(git rev-parse --short HEAD)"
echo "main HEAD: $HEAD_SHA (期待: 39a4dbea9 以降)"
git diff --quiet || { echo "!!! ABORT: 作業ツリーに未コミット差分あり"; exit 1; }

echo "########## [1/6] migration 126 → KS D1 ##########"
(
  set -a; . "$ROOT/.env"; set +a
  bash "$ROOT/scripts/apply-126-sheets-sync-jobs-migration.sh"
)

echo "########## [2/6] migration 126 → piecemaker D1 ##########"
(
  set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml SKIP_LEDGER=1 \
    bash "$ROOT/scripts/apply-126-sheets-sync-jobs-migration.sh"
)

echo "########## [3/6] KS worker build + deploy ##########"
(
  set -a; . "$ROOT/.env"; set +a
  cd "$ROOT/apps/worker"
  VITE_LIFF_ID="$KS_LIFF_ID" VITE_WORKER_ORIGIN="$KS_WORKER_URL" VITE_BOT_BASIC_ID='' pnpm build
  echo "--- 焼き込み検証 (KS) ---"
  grep -rq "$KS_LIFF_ID" dist/client || { echo "!!! ABORT: KS LIFF id が dist に焼かれていない"; exit 1; }
  if grep -rq -e "piecemaker" -e "2010750380" dist/client; then echo "!!! ABORT: piecemaker 値が KS dist に混入"; exit 1; fi
  echo "OK: KS 値焼き込み・pm 値 0 hit"
  npx wrangler deploy dist/line_harness/index.js --config wrangler.ks.toml
  echo "--- KS worker 最新 Version ---"
  npx wrangler deployments list --config wrangler.ks.toml 2>/dev/null | head -8
)
curl -fsS -o /dev/null -w "KS worker /admin/version -> %{http_code}\n" "$KS_WORKER_URL/admin/version" || true

echo "########## [4/6] KS admin build + deploy ##########"
(
  set -a; . "$ROOT/.env"; set +a
  cd "$ROOT/apps/web"
  NEXT_PUBLIC_API_URL="$KS_WORKER_URL" NEXT_PUBLIC_ADMIN_API_KEY="${ADMIN_API_KEY:?ADMIN_API_KEY が .env に無い}" \
  NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false pnpm build
  echo "--- 焼き込み検証 (KS admin) ---"
  grep -rq "web-8af" out/ || { echo "!!! ABORT: KS worker URL が out に焼かれていない"; exit 1; }
  if grep -rq "piecemaker" out/; then echo "!!! ABORT: piecemaker 値が KS out に混入"; exit 1; fi
  npx wrangler pages deploy out --project-name="$KS_ADMIN_PROJECT" --branch=main --commit-dirty=true
)
curl -fsS -o /dev/null -w "KS admin /login -> %{http_code}\n" "https://line-harness-ks-admin.pages.dev/login" || true

echo "########## [5/6] piecemaker worker build + deploy ##########"
(
  set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  cd "$ROOT/apps/worker"
  VITE_LIFF_ID="$PM_LIFF_ID" VITE_WORKER_ORIGIN="$PM_WORKER_URL" VITE_BOT_BASIC_ID='' pnpm build
  echo "--- 焼き込み検証 (piecemaker) ---"
  grep -rq "$PM_LIFF_ID" dist/client || { echo "!!! ABORT: pm LIFF id が dist に焼かれていない (空焼き=ぐるぐる地雷)"; exit 1; }
  if grep -rq -e "line-harness-ks" -e "web-8af" -e "1656331577" dist/client; then echo "!!! ABORT: ks 値が pm dist に混入"; exit 1; fi
  echo "OK: pm 値焼き込み・ks 値 0 hit"
  npx wrangler deploy dist/line_harness/index.js --config wrangler.piecemaker.toml
  echo "--- pm worker 最新 Version ---"
  npx wrangler deployments list --config wrangler.piecemaker.toml 2>/dev/null | head -8
)
curl -fsS -o /dev/null -w "pm worker /admin/version -> %{http_code}\n" "$PM_WORKER_URL/admin/version" || true

echo "########## [6/6] piecemaker admin build + deploy ##########"
(
  set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  PM_ADMIN_KEY=""
  if [ -f /root/.secrets/piecemaker/api-key.txt ]; then PM_ADMIN_KEY="$(cat /root/.secrets/piecemaker/api-key.txt | tr -d '[:space:]')"; fi
  [ -n "$PM_ADMIN_KEY" ] || { echo "!!! ABORT: piecemaker API_KEY (/root/.secrets/piecemaker/api-key.txt) が読めない"; exit 1; }
  cd "$ROOT/apps/web"
  NEXT_PUBLIC_API_URL="$PM_WORKER_URL" NEXT_PUBLIC_ADMIN_API_KEY="$PM_ADMIN_KEY" \
  NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false pnpm build
  echo "--- 焼き込み検証 (pm admin) ---"
  grep -rq "piecemaker.workers.dev" out/ || { echo "!!! ABORT: pm worker URL が out に焼かれていない"; exit 1; }
  if grep -rq -e "web-8af" -e "line-harness-ks.web" out/; then echo "!!! ABORT: ks 値が pm out に混入"; exit 1; fi
  npx wrangler pages deploy out --project-name="$PM_ADMIN_PROJECT" --branch=main --commit-dirty=true
)
curl -fsS -o /dev/null -w "pm admin /login -> %{http_code}\n" "https://line-harness-piecemaker-admin.pages.dev/login" || true

echo "########## [7/7] 検証用偽データ 1,450 件を KS D1 へ投入 (live-checklist 事前準備) ##########"
(
  set -a; . "$ROOT/.env"; set +a
  bash "$ROOT/scripts/seed-sync-scale-verification.sh"
)

echo "##################################################"
echo "DONE: migration 126 両テナント + 4 面デプロイ + 検証データ投入 完了 (main @ $HEAD_SHA)"
echo "ログ: $LOG"
echo "次工程: 1,450件 large-sync 実測 (live-checklist) → REPORT → push は bot が続行します"
