#!/usr/bin/env bash
# Reorganize topic-folder specs into date-based folders
# based on git creation date.
#
# Completed specs stay in completed/ subdirs under the date folder.
# Empty topic folders + their READMEs are removed afterward.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SPECS="docs/specs"

# ── helpers ──────────────────────────────────────────────────────
move_spec() {
  local src="$1"
  local date_dir="$2"

  mkdir -p "$date_dir"
  git mv "$src" "$date_dir/"
  echo "  ✓ $(basename "$src") → $date_dir/"
}

# ── Step 1: move active (non-completed) topic-folder specs ──────
echo "=== Moving active specs ==="

# We iterate over every active spec in topic folders,
# look up its git-creation date, and move it.
find "$SPECS" -not -path '*/completed/*' -not -path '*/2026-*' -not -path '*/2025-*' \
  -type f \( -name '*.yaml' -o -name '*.md' -o -name '*.yml' \) \
  ! -name 'README.md' ! -name 'CONTRIBUTING.md' | sort | while read -r f; do

  date=$(git log --diff-filter=A --format='%ai' -- "$f" 2>/dev/null | head -1 | cut -d' ' -f1)
  if [ -z "$date" ]; then
    echo "  ⚠ SKIP (no git history): $f"
    continue
  fi

  target="$SPECS/$date"
  move_spec "$f" "$target"
done

# ── Step 2: move completed specs ────────────────────────────────
echo ""
echo "=== Moving completed specs ==="

find "$SPECS" -path '*/completed/*' -type f \
  ! -name '.gitkeep' | grep -v '2026-\|2025-' | sort | while read -r f; do

  # For completed specs, look up their creation date too
  date=$(git log --diff-filter=A --format='%ai' -- "$f" 2>/dev/null | head -1 | cut -d' ' -f1)
  if [ -z "$date" ]; then
    echo "  ⚠ SKIP (no git history): $f"
    continue
  fi

  target="$SPECS/$date/completed"
  mkdir -p "$target"
  git mv "$f" "$target/"
  echo "  ✓ $(basename "$f") → $target/"
done

# ── Step 3: clean up empty topic folders ────────────────────────
echo ""
echo "=== Cleaning empty topic folders ==="

for dir in backend comms db events jobs libs notifications platform transport ui use-cases; do
  topic="$SPECS/$dir"
  [ -d "$topic" ] || continue

  # Remove READMEs, CONTRIBUTING, .gitkeep files
  find "$topic" -type f \( -name 'README.md' -o -name 'CONTRIBUTING.md' -o -name '.gitkeep' \) -exec git rm -f {} \;

  # Remove empty directories (git doesn't track them)
  find "$topic" -depth -type d -empty -exec rmdir {} \; 2>/dev/null || true

  # If the top-level topic dir is now empty, remove it
  if [ -d "$topic" ] && [ -z "$(ls -A "$topic")" ]; then
    rmdir "$topic"
    echo "  ✓ Removed empty $dir/"
  else
    echo "  ⚠ $dir/ still has files:"
    find "$topic" -type f 2>/dev/null | head -5
  fi
done

echo ""
echo "=== Done. Review with: git status --short | head -60 ==="
