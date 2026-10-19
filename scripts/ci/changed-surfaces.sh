#!/usr/bin/env bash
set -euo pipefail

# Outputs a JSON object with booleans: {"api":true/false,"web":...}
#
# Usage:
#   changed-surfaces.sh <base> <head>
# Example:
#   changed-surfaces.sh origin/main HEAD

BASE_REF="${1:?base ref required}"
HEAD_REF="${2:-HEAD}"

files=$(git diff --name-only "$BASE_REF" "$HEAD_REF" || true)

api=false
web=false
jobs=false
mobile=false

global=false

while IFS= read -r f; do
  [[ -z "$f" ]] && continue

  # Global/build-system changes that should rebuild everything.
  if [[ "$f" == "package.json" || "$f" == "pnpm-lock.yaml" || "$f" == "pnpm-workspace.yaml" || "$f" == "turbo.json" || "$f" == "tsconfig.base.json" || "$f" == ".dockerignore" ]]; then
    global=true
  fi

  # Shared packages impact all runtimes.
  if [[ "$f" == packages/* ]]; then
    global=true
  fi

  if [[ "$f" == apps/api/* ]]; then api=true; fi
  if [[ "$f" == apps/web/* ]]; then web=true; fi
  if [[ "$f" == apps/jobs/* ]]; then jobs=true; fi
  if [[ "$f" == apps/mobile/* ]]; then mobile=true; fi
done <<< "$files"

if [[ "$global" == true ]]; then
  api=true
  web=true
  jobs=true
  mobile=true
fi

printf '{"api":%s,"web":%s,"jobs":%s,"mobile":%s}\n' "$api" "$web" "$jobs" "$mobile"
