#!/usr/bin/env bash
# verify-tenant-sync.sh — dual-remote テナント sync の drift 検知 (P1-3 / plan.md §5)。
#
# WHY: Piecemaker は「共有 1 tree → dual-remote mirror」戦略 (plan.md §2 案 c)。
#   共有コードは origin(=ksplanning) と mirror(=piecemaker) の両 remote に同一 SHA で push される。
#   残る唯一の drift 源 = 「片側 remote への push 忘れ」。これを機械で塞ぐ。
#   `git ls-remote` で両 remote の branch HEAD SHA を比較し、不一致 (=片側 push 漏れ) を
#   非ゼロ exit + 1 行通知で検知する。§10 H-5: dual-push 直後に同期実行する土台。
#
# USAGE:
#   scripts/verify-tenant-sync.sh
#   REPO_DIR=/path ORIGIN_REMOTE=origin MIRROR_REMOTE=piecemaker BRANCH=main scripts/verify-tenant-sync.sh
#
# EXIT CODES (done 条件: 同一 SHA→0 / 乖離→非0):
#   0 = 両 remote の HEAD SHA 一致 (in sync)
#   1 = DRIFT (両 remote に branch はあるが HEAD SHA が不一致 = 片側 push 漏れ)
#   2 = mirror remote 未登録 (P1-2 の 2nd remote 配線が未実施 — drift とは別事象)
#   3 = origin remote 未登録
#   4 = 片側の HEAD SHA を取得できない (branch 不在 / ネットワーク)
#
# NO SECRETS. remote URL/credential は git 設定側。このファイルには秘密を書かない。
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
MIRROR_REMOTE="${MIRROR_REMOTE:-piecemaker}"
BRANCH="${BRANCH:-main}"

cd "$REPO_DIR"

remote_exists() { git remote | grep -qx "$1"; }

head_sha() {
  # refs/heads/<branch> の object SHA を 1 行で返す (無ければ空文字)。
  git ls-remote "$1" "refs/heads/$BRANCH" 2>/dev/null | awk 'NR==1{print $1}'
}

if ! remote_exists "$ORIGIN_REMOTE"; then
  echo "!! ORIGIN remote '$ORIGIN_REMOTE' 未登録 (not registered)。ks 経路の remote 名を確認。" >&2
  exit 3
fi
if ! remote_exists "$MIRROR_REMOTE"; then
  echo "!! MIRROR remote '$MIRROR_REMOTE' 未登録 (not registered)。P1-2 の 2nd remote 配線 (git remote add $MIRROR_REMOTE <url>) が未実施。" >&2
  exit 2
fi

ORIGIN_SHA="$(head_sha "$ORIGIN_REMOTE")"
MIRROR_SHA="$(head_sha "$MIRROR_REMOTE")"

if [ -z "$ORIGIN_SHA" ] || [ -z "$MIRROR_SHA" ]; then
  echo "!! 片側の $BRANCH HEAD を取得できない: origin='$ORIGIN_SHA' mirror='$MIRROR_SHA' (branch 不在 / ネットワーク)。" >&2
  exit 4
fi

if [ "$ORIGIN_SHA" = "$MIRROR_SHA" ]; then
  echo "OK sync: $ORIGIN_REMOTE == $MIRROR_REMOTE @ $BRANCH = $ORIGIN_SHA"
  exit 0
fi

echo "!! DRIFT: $ORIGIN_REMOTE=$ORIGIN_SHA / $MIRROR_REMOTE=$MIRROR_SHA @ $BRANCH = 片側 push 漏れ。両 remote へ dual-push せよ。" >&2
exit 1
