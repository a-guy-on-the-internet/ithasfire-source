#!/usr/bin/env bash
#
# Roll ONE Cloud Run service to its :$ENV_NAME image, probe it, and perform a
# TERRAFORM-DURABLE rollback if the probe fails. Used by .github/workflows/
# hotfix.yml for both the dev and prod rolls.
#
# ── Why "terraform-durable" is the whole point ────────────────────────────
# infra/terraform/modules/cloud-run-service/main.tf declares
#   traffic { type = TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST, percent = 100 }
# and DELIBERATELY does not ignore changes to the container image — both so a
# pinned revision can never survive (that is how hf-dev-tileserver got stuck
# serving an ancient revision at 100% behind green pipelines).
#
# The consequence for rollback: the obvious move — pinning traffic to the
# previous revision — is UNDONE by the next `terraform apply`, which reasserts
# latest=100% and routes traffic straight back onto the broken revision. And
# the *_image tfvars (infra/terraform/envs/*/*.tfvars) are the MOVING tags
# (…/web:prod), so terraform also reasserts whatever :$ENV_NAME points at.
#
# A rollback that actually holds therefore has to restore the state terraform
# asserts, not fight it:
#   1. pin traffic to the last-good revision      — stops the bleeding in seconds
#   2. move the :$ENV_NAME tag back to the last-good digest
#   3. deploy that tag, creating a new latest revision from the good image
#   4. unpin (--to-latest) — the service now matches what terraform wants
# If 2-4 fail we keep the pin from step 1 and shout loudly, because a
# non-durable rollback still beats serving the broken revision.
#
# Required env: PROJECT_ID REGION AR_REPO IMAGE ENV_NAME SVC
# Optional env: PROBE_PATH (empty = no HTTP probe) PROBE_AUTH (public|authed)

set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"
: "${AR_REPO:?AR_REPO is required}"
: "${IMAGE:?IMAGE is required}"
: "${ENV_NAME:?ENV_NAME is required}"
: "${SVC:?SVC is required}"
PROBE_PATH="${PROBE_PATH:-}"
PROBE_AUTH="${PROBE_AUTH:-public}"

base="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${IMAGE}"
image="${base}:${ENV_NAME}"

describe() {
  gcloud run services describe "$SVC" --region "$REGION" --project "$PROJECT_ID" "$@"
}

# status.traffic[0] is the revision actually TAKING TRAFFIC, which is not
# always latestReady: a service pinned to a named revision serves an older one,
# and "rolling back" to latestReady would move traffic FORWARD onto the bad
# revision. Fall back to latestReady only when the traffic block is empty.
prior="$(describe --format='value(status.traffic[0].revisionName)')"
if [[ -z "$prior" ]]; then
  prior="$(describe --format='value(status.latestReadyRevisionName)')"
fi
echo "Currently serving: ${prior:-<none>}"

# Resolve the digest that revision runs BEFORE the tag moves off it — after
# the roll, :$ENV_NAME no longer points at the good image.
prior_digest=""
if [[ -n "$prior" ]]; then
  prior_digest="$(gcloud run revisions describe "$prior" \
    --region "$REGION" --project "$PROJECT_ID" \
    --format='value(status.imageDigest)' 2>/dev/null || true)"
  echo "Last-good digest: ${prior_digest:-<unresolved>}"
fi

echo "── Rolling ${ENV_NAME}/${SVC} to ${image} ──"
gcloud run deploy "$SVC" \
  --region "$REGION" --project "$PROJECT_ID" --image "$image" --quiet
# Repair pinned-traffic drift (latestRevision:false) exactly as the main
# pipelines do — otherwise a green roll can keep serving the old revision.
gcloud run services update-traffic "$SVC" \
  --region "$REGION" --project "$PROJECT_ID" --to-latest --quiet

describe --format='yaml(metadata.name,status.url,status.latestReadyRevisionName,status.conditions)'

if [[ -z "$PROBE_PATH" ]]; then
  echo "No HTTP probe for ${IMAGE} (internal ingress) — trusting the Ready condition above."
  exit 0
fi

url="$(describe --format='value(status.url)')"
if [[ -z "$url" ]]; then
  echo "::error::Could not resolve the service URL for ${SVC}."
  exit 1
fi
target="${url%/}${PROBE_PATH}"

# Retry: dev scales to zero, so the first request after a roll boots the
# container and warms the api + Neon chain, which legitimately exceeds 30s.
curl_args=(--fail --silent --show-error --location
  --max-time 60 --retry 3 --retry-delay 10 --retry-all-errors)

echo "Probing ${target}"
probe_rc=0
if [[ "$PROBE_AUTH" == "authed" ]]; then
  token="$(gcloud auth print-identity-token --audiences="$url")"
  curl "${curl_args[@]}" -H "Authorization: Bearer ${token}" "$target" > /dev/null || probe_rc=$?
else
  curl "${curl_args[@]}" "$target" > /dev/null || probe_rc=$?
fi

if [[ "$probe_rc" -eq 0 ]]; then
  echo "${ENV_NAME}/${SVC} healthy on the new revision."
  exit 0
fi

# ── Rollback ────────────────────────────────────────────────────────────────
if [[ -z "$prior" ]]; then
  echo "::error::Probe failed and there is no prior revision to roll back to. ${SVC} needs manual attention."
  exit 1
fi

echo "::error::Probe failed — rolling back to ${prior}."

# Step 1: immediate. Seconds, and independent of everything below.
gcloud run services update-traffic "$SVC" \
  --region "$REGION" --project "$PROJECT_ID" \
  --to-revisions="${prior}=100" --quiet
echo "Traffic pinned to ${prior}. Making that durable…"

not_durable() {
  echo "::error::${SVC} is serving ${prior} via a PINNED traffic split, which is NOT durable: the next terraform apply reasserts latest=100% and routes traffic back to the BROKEN revision. Point ${image} at a good digest and redeploy BEFORE any terraform apply."
  exit 1
}

if [[ -z "$prior_digest" ]]; then
  echo "::warning::Could not resolve the last-good image digest, so ${image} could not be moved back."
  not_durable
fi

# Step 2: terraform's *_image tfvar IS this moving tag, so the tag must point
# at the good digest or apply will re-deploy the broken image.
if ! gcloud artifacts docker tags add "$prior_digest" "$image" --quiet; then
  echo "::error::Failed to move ${image} back to ${prior_digest}."
  not_durable
fi
echo "Moved ${image} back to ${prior_digest}."

# Steps 3+4: new latest revision from the good image, traffic back on latest.
gcloud run deploy "$SVC" \
  --region "$REGION" --project "$PROJECT_ID" --image "$image" --quiet
gcloud run services update-traffic "$SVC" \
  --region "$REGION" --project "$PROJECT_ID" --to-latest --quiet

echo "::warning::Rolled back. ${SVC} serves the previous image as a NEW latest revision and ${image} points at it, so this survives terraform apply. The broken build is still tagged ${base}:${ENV_NAME}-<sha> for forensics."
exit 1
