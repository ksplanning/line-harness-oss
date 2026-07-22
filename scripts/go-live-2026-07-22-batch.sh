#!/usr/bin/env bash
# go-live-2026-07-22-batch.sh — 2026-07-22 の4機能を本番反映する一括スクリプト。
#   対象: ①自動返信(LINE/メール独立) ②フォーム回答シート分離+台帳ON/OFF ③添付DL ④分岐デフォルト値バグ
#   工程: migration 127+128 両テナント → 4面デプロイ(KS worker/admin + piecemaker worker/admin)
#   ①の migration は無し(コードのみ)。②が 127/128 を要する。③④は migration 無し。
# owner_role: infra-ops/closer。auto権限分類器が本番DB書込/デプロイをブロックするため owner の ! 実行用。
# 実行: bash scripts/go-live-2026-07-22-batch.sh
set -euo pipefail
ROOT="/root/.openclaw/line-harness-ks"
LOGDIR="$ROOT/.sola/deploy-logs"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/$(date +%F_%H%M%S)-go-live-batch.log"
exec > >(tee -a "$LOG") 2>&1

KS_WORKER_URL="https://line-harness-ks.web-8af.workers.dev"
KS_LIFF_ID="1656331577-LBR4Xooz"
PM_WORKER_URL="https://line-harness-piecemaker.piecemaker.workers.dev"
PM_LIFF_ID="2010750380-zPyzob9G"
PM_ACCOUNT_ID="9e4c603b3f47d4072f8a3a27759e8aff"

cd "$ROOT"
echo "########## [0] 前提 ##########"
echo "main HEAD: $(git rev-parse --short HEAD) (期待 origin/main 同期済)"
git diff --quiet || { echo "!!! ABORT: 未コミット差分あり"; exit 1; }

echo "########## [1/6] migration 127+128 → KS D1 ##########"
( set -a; . "$ROOT/.env"; set +a; bash "$ROOT/scripts/apply-127-128-form-results-migration.sh" )

echo "########## [2/6] migration 127+128 → piecemaker D1 ##########"
( set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  DB_NAME=line-harness-piecemaker WRANGLER_CONFIG=apps/worker/wrangler.piecemaker.toml SKIP_LEDGER=1 \
    bash "$ROOT/scripts/apply-127-128-form-results-migration.sh" )

echo "########## [3/6] KS worker build+deploy ##########"
( set -a; . "$ROOT/.env"; set +a
  cd "$ROOT/apps/worker"
  VITE_LIFF_ID="$KS_LIFF_ID" VITE_WORKER_ORIGIN="$KS_WORKER_URL" VITE_BOT_BASIC_ID='' pnpm build
  grep -rq "$KS_LIFF_ID" dist/client || { echo "!!! ABORT: KS LIFF 未焼込"; exit 1; }
  grep -rq -e "2010750380" -e "piecemaker.workers" dist/client && { echo "!!! ABORT: pm値混入"; exit 1; } || true
  npx wrangler deploy dist/line_harness/index.js --config wrangler.ks.toml
  npx wrangler deployments list --config wrangler.ks.toml 2>/dev/null | head -6 )
curl -fsS -o /dev/null -w "KS worker /admin/version -> %{http_code}\n" "$KS_WORKER_URL/admin/version" || true

echo "########## [4/6] KS admin build+deploy ##########"
( set -a; . "$ROOT/.env"; set +a
  KS_ADMIN_KEY="${ADMIN_API_KEY:-${NEXT_PUBLIC_ADMIN_API_KEY:-${API_KEY:-}}}"
  [ -n "$KS_ADMIN_KEY" ] || { echo "!!! ABORT: KS admin key 不明"; exit 1; }
  cd "$ROOT/apps/web"
  NEXT_PUBLIC_API_URL="$KS_WORKER_URL" NEXT_PUBLIC_ADMIN_API_KEY="$KS_ADMIN_KEY" NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false pnpm build
  grep -rq "web-8af" out/ || { echo "!!! ABORT: KS worker URL 未焼込"; exit 1; }
  grep -rq "piecemaker" out/ && { echo "!!! ABORT: pm値混入"; exit 1; } || true
  npx wrangler pages deploy out --project-name=line-harness-ks-admin --branch=main --commit-dirty=true )
curl -fsS -o /dev/null -w "KS admin /login -> %{http_code}\n" "https://line-harness-ks-admin.pages.dev/login" || true

echo "########## [5/6] piecemaker worker build+deploy ##########"
( set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  cd "$ROOT/apps/worker"
  VITE_LIFF_ID="$PM_LIFF_ID" VITE_WORKER_ORIGIN="$PM_WORKER_URL" VITE_BOT_BASIC_ID='' pnpm build
  grep -rq "$PM_LIFF_ID" dist/client || { echo "!!! ABORT: pm LIFF 未焼込(空焼き=ぐるぐる地雷)"; exit 1; }
  grep -rq -e "line-harness-ks" -e "web-8af" -e "1656331577" dist/client && { echo "!!! ABORT: ks値混入"; exit 1; } || true
  npx wrangler deploy dist/line_harness/index.js --config wrangler.piecemaker.toml
  npx wrangler deployments list --config wrangler.piecemaker.toml 2>/dev/null | head -6 )
curl -fsS -o /dev/null -w "pm worker /admin/version -> %{http_code}\n" "$PM_WORKER_URL/admin/version" || true

echo "########## [6/6] piecemaker admin build+deploy ##########"
( set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  PM_ADMIN_KEY="$(cat /root/.secrets/piecemaker/api-key.txt 2>/dev/null | tr -d '[:space:]')"
  [ -n "$PM_ADMIN_KEY" ] || { echo "!!! ABORT: pm API_KEY 不明"; exit 1; }
  cd "$ROOT/apps/web"
  NEXT_PUBLIC_API_URL="$PM_WORKER_URL" NEXT_PUBLIC_ADMIN_API_KEY="$PM_ADMIN_KEY" NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false pnpm build
  grep -rq "piecemaker.workers.dev" out/ || { echo "!!! ABORT: pm worker URL 未焼込"; exit 1; }
  grep -rq -e "web-8af" out/ && { echo "!!! ABORT: ks値混入"; exit 1; } || true
  npx wrangler pages deploy out --project-name=line-harness-piecemaker-admin --branch=main --commit-dirty=true )
curl -fsS -o /dev/null -w "pm admin /login -> %{http_code}\n" "https://line-harness-piecemaker-admin.pages.dev/login" || true

echo "##################################################"
echo "DONE: migration 127+128 両テナント + 4面デプロイ 完了 (main @ $(git rev-parse --short HEAD))"
echo "ログ: $LOG"
echo "次工程: bot が deployed 実機検証 → REPORT → Box → Discord を各案件で実施します"
