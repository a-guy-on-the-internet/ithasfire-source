#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# download-tiles.sh — Download OpenMapTiles PMTiles for local tileserver
#
# Usage:
#   ./scripts/dev/download-tiles.sh                  # North America, zoom 0-14
#   ./scripts/dev/download-tiles.sh --region planet   # Full planet
#   ./scripts/dev/download-tiles.sh --url <URL>       # Custom direct-download URL
#   ./scripts/dev/download-tiles.sh --gcs <BUCKET>    # Copy from a GCS bucket
#
# The script places the file at infra/docker/tileserver/data/openmaptiles.pmtiles
# which is the path expected by docker-compose and tileserver config.
#
# Data sources (in order of preference):
#   1. --url:    Direct download URL (e.g. a hosted .pmtiles file)
#   2. --gcs:    Copy from a GCS bucket (e.g. gs://th-tiles/openmaptiles.pmtiles)
#   3. Default:  Download a Protomaps PMTiles extract via HTTP range requests
#
# Prerequisites:
#   - curl (for downloads)
#   - For GCS: gcloud CLI authenticated
#   - For default method: pmtiles CLI (brew install pmtiles)
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$REPO_ROOT/infra/docker/tileserver/data"
OUTPUT_FILE="$OUTPUT_DIR/openmaptiles.pmtiles"

# Defaults
REGION="north-america"
DIRECT_URL=""
GCS_PATH=""
MAX_ZOOM=14

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)  REGION="$2"; shift 2 ;;
    --url)     DIRECT_URL="$2"; shift 2 ;;
    --gcs)     GCS_PATH="$2"; shift 2 ;;
    --maxzoom) MAX_ZOOM="$2"; shift 2 ;;
    --output)  OUTPUT_FILE="$2"; shift 2 ;;
    -h|--help)
      head -20 "$0" | grep -E '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

# ---------------------------------------------------------------------------
# If file already exists, ask before overwriting
# ---------------------------------------------------------------------------
if [[ -f "$OUTPUT_FILE" ]]; then
  size=$(du -h "$OUTPUT_FILE" | cut -f1)
  echo "Tile file already exists: $OUTPUT_FILE ($size)"
  read -r -p "Overwrite? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Skipped."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Method 1: Direct URL download
# ---------------------------------------------------------------------------
if [[ -n "$DIRECT_URL" ]]; then
  echo "Downloading from: $DIRECT_URL"
  curl -L --progress-bar -o "$OUTPUT_FILE" "$DIRECT_URL"
  echo "Saved to $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"
  exit 0
fi

# ---------------------------------------------------------------------------
# Method 2: GCS bucket copy
# ---------------------------------------------------------------------------
if [[ -n "$GCS_PATH" ]]; then
  # Ensure it looks like a gs:// path
  if [[ ! "$GCS_PATH" =~ ^gs:// ]]; then
    GCS_PATH="gs://$GCS_PATH"
  fi
  echo "Copying from GCS: $GCS_PATH"
  gcloud storage cp "$GCS_PATH" "$OUTPUT_FILE"
  echo "Saved to $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"
  exit 0
fi

# ---------------------------------------------------------------------------
# Method 3: Download Protomaps PMTiles extract via HTTP range requests
#
# Protomaps basemap daily builds are free (ODbL). For regional extracts the
# pmtiles CLI fetches only the relevant byte ranges — no need to download the
# full planet file. TileServer GL reads PMTiles natively so no conversion is
# needed.
#
# Install pmtiles CLI: brew install pmtiles
# ---------------------------------------------------------------------------

# Check for pmtiles CLI
if ! command -v pmtiles &>/dev/null; then
  echo "------------------------------------------------------------"
  echo "The 'pmtiles' CLI is required for the default download method."
  echo ""
  echo "Install it with:"
  echo "  brew install pmtiles"
  echo ""
  echo "Or use --url or --gcs to provide tiles from another source."
  echo "------------------------------------------------------------"
  exit 1
fi

# Region bounding boxes for pmtiles extract
# Format: minLon,minLat,maxLon,maxLat
declare -A REGION_BOUNDS=(
  ["north-america"]="-170,15,-50,72"
  ["us"]="-125,24,-66,50"
  ["us-conus"]="-125,24,-66,50"
  ["europe"]="-32,34,45,72"
  ["planet"]=""
)

BOUNDS="${REGION_BOUNDS[$REGION]:-}"

# Protomaps daily build URL (latest)
PMTILES_SOURCE="https://build.protomaps.com/20260513.pmtiles"

echo "Region: $REGION"
echo "Max zoom: $MAX_ZOOM"

if [[ -z "$BOUNDS" && "$REGION" == "planet" ]]; then
  echo "Downloading full planet PMTiles (this is ~120 GB, be patient)..."
  curl -L --progress-bar -o "$OUTPUT_FILE" "$PMTILES_SOURCE"
else
  if [[ -z "$BOUNDS" ]]; then
    echo "Unknown region: $REGION"
    echo "Available: ${!REGION_BOUNDS[*]}"
    exit 1
  fi
  echo "Extracting $REGION tiles (bounds: $BOUNDS, maxzoom: $MAX_ZOOM)..."
  echo "This uses HTTP range requests — only the needed bytes are downloaded."
  pmtiles extract "$PMTILES_SOURCE" "$OUTPUT_FILE" \
    --bbox="$BOUNDS" \
    --maxzoom="$MAX_ZOOM"
fi

echo ""
echo "Done! Tile data saved to: $OUTPUT_FILE ($(du -h "$OUTPUT_FILE" | cut -f1))"
echo ""
echo "Start the tileserver with:"
echo "  cd infra/docker && docker compose up -d tileserver"
echo "  Open http://localhost:8081/"
