#!/usr/bin/env bash
# Minimal Cloud Run build+deploy helper. Requires gcloud and docker configured.
# Usage: ./deploy-tileserver-cloudrun.sh <PROJECT_ID> <SERVICE_NAME> [REGION]
set -euo pipefail
PROJECT_ID=${1:-}
SERVICE_NAME=${2:-ticket-tileserver}
REGION=${3:-us-central1}
if [ -z "$PROJECT_ID" ]; then
  echo "Usage: $0 <GCP_PROJECT_ID> [SERVICE_NAME] [REGION]"
  exit 1
fi

IMAGE=gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest

echo "Building Docker image ${IMAGE}..."
docker build -t ${IMAGE} -f Dockerfile.tileserver .

echo "Pushing image..."
docker push ${IMAGE}

echo "Deploying to Cloud Run (${REGION})..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE} \
  --region ${REGION} \
  --platform managed \
  --allow-unauthenticated \
  --memory=1Gi \
  --port=8080 \
  --project ${PROJECT_ID}

echo "Done."
