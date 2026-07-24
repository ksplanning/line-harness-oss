#!/usr/bin/env bash
# deploy-pages-2surfaces.sh — web(admin)のみ変更時の 2 面デプロイ (KS admin + PM admin)
set -euo pipefail
ROOT="/root/.openclaw/line-harness-ks"
KS_WORKER_URL="https://line-harness-ks.web-8af.workers.dev"
PM_WORKER_URL="https://line-harness-piecemaker.piecemaker.workers.dev"
PM_ACCOUNT_ID="9e4c603b3f47d4072f8a3a27759e8aff"

cd "$ROOT"
git diff --quiet || { echo "!!! ABORT: 未コミット差分あり"; exit 1; }
echo "main HEAD: $(git rev-parse --short HEAD)"

echo "########## [1/2] KS admin build+deploy ##########"
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

echo "########## [2/2] piecemaker admin build+deploy ##########"
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

echo "DONE: adminページ2面デプロイ完了 (main @ $(git rev-parse --short HEAD))"
