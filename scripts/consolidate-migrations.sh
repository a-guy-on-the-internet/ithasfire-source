#!/usr/bin/env bash
set -euo pipefail

# Consolidate all Prisma migrations into a single baseline.
#
# Approach (Prisma-recommended "squash"):
# 1. Delete all existing migration folders
# 2. Use `prisma migrate diff` to generate a single SQL from the current schema
# 3. Place it in a new timestamped baseline folder
# 4. Keep migration_lock.toml untouched
#
# This is safe because:
# - No production database exists yet (fresh deploy)
# - Dev DB will be reset with `prisma migrate reset` or `db push`

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PKG="$REPO_ROOT/packages/db"
MIGRATIONS_DIR="$DB_PKG/prisma/migrations"

echo "=== Consolidating Prisma migrations ==="
echo "Working in: $MIGRATIONS_DIR"

# 1. Remove all migration folders (keep migration_lock.toml)
echo ""
echo "Step 1: Removing existing migration folders..."
for dir in "$MIGRATIONS_DIR"/*/; do
  if [ -d "$dir" ]; then
    dirname=$(basename "$dir")
    echo "  Removing: $dirname"
    rm -rf "$dir"
  fi
done

# 2. Create new baseline folder
BASELINE_NAME="20260407000000_consolidated_baseline"
BASELINE_DIR="$MIGRATIONS_DIR/$BASELINE_NAME"
mkdir -p "$BASELINE_DIR"
echo ""
echo "Step 2: Created $BASELINE_NAME/"

# 3. Generate SQL from current schema using prisma migrate diff
echo ""
echo "Step 3: Generating baseline SQL from current schema..."
cd "$REPO_ROOT"

# prisma migrate diff: from empty DB -> to current schema = full CREATE DDL
# Must run from repo root so prisma.config.ts is found, and pass the
# directory path (multi-file schema) — NOT a single .prisma file.
npx prisma migrate diff \
  --from-empty \
  --to-schema ./packages/db/prisma/ \
  --script 2>&1 \
  | grep -v 'npm warn\|dotenv\|Loaded Prisma' \
  > "$BASELINE_DIR/migration.sql"

LINE_COUNT=$(wc -l < "$BASELINE_DIR/migration.sql")
echo "  Generated migration.sql ($LINE_COUNT lines)"

# 4. Verify
echo ""
echo "Step 4: Verifying..."
if [ "$LINE_COUNT" -lt 100 ]; then
  echo "ERROR: migration.sql seems too short ($LINE_COUNT lines). Something went wrong."
  exit 1
fi

echo ""
echo "=== Done ==="
echo ""
echo "Migration consolidated into: $BASELINE_NAME/migration.sql"
echo ""
echo "Next steps:"
echo "  1. Run 'pnpm db:validate' to verify schema is valid"
echo "  2. Run 'pnpm -F @th/db prisma generate' to regenerate client"
echo "  3. For local dev: 'pnpm -F @th/db prisma migrate reset' (wipes + re-applies)"
echo "  4. For prod: 'prisma migrate resolve --applied $BASELINE_NAME' after db push"
