#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Build, push, migrate, and roll Cloud Run services
#
# Usage:
#   ./scripts/deploy.sh dev          # deploy everything to dev
#   ./scripts/deploy.sh dev api web  # deploy only api + web to dev
#   ./scripts/deploy.sh prod         # deploy everything to prod
#
# Prerequisites:
#   - gcloud authenticated (gcloud auth login)
#   - Docker running (for buildx)
#   - Service account key at ~/.config/gcloud/ithasfire-local-dev.json
# ─────────────────────────────────────────────────────────────────────────────

# Source deploy env vars — environment-specific file first, then shared fallback
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
_env_arg="${1:-dev}"
if [[ -f "${SCRIPT_DIR}/../.env.deploy.${_env_arg}" ]]; then
  set -a
  source "${SCRIPT_DIR}/../.env.deploy.${_env_arg}"
  set +a
elif [[ -f "${SCRIPT_DIR}/../.env.deploy" ]]; then
  set -a
  source "${SCRIPT_DIR}/../.env.deploy"
  set +a
fi

ENV="${1:?Usage: deploy.sh <dev|prod> [services...]}"
shift
SERVICES=("${@:-api web jobs}")

# ── Config ───────────────────────────────────────────────────────────────────

PROJECT_ID="hearthfire-491918"
REGION="us-central1"
AR_REGION="us-central1"
AR_REPO="services"
REPO_HOST="${AR_REGION}-docker.pkg.dev"
IMAGE_BASE="${REPO_HOST}/${PROJECT_ID}/${AR_REPO}"
SHA="$(git rev-parse --short HEAD)"

if [[ "$ENV" == "prod" ]]; then
  API_SERVICE="hf-prod-api"
  WEB_SERVICE="hf-prod-web"
  JOBS_SERVICE="hf-prod-jobs"
  TAG="prod"
  DB_URL_VAR="PROD_DATABASE_URL"
elif [[ "$ENV" == "dev" ]]; then
  API_SERVICE="hf-dev-api"
  WEB_SERVICE="hf-dev-web"
  JOBS_SERVICE="hf-dev-jobs"
  TAG="dev"
  DB_URL_VAR="DEV_DATABASE_URL"
else
  echo "Unknown environment: $ENV (use dev or prod)"
  exit 1
fi

# ── Auth ─────────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  DEPLOY ${ENV^^}  ·  services: ${SERVICES[*]}"
echo "  commit: ${SHA}"
echo "═══════════════════════════════════════════════════════"
echo ""

# Ensure docker can push to Artifact Registry
gcloud auth configure-docker "${AR_REGION}-docker.pkg.dev" --quiet 2>/dev/null

# ── Build + Push ─────────────────────────────────────────────────────────────

