#!/usr/bin/env bash
#
# Push secrets + variables into a GitHub repo from a local values file.
#
# Values NEVER pass through argv (visible in `ps` on a shared machine) and are
# never echoed — each is piped to `gh` on stdin. The values file must not be
# committed; see .gitignore.
#
# Usage:
#   cp scripts/github-migration/secrets.env.example github-secrets.env
#   # fill it in, then:
#   ./scripts/github-migration/set-secrets.sh --repo OWNER/REPO --dry-run
#   ./scripts/github-migration/set-secrets.sh --repo OWNER/REPO
#
# --dry-run reports which names are present, missing, or unexpected WITHOUT
# contacting GitHub, so you can close the gaps before touching the remote.
set -euo pipefail

REPO=""
VALUES="github-secrets.env"
DRY=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --values) VALUES="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$REPO" ] || { echo "--repo OWNER/REPO is required" >&2; exit 2; }
[ -f "$VALUES" ] || { echo "values file not found: $VALUES" >&2; exit 2; }

# Expected names come from the inventories generated off the workflows, so this
# script and the workflows can never silently drift apart.
mapfile -t WANT_SECRETS < <(tail -n +2 "$HERE/secrets.inventory.tsv" | cut -f1)
mapfile -t WANT_VARS    < <(tail -n +2 "$HERE/vars.inventory.tsv"    | cut -f1)

have() { grep -qE "^${1}=" "$VALUES"; }
# Everything after the FIRST '=' is the value, so base64 blobs and '=' padding
# (APPLE_PASS_CERTIFICATE_P12_BASE64_*) survive intact.
value_of() { sed -n "s/^${1}=//p" "$VALUES" | head -1; }

missing=(); present=()
for n in "${WANT_SECRETS[@]}" "${WANT_VARS[@]}"; do
  if have "$n"; then present+=("$n"); else missing+=("$n"); fi
done

echo "expected: $(( ${#WANT_SECRETS[@]} + ${#WANT_VARS[@]} ))  present: ${#present[@]}  missing: ${#missing[@]}"
if [ ${#missing[@]} -gt 0 ]; then
  printf 'MISSING: %s\n' "${missing[@]}"
  [ $DRY -eq 1 ] || { echo "refusing to run a partial import; fill these in first" >&2; exit 1; }
fi

if [ $DRY -eq 1 ]; then echo "(dry run — nothing sent)"; exit 0; fi

# Skip keys whose value is empty rather than pushing an empty secret/variable —
# an intentionally-blank key (e.g. GCP_SA_KEY, analytics-off vars) must not be
# created in GitHub as an empty value, and must never CLOBBER an existing one.
set_secrets=0; skipped_secrets=0
for n in "${WANT_SECRETS[@]}"; do
  if [ -z "$(value_of "$n")" ]; then echo "  skip    $n (empty)"; skipped_secrets=$((skipped_secrets+1)); continue; fi
  value_of "$n" | gh secret set "$n" --repo "$REPO" >/dev/null
  echo "  secret  $n"; set_secrets=$((set_secrets+1))
done
set_vars=0; skipped_vars=0
for n in "${WANT_VARS[@]}"; do
  if [ -z "$(value_of "$n")" ]; then echo "  skip    $n (empty)"; skipped_vars=$((skipped_vars+1)); continue; fi
  value_of "$n" | gh variable set "$n" --repo "$REPO" >/dev/null
  echo "  var     $n"; set_vars=$((set_vars+1))
done

echo "done -> $REPO: ${set_secrets} secrets set (${skipped_secrets} empty skipped), ${set_vars} variables set (${skipped_vars} empty skipped)"
