#!/usr/bin/env zsh
set -euo pipefail

# Build + push stable-tag images for the Cloud Run services.
#
# Goal: CI/CD can simply run this script and push a new image to the same tag,
# while Terraform references the stable tag.
#
# Default behavior:
#   - pushes api/web/jobs to :dev in Artifact Registry
#
# Requirements:
# - gcloud installed + authenticated
# - docker installed/running
# - docker buildx available

SCRIPT_DIR=${0:A:h}
INFRA_DIR=${SCRIPT_DIR:h:h}
ROOT_DIR=${INFRA_DIR:h}

ENV_FILE="${INFRA_DIR}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

PROJECT_ID=${PROJECT_ID:-natural-choir-491400-b7}
REGION=${REGION:-us-east4}
AR_REPO=${AR_REPO:-services}

# Which stable tag to push.
# Recommended: dev/stage/prod.
TAG=${TAG:-dev}

# Image (package) names inside Artifact Registry.
API_IMAGE_NAME=${API_IMAGE_NAME:-api}
WEB_IMAGE_NAME=${WEB_IMAGE_NAME:-web}
JOBS_IMAGE_NAME=${JOBS_IMAGE_NAME:-jobs}

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

build_and_push_one() {
  local name="$1"
  local dockerfile="$2"

  local repo_host="${REGION}-docker.pkg.dev"
  local image_ref="${repo_host}/${PROJECT_ID}/${AR_REPO}/${name}:${TAG}"

  echo "==> Building + pushing ${image_ref}" >&2

  # Build context must be monorepo root because Dockerfiles COPY from
  # workspace-relative paths (apps/, packages/, pnpm-lock.yaml, etc.).
  cd "${ROOT_DIR}"

  local -a build_args
  build_args=()
  if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    build_args+=(--build-arg SKIP_BUILD=1)
  fi

  docker buildx build \
    --platform linux/amd64 \
    --provenance=false \
    --push \
    "${build_args[@]}" \
    -f "${ROOT_DIR}/${dockerfile}" \
    -t "${image_ref}" \
    . \
    --quiet >/dev/null

  echo "${image_ref}"
}

ensure_gcloud_auth
ensure_docker_auth_for_ar

echo ""
echo "==> Building + pushing images (stable tag: ${TAG})"

API_REF=$(build_and_push_one "$API_IMAGE_NAME" "apps/api/Dockerfile")
WEB_REF=$(build_and_push_one "$WEB_IMAGE_NAME" "apps/web/Dockerfile")
JOBS_REF=$(build_and_push_one "$JOBS_IMAGE_NAME" "apps/jobs/Dockerfile")

echo ""
echo "==> Pushed:"
echo "api:  ${API_REF}"
echo "web:  ${WEB_REF}"
echo "jobs: ${JOBS_REF}"
echo ""
echo "==> Terraform should reference these same tags (no digest required)."
