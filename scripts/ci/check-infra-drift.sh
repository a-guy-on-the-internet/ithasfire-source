#!/usr/bin/env bash
#
# Refuse a hotfix whose ref carries infra changes that have not been applied.
# Used by .github/workflows/hotfix.yml preflight.
#
# ── Why not `terraform plan -detailed-exitcode` ───────────────────────────
# A plan would need the ~50 TF_VAR_* secret bindings that deploy-prod.yml
# carries, duplicated per environment. That block rots: the day someone adds a
# TF_VAR to the deploy workflows and not here, the plan either errors or shows
# a phantom diff — and since this check fails closed, it would BLOCK emergency
# deploys. Bricking the emergency lane is a worse outcome than the drift it
# guards against.
#
# A plan also answers a broader question than we need ("is infra drifted at
# all", including drift nobody here caused). The question that matters for a
# hotfix is narrower and is pure git: does THIS ref change infra relative to
# what is currently running? That needs no secrets and cannot rot.
#
# How the deployed commit is resolved: every build tags its image with an
# immutable {env}-<sha> alongside the moving {env} tag, so the tag sharing a
# digest with :$env names the commit in production right now.
#
# Required env: PROJECT_ID REGION AR_REPO IMAGE ENVS REF_SHA
# Optional env: IGNORE_DRIFT (true = warn and proceed)
#
# ENVS is a space-separated list, e.g. "dev prod".

set -uo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"
: "${AR_REPO:?AR_REPO is required}"
: "${IMAGE:?IMAGE is required}"
: "${ENVS:?ENVS is required}"
: "${REF_SHA:?REF_SHA is required}"
IGNORE_DRIFT="${IGNORE_DRIFT:-false}"

base="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${IMAGE}"

# Paths that constitute an "infra change" — kept in lock-step with the `infra`
# path filter in deploy-dev.yml, which is this repo's authoritative definition.
INFRA_PATHS=(infra/terraform apps/jobs/jobs.manifest.json)

# Print the git sha currently deployed for $1, or fail if it can't be resolved.
deployed_sha_for() {
  local env_name="$1" digest tag


  digest="$(gcloud artifacts docker images describe "${base}:${env_name}" \
    --format='value(image_summary.digest)' 2>/dev/null || true)"
  [[ -n "$digest" ]] || return 1

  # Find an immutable <env>-<sha> tag pointing at that same digest and take the
  # sha off it. Matches EITHER prefix on purpose: api/jobs/tileserver reach prod
  # by promotion (`tags add api:dev api:prod`), so a prod digest usually carries
  # only dev-<sha>. The digest identifies one build either way, so whichever
  # env-prefixed tag names it, the commit is the same. Matching just
  # "${env_name}-" would have silently skipped the check for every promoted
  # service. gcloud returns fully-qualified resource names (…/tags/prod-abc1234),
  # hence the basename normalisation.
  sha="$(gcloud artifacts docker tags list "$base" \
    --format='csv[no-heading](tag,version)' 2>/dev/null \
    | awk -F, -v d="$digest" '
        {
          n = split($1, parts, "/")
          short = parts[n]
          if (index($2, d) && short ~ /^(dev|prod)-[0-9a-f]+$/) {
            sub(/^(dev|prod)-/, "", short)
            print short
            exit
          }
        }')"
  [[ -n "$sha" ]] || return 1

  printf '%s' "$sha"
}

rc=0
for env_name in $ENVS; do
  deployed=""
  if ! deployed="$(deployed_sha_for "$env_name")"; then
    echo "::warning::${env_name}: could not resolve the deployed commit from ${base}:${env_name} tags — infra-drift check SKIPPED for ${env_name}. Expected until the first normal deploy after this change landed; investigate if it persists."
    continue
  fi
  echo "${env_name}: deployed commit is ${deployed}"

  if ! git cat-file -e "${deployed}^{commit}" 2>/dev/null; then
    echo "::warning::${env_name}: deployed commit ${deployed} is not present in this checkout — infra-drift check SKIPPED for ${env_name}."
    continue
  fi

  changed="$(git diff --name-only "${deployed}" "${REF_SHA}" -- "${INFRA_PATHS[@]}")"
  if [[ -n "$changed" ]]; then
    echo "::error::${env_name}: this ref changes infrastructure relative to the deployed commit ${deployed}:"
    while IFS= read -r f; do
      [[ -n "$f" ]] && echo "    ${f}"
    done <<< "$changed"
    rc=1
  else
    echo "${env_name}: no infra changes relative to ${deployed}."
  fi
done

if [[ "$rc" -eq 0 ]]; then
  exit 0
fi

if [[ "$IGNORE_DRIFT" == "true" ]]; then
  echo "::warning::Infra changes detected, but ignore_infra_drift=true — proceeding. The hotfix does NOT apply them, so anything reading a new env var or secret will fail at runtime (and probably still pass /health)."
  exit 0
fi

echo "::error::A hotfix does not run terraform. Use deploy-dev.yml / deploy-prod.yml for this ref, or re-dispatch with ignore_infra_drift=true if you are certain the infra change is unrelated to the services you are rolling."
exit 1
