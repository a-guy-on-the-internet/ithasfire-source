#!/usr/bin/env zsh
set -euo pipefail

# Build + push + deploy (dev)
#
# This is the "gcloud-based/docker pipeline".
# It pushes stable tags (default :dev) and then redeploys Cloud Run services so
# they pick up the newly-pushed digest.
#
# Usage:
#   ./infra/scripts/deploy-dev.zsh
#   TAG=dev ./infra/scripts/deploy-dev.zsh
#   SKIP_BUILD=1 ./infra/scripts/deploy-dev.zsh
#   DEPLOY_WEB=0 ./infra/scripts/deploy-dev.zsh

SCRIPT_DIR=${0:A:h}
INFRA_DIR=${SCRIPT_DIR:h}
ROOT_DIR=${INFRA_DIR:h}

ENV_FILE="${INFRA_DIR}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

PROJECT_ID=${PROJECT_ID:-natural-choir-491400-b7}
REGION=${REGION:-us-east4}
AR_REPO=${AR_REPO:-services}
TAG=${TAG:-dev}

DEPLOY_API=${DEPLOY_API:-1}
DEPLOY_WEB=${DEPLOY_WEB:-1}
DEPLOY_JOBS=${DEPLOY_JOBS:-1}

SERVICE_API_NAME=${SERVICE_API_NAME:-hf-dev-api}
SERVICE_WEB_NAME=${SERVICE_WEB_NAME:-hf-dev-web}
SERVICE_JOBS_NAME=${SERVICE_JOBS_NAME:-hf-dev-jobs}

ensure_gcloud_auth() {
  if ! command -v gcloud >/dev/null; then
    echo "gcloud is required" >&2
    exit 1
  fi

  if ! gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q .; then
    echo "No active gcloud auth. Run: gcloud auth login" >&2
    exit 1
  fi

  gcloud config set project "$PROJECT_ID" >/dev/null
}

ensure_docker_auth_for_ar() {
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null
}

deploy_one() {
  local service_name="$1"
  local image_name="$2"

  local repo_host="${REGION}-docker.pkg.dev"
  local image_ref="${repo_host}/${PROJECT_ID}/${AR_REPO}/${image_name}:${TAG}"

  echo "==> Deploying ${service_name} -> ${image_ref}" >&2

  # NOTE: We use explicit deploy to force a new revision that resolves the tag
  # to the latest digest.
  gcloud run deploy "${service_name}" \
    --region "${REGION}" \
    --image "${image_ref}" \
    --quiet >/dev/null
}

ensure_gcloud_auth
ensure_docker_auth_for_ar

# Build + push stable tags.
"${INFRA_DIR}/scripts/build-push-tags.zsh"

echo ""
echo "==> Redeploying Cloud Run services to pick up new digests"

if [[ "${DEPLOY_API}" == "1" ]]; then
  deploy_one "${SERVICE_API_NAME}" "api"
fi

if [[ "${DEPLOY_WEB}" == "1" ]]; then
  deploy_one "${SERVICE_WEB_NAME}" "web"
fi

if [[ "${DEPLOY_JOBS}" == "1" ]]; then
  deploy_one "${SERVICE_JOBS_NAME}" "jobs"
fi

echo ""
echo "==> Done"