build_and_push() {
  local service="$1"
  local dockerfile="$2"
  local context="${3:-.}"
  local image="${IMAGE_BASE}/${service}:${TAG}"
  local image_sha="${IMAGE_BASE}/${service}:${TAG}-${SHA}"

  echo ""
  echo "▸ Building ${service}:${TAG} ..."
  echo "  Dockerfile: ${dockerfile}"
  echo "  Image: ${image}"
  echo ""

  # Build args for web (Next.js inlines NEXT_PUBLIC_* at build time)
  local build_args=()
  if [[ "$service" == "web" ]]; then
    # Public URLs are the single source of truth here (mirrors .github/workflows/deploy-*.yml).
    # Never source them from .env.deploy.* — that file drifted to the dead hearthfire.community
    # host and silently disabled the map (NEXT_PUBLIC_TILESERVER_URL empty => isMapEnabled=false).
    if [[ "$ENV" == "dev" ]]; then
      build_args+=(--build-arg "NEXT_PUBLIC_API_BASE_URL=https://api-dev.ithasfire.com")
      build_args+=(--build-arg "NEXT_PUBLIC_SITE_URL=https://web-dev.ithasfire.com")
      build_args+=(--build-arg "NEXT_PUBLIC_TILESERVER_URL=https://tiles-dev.ithasfire.com")
    else
      build_args+=(--build-arg "NEXT_PUBLIC_API_BASE_URL=https://api.ithasfire.com")
      build_args+=(--build-arg "NEXT_PUBLIC_SITE_URL=https://ithasfire.com")
      build_args+=(--build-arg "NEXT_PUBLIC_TILESERVER_URL=https://tiles-prod.ithasfire.com")
    fi
    build_args+=(--build-arg "NEXT_PUBLIC_BUILD_SHA=${SHA}")
    build_args+=(--build-arg "NEXT_PUBLIC_APP_VERSION=${TAG}")
    # Cookieless analytics — opt-in from the caller's environment. Unset means
    # no analytics script is emitted, which is the correct default for a local
    # hand-rolled deploy (never point a manual build at the prod stats site).
    [[ -n "${NEXT_PUBLIC_PLAUSIBLE_DOMAIN:-}" ]] && build_args+=(--build-arg "NEXT_PUBLIC_PLAUSIBLE_DOMAIN=${NEXT_PUBLIC_PLAUSIBLE_DOMAIN}")
    [[ -n "${NEXT_PUBLIC_PLAUSIBLE_SRC:-}" ]] && build_args+=(--build-arg "NEXT_PUBLIC_PLAUSIBLE_SRC=${NEXT_PUBLIC_PLAUSIBLE_SRC}")
    [[ -n "${NEXT_PUBLIC_CF_BEACON_TOKEN:-}" ]] && build_args+=(--build-arg "NEXT_PUBLIC_CF_BEACON_TOKEN=${NEXT_PUBLIC_CF_BEACON_TOKEN}")

    # Keys/secrets only (NOT URLs) — optionally injected from .env.deploy if you have them.
    [[ -n "${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:-}" ]] && build_args+=(--build-arg "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}")
    [[ -n "${NEXT_PUBLIC_GEOAPIFY_API_KEY:-}" ]]       && build_args+=(--build-arg "NEXT_PUBLIC_GEOAPIFY_API_KEY=${NEXT_PUBLIC_GEOAPIFY_API_KEY}")
    [[ -n "${NEXT_PUBLIC_SENTRY_DSN:-}" ]]             && build_args+=(--build-arg "NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}")
  fi

  docker buildx build \
    --platform linux/amd64 \
    --provenance=false \
    --push \
    "${build_args[@]}" \
    -f "${dockerfile}" \
    -t "${image}" \
    -t "${image_sha}" \
    "${context}"

  echo "  ✓ ${service}:${TAG} pushed"
}

for svc in "${SERVICES[@]}"; do
  case "$svc" in
    api)  build_and_push api apps/api/Dockerfile . ;;
    web)  build_and_push web apps/web/Dockerfile . ;;
    jobs) build_and_push jobs apps/jobs/Dockerfile . ;;
    *)    echo "Unknown service: $svc (use api, web, or jobs)" && exit 1 ;;
  esac
done

# ── Migrations ───────────────────────────────────────────────────────────────

echo ""
echo "▸ Running Prisma migrations ..."

if [[ -n "${DATABASE_URL:-}" ]]; then
  # Temporarily overwrite .env.local DATABASE_URL so prisma.config.ts picks up the remote DB
  # (prisma.config.ts does dotenvConfig({ path: ".env.local", override: true }))
  local_db_url=$(grep "^DATABASE_URL=" .env.local 2>/dev/null | cut -d= -f2-)
  if [[ -n "$local_db_url" ]]; then
    sed -i.deploy-bak "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" .env.local
  fi

  npx prisma migrate deploy
  echo "  ✓ Migrations applied"

  # Restore .env.local
  if [[ -f .env.local.deploy-bak ]]; then
    mv .env.local.deploy-bak .env.local
  fi
else
  echo "  ⚠ DATABASE_URL not set — skipping migrations"
  echo "    Set DATABASE_URL in .env.deploy.${ENV} to run migrations"
fi

# ── Roll Cloud Run ───────────────────────────────────────────────────────────

echo ""
echo "▸ Rolling Cloud Run services ..."

roll_service() {
  local service_name="$1"
  local image="$2"

  gcloud run services update "${service_name}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --image="${image}" \
    --quiet 2>/dev/null && echo "  ✓ ${service_name} rolled" || echo "  ⚠ ${service_name} update failed (may auto-deploy on next request)"
}

for svc in "${SERVICES[@]}"; do
  case "$svc" in
    api)  roll_service "${API_SERVICE}"  "${IMAGE_BASE}/api:${TAG}" ;;
    web)  roll_service "${WEB_SERVICE}"  "${IMAGE_BASE}/web:${TAG}" ;;
    jobs) roll_service "${JOBS_SERVICE}" "${IMAGE_BASE}/jobs:${TAG}" ;;
  esac
done

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✓ DEPLOY ${ENV^^} COMPLETE  ·  ${SHA}"
echo "═══════════════════════════════════════════════════════"
echo ""
