#!/usr/bin/env bash
# seed-sync-scale-verification.sh — sheets-sync-scale live-checklist 用の検証データを KS D1 に投入する。
#   - 検証専用 line_accounts 行 1 件 (使い捨て・ダミートークン・実 LINE と無関係)
#   - 架空の友だち 1,450 件 (display_name/userId は全て架空値・is_following=1)
# live-checklist.md:99「検証専用のLINEアカウントへ、架空の友だちデータ1,450件を用意する。既存の実データに追加しない」準拠。
# 冪等: INSERT OR IGNORE。後片付け: CLEANUP=1 で同スクリプトが全削除。
set -euo pipefail

ROOT="/root/.openclaw/line-harness-ks"
SEED_DIR="$ROOT/.sola/verification-seed"
mkdir -p "$SEED_DIR"
VA_ID="la-verify-sync-scale"
DB="line-harness-ks"
CFG="$ROOT/apps/worker/wrangler.ks.toml"

WR() { npx wrangler "$@" --config "$CFG"; }

if [ "${CLEANUP:-0}" = "1" ]; then
  echo "==> CLEANUP: 検証データ全削除"
  WR d1 execute "$DB" --remote --command "DELETE FROM friends WHERE line_account_id='$VA_ID'"
  WR d1 execute "$DB" --remote --command "DELETE FROM line_accounts WHERE id='$VA_ID'"
  WR d1 execute "$DB" --remote --json --command "SELECT (SELECT COUNT(*) FROM friends WHERE line_account_id='$VA_ID') AS vf, (SELECT COUNT(*) FROM line_accounts WHERE id='$VA_ID') AS va"
  echo "DONE cleanup"
  exit 0
fi

echo "==> [1/3] seed SQL 生成 (1,450 件・50 件ずつの multi-VALUES)"
python3 - "$SEED_DIR/seed-1450.sql" "$VA_ID" <<'PYEOF'
import sys
out, va = sys.argv[1], sys.argv[2]
lines = []
lines.append(
    "INSERT OR IGNORE INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active) "
    f"VALUES ('{va}', 'verify-sync-scale-ch', '検証用(使い捨て・sync-scale)', 'verify-dummy-token', 'verify-dummy-secret', 1);"
)
batch = []
for i in range(1, 1451):
    ts = f"2026-07-01T00:{(i // 60) % 60:02d}:{i % 60:02d}.{i % 1000:03d}"
    batch.append(
        f"('vf-{i:04d}', 'Uverify_sync_scale_{i:04d}', '検証友だち{i:04d}', 1, '{va}', '{{}}', '{ts}', '{ts}')"
    )
    if len(batch) == 50:
        lines.append(
            "INSERT OR IGNORE INTO friends (id, line_user_id, display_name, is_following, line_account_id, metadata, created_at, updated_at) VALUES\n"
            + ",\n".join(batch) + ";"
        )
        batch = []
if batch:
    lines.append(
        "INSERT OR IGNORE INTO friends (id, line_user_id, display_name, is_following, line_account_id, metadata, created_at, updated_at) VALUES\n"
        + ",\n".join(batch) + ";"
    )
open(out, "w").write("\n".join(lines) + "\n")
print(f"generated {out}: {len(lines)} statements")
PYEOF

echo "==> [2/3] KS D1 へ投入 (INSERT OR IGNORE = 冪等)"
WR d1 execute "$DB" --remote --file "$SEED_DIR/seed-1450.sql"

echo "==> [3/3] 件数 verify"
WR d1 execute "$DB" --remote --json --command "SELECT (SELECT COUNT(*) FROM friends WHERE line_account_id='$VA_ID') AS verify_friends, (SELECT COUNT(*) FROM friends WHERE line_account_id!='$VA_ID' OR line_account_id IS NULL) AS other_friends_untouched" | grep -E "verify_friends|other_friends" || true
echo "期待: verify_friends=1450。実データ (other) は不変であること。"
echo "DONE: 検証データ投入完了。後片付けは CLEANUP=1 bash scripts/seed-sync-scale-verification.sh"
