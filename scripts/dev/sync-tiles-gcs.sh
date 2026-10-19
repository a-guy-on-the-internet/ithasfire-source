#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# sync-tiles-gcs.sh — Upload/sync tile data to a GCS bucket
#
# Used to populate the GCS bucket that Cloud Run's tileserver mounts via FUSE.
#
# Usage:
#   ./scripts/dev/sync-tiles-gcs.sh <BUCKET_NAME>
#   ./scripts/dev/sync-tiles-gcs.sh hf-dev-tiles
#   ./scripts/dev/sync-tiles-gcs.sh hf-dev-tiles --source /path/to/openmaptiles.pmtiles
#
# The default source is infra/docker/tileserver/data/openmaptiles.pmtiles
# (same file used by local docker-compose tileserver).
#
# Prerequisites:
#   - gcloud CLI authenticated with storage write access
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BUCKET_NAME="${1:-}"
SOURCE_FILE="$REPO_ROOT/infra/docker/tileserver/data/openmaptiles.pmtiles"

# Parse optional args
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_FILE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$BUCKET_NAME" ]]; then
  echo "Usage: $0 <GCS_BUCKET_NAME> [--source /path/to/file.pmtiles]"
  exit 1
fi

if [[ ! -f "$SOURCE_FILE" ]]; then
  echo "Source file not found: $SOURCE_FILE"
  echo ""
  echo "Download tiles first:"
  echo "  ./scripts/dev/download-tiles.sh"
  exit 1
fi

DEST="gs://$BUCKET_NAME/openmaptiles.pmtiles"
SIZE=$(du -h "$SOURCE_FILE" | cut -f1)

echo "Uploading tile data to GCS..."
echo "  Source:      $SOURCE_FILE ($SIZE)"
echo "  Destination: $DEST"
echo ""

gcloud storage cp "$SOURCE_FILE" "$DEST"

echo ""
echo "Done! Tile data uploaded to $DEST"
echo ""
echo "If the tileserver Cloud Run service is already running, it will"
echo "pick up the new data automatically via GCS FUSE mount."
echo ""
echo "To set up the GCS bucket in Terraform, add to your tfvars:"
echo "  tileserver_gcs_bucket = \"$BUCKET_NAME\""
