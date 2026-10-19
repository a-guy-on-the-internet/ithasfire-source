#!/usr/bin/env bash
# seed-remote.sh — Push schema + seed data to the remote dev Neon DB.
#
# Usage:
#   DATABASE_URL='postgres://...' bash scripts/seed-remote.sh
#
# This script:
#   1. Temporarily overrides .env.local so Prisma targets the remote DB
#   2. Runs prisma db push (additive schema sync, no data loss)
#   3. Runs the seed:dev script with THC_SEED_ALLOW_REMOTE_DB=true
#   4. Restores .env.local
#
# Safety: requires DATABASE_URL to be explicitly passed.

set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL env var is required."
  echo "Usage: DATABASE_URL='postgres://...' bash scripts/seed-remote.sh"
  exit 1
fi

# Confirm target
DB_HOST=$(echo "$DATABASE_URL" | sed -n 's|.*@\([^:/]*\).*|\1|p')
echo "============================================="
echo "  REMOTE SEED TARGET: $DB_HOST"
echo "============================================="
echo ""
echo "This will:"
echo "  1. Push the current Prisma schema (additive)"
echo "  2. Wipe existing seed data"
echo "  3. Seed demo data (events, users, orgs, orders)"
echo ""
read -p "Continue? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_LOCAL="$REPO_ROOT/.env.local"
ENV_BACKUP="$REPO_ROOT/.env.local.bak-seed-remote"

# ── Step 0: Backup and patch .env.local ──
if [[ -f "$ENV_LOCAL" ]]; then
  cp "$ENV_LOCAL" "$ENV_BACKUP"
  echo "[seed-remote] Backed up .env.local → .env.local.bak-seed-remote"
fi

# Replace the DATABASE_URL line (or append if not found)
if grep -q '^DATABASE_URL=' "$ENV_LOCAL" 2>/dev/null; then
  sed -i '' "s|^DATABASE_URL=.*|DATABASE_URL=$DATABASE_URL|" "$ENV_LOCAL"
else
  echo "DATABASE_URL=$DATABASE_URL" >> "$ENV_LOCAL"
fi
echo "[seed-remote] Patched .env.local with remote DATABASE_URL"

# ── Restore on exit ──
cleanup() {
  if [[ -f "$ENV_BACKUP" ]]; then
    mv "$ENV_BACKUP" "$ENV_LOCAL"
    echo "[seed-remote] Restored original .env.local"
  fi
}
trap cleanup EXIT

# ── Step 1: Push schema ──
echo ""
echo "=== Step 1: prisma db push ==="
cd "$REPO_ROOT"
pnpm exec prisma db push --accept-data-loss 2>&1 | tail -20
echo ""

# ── Step 2: Seed ──
echo "=== Step 2: seed:dev ==="
export THC_SEED_ALLOW_REMOTE_DB=true
export DATABASE_URL
# Remote DBs (Neon serverless) have higher latency; raise the interactive
# transaction timeout from the default 5 000 ms to 30 000 ms.
export PRISMA_TX_TIMEOUT=30000
pnpm -F api seed:dev 2>&1
echo ""

echo "============================================="
echo "  REMOTE SEED COMPLETE"
echo "============================================="
