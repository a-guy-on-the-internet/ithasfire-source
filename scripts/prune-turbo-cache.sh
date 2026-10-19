#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# prune-turbo-cache.sh — cap the local Turborepo cache size.
#
# Turbo writes one artifact per unique task-hash to .turbo/cache and NEVER
# prunes it, so the directory grows unbounded over time. This keeps it under
# a size cap by deleting the OLDEST artifacts first (least likely to be a
# cache hit) until the total is back under the limit.
#
# Override the cap with: TURBO_CACHE_MAX_MB=10000 ./scripts/prune-turbo-cache.sh
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.turbo/cache"
MAX_MB="${TURBO_CACHE_MAX_MB:-5000}"   # default cap: 5 GB
MAX_BYTES=$(( MAX_MB * 1024 * 1024 ))

[ -d "$CACHE_DIR" ] || exit 0

# Total current size (portable: sum file sizes via stat).
# macOS/BSD: stat -f%z ; Linux/GNU: stat -c%s
statsize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }
statmtime() { stat -f%m "$1" 2>/dev/null || stat -c%Y "$1" 2>/dev/null || echo 0; }

total=0
while IFS= read -r f; do
  total=$(( total + $(statsize "$f") ))
done < <(find "$CACHE_DIR" -type f)

if [ "$total" -le "$MAX_BYTES" ]; then
  exit 0
fi

# Build "<mtime> <size> <path>" list sorted oldest-first, delete until under cap.
freed=0
while IFS=' ' read -r _ size path; do
  rm -f "$path"
  total=$(( total - size ))
  freed=$(( freed + size ))
  [ "$total" -le "$MAX_BYTES" ] && break
done < <(
  find "$CACHE_DIR" -type f | while IFS= read -r f; do
    printf '%s %s %s\n' "$(statmtime "$f")" "$(statsize "$f")" "$f"
  done | sort -n
)

printf 'Pruned turbo cache: freed %d MB (cap %d MB)\n' "$(( freed / 1024 / 1024 ))" "$MAX_MB"
