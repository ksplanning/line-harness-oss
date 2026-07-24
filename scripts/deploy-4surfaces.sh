#!/usr/bin/env bash
# deploy-sametab-4surfaces.sh — sametab fix 本番反映 (migrationなし・4面デプロイのみ)
# go-live-2026-07-22-batch.sh の [3]-[6] 流用。
set -euo pipefail
ROOT="/root/.openclaw/line-harness-ks"
KS_WORKER_URL="https://line-harness-ks.web-8af.workers.dev"
KS_LIFF_ID="1656331577-LBR4Xooz"
PM_WORKER_URL="https://line-harness-piecemaker.piecemaker.workers.dev"
PM_LIFF_ID="2010750380-zPyzob9G"
PM_ACCOUNT_ID="9e4c603b3f47d4072f8a3a27759e8aff"

cd "$ROOT"
git diff --quiet || { echo "!!! ABORT: 未コミット差分あり"; exit 1; }
echo "main HEAD: $(git rev-parse --short HEAD)"

if [ "${SKIP_KS_WORKER:-0}" != "1" ]; then
echo "########## [1/4] KS worker build+deploy ##########"
( set -a; . "$ROOT/.env"; set +a
  cd "$ROOT/apps/worker"
  VITE_LIFF_ID="$KS_LIFF_ID" VITE_WORKER_ORIGIN="$KS_WORKER_URL" VITE_BOT_BASIC_ID='' pnpm build
  grep -rq "$KS_LIFF_ID" dist/client || { echo "!!! ABORT: KS LIFF 未焼込"; exit 1; }
  grep -rq -e "2010750380" -e "piecemaker.workers" dist/client && { echo "!!! ABORT: pm値混入"; exit 1; } || true
  npx wrangler deploy dist/line_harness/index.js --config wrangler.ks.toml )
curl -fsS -o /dev/null -w "KS worker /admin/version -> %{http_code}\n" "$KS_WORKER_URL/admin/version" || true
fi

echo "########## [2/4] KS admin build+deploy ##########"
( set -a; . "$ROOT/.env"; set +a
  KS_ADMIN_KEY="${ADMIN_API_KEY:-${NEXT_PUBLIC_ADMIN_API_KEY:-${API_KEY:-}}}"
  if [ -z "$KS_ADMIN_KEY" ] && [ -f /root/.openclaw/credentials/line-harness-ks-bootstrap-secrets.env ]; then
    set -a; . /root/.openclaw/credentials/line-harness-ks-bootstrap-secrets.env; set +a
    KS_ADMIN_KEY="${ADMIN_API_KEY:-${NEXT_PUBLIC_ADMIN_API_KEY:-${API_KEY:-}}}"
  fi
  [ -n "$KS_ADMIN_KEY" ] || { echo "!!! ABORT: KS admin key 不明"; exit 1; }
  cd "$ROOT/apps/web"
  NEXT_PUBLIC_API_URL="$KS_WORKER_URL" NEXT_PUBLIC_ADMIN_API_KEY="$KS_ADMIN_KEY" NEXT_PUBLIC_UPDATE_BANNER_ENABLED=false pnpm build
  grep -rq "web-8af" out/ || { echo "!!! ABORT: KS worker URL 未焼込"; exit 1; }
  grep -rq "piecemaker" out/ && { echo "!!! ABORT: pm値混入"; exit 1; } || true
  npx wrangler pages deploy out --project-name=line-harness-ks-admin --branch=main --commit-dirty=true )
curl -fsS -o /dev/null -w "KS admin /login -> %{http_code}\n" "https://line-harness-ks-admin.pages.dev/login" || true

echo "########## [3/4] piecemaker worker build+deploy ##########"
( set -a; . /root/.secrets/piecemaker/cloudflare-api-token.env; set +a
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$PM_ACCOUNT_ID}"
  cd "$ROOT/apps/worker"
  VITE_LIFF_ID="$PM_LIFF_ID" VITE_WORKER_ORIGIN="$PM_WORKER_URL" VITE_BOT_BASIC_ID='' pnpm build
  grep -rq "$PM_LIFF_ID" dist/client || { echo "!!! ABORT: pm LIFF 未焼込"; exit 1; }
  grep -rq -e "line-harness-ks" -e "web-8af" -e "1656331577" dist/client && { echo "!!! ABORT: ks値混入"; exit 1; } || true
  npx wrangler deploy dist/line_harness/index.js --config wrangler.piecemaker.toml )
curl -fsS -o /dev/null -w "pm worker /admin/version -> %{http_code}\n" "$PM_WORKER_URL/admin/version" || true

echo "########## [4/4] piecemaker admin build+deploy ##########"
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

echo "DONE: 4面デプロイ完了 (main @ $(git rev-parse --short HEAD))"
