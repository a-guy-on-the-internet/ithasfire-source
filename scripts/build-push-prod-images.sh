#!/usr/bin/env bash
set -euo pipefail

# Build and push :prod Docker images to Artifact Registry from the local machine.
# This is the bootstrap path — once CI has prod GH env vars, deploy-prod.yml handles this.
#
# Prerequisites:
#   gcloud auth configure-docker us-central1-docker.pkg.dev

REPO="us-central1-docker.pkg.dev/hearthfire-491918/services"
TAG="prod"

# Prod NEXT_PUBLIC_* values (must be inlined at build time for Next.js)
NEXT_PUBLIC_API_BASE_URL="https://api.ithasfire.com"
NEXT_PUBLIC_SITE_URL="https://ithasfire.com"
NEXT_PUBLIC_TILESERVER_URL="https://hf-prod-tileserver-l6drul4wfq-uc.a.run.app"
NEXT_PUBLIC_SENTRY_DSN=""
NEXT_PUBLIC_GEOAPIFY_API_KEY=""
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""
NEXT_PUBLIC_BUILD_SHA="$(git rev-parse --short HEAD)"
NEXT_PUBLIC_APP_VERSION="0.1.0"

cd "$(git rev-parse --show-toplevel)"

echo "=== Configuring Docker auth ==="
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet 2>/dev/null

echo ""
echo "=== Building api:${TAG} ==="
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --push \
  -f apps/api/Dockerfile \
  -t "${REPO}/api:${TAG}" \
  .

echo ""
echo "=== Building web:${TAG} ==="
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --push \
  -f apps/web/Dockerfile \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}" \
  --build-arg "NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}" \
  --build-arg "NEXT_PUBLIC_TILESERVER_URL=${NEXT_PUBLIC_TILESERVER_URL}" \
  --build-arg "NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}" \
  --build-arg "NEXT_PUBLIC_GEOAPIFY_API_KEY=${NEXT_PUBLIC_GEOAPIFY_API_KEY}" \
  --build-arg "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY}" \
  --build-arg "NEXT_PUBLIC_BUILD_SHA=${NEXT_PUBLIC_BUILD_SHA}" \
  --build-arg "NEXT_PUBLIC_APP_VERSION=${NEXT_PUBLIC_APP_VERSION}" \
  -t "${REPO}/web:${TAG}" \
  .

echo ""
echo "=== Building jobs:${TAG} ==="
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --push \
  -f apps/jobs/Dockerfile \
  -t "${REPO}/jobs:${TAG}" \
  .

echo ""
echo "=== Done ==="
echo "Images pushed:"
echo "  ${REPO}/api:${TAG}"
echo "  ${REPO}/web:${TAG}"
echo "  ${REPO}/jobs:${TAG}"
echo ""
echo "Next: cd infra/terraform && source ../../infra/.env.local && terraform apply -var-file=envs/prod/prod.tfvars"
