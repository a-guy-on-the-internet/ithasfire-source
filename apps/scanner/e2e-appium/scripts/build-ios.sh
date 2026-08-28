#!/usr/bin/env bash
# Build the scanner iOS app for the booted simulator with readable output.
#
# - Streams full xcodebuild output to logs/dev/scanner-build/<timestamp>.log
# - Pipes a beautified summary to stdout via xcbeautify
# - Exits non-zero if xcodebuild fails
#
# Usage: ./scripts/build-ios.sh
#        SCHEME=IthasFireScanner CONFIGURATION=Debug ./scripts/build-ios.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCANNER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$SCANNER_DIR/../.." && pwd)"

SCHEME="${SCHEME:-IthasFireScanner}"
CONFIGURATION="${CONFIGURATION:-Debug}"
DESTINATION="${DESTINATION:-generic/platform=iOS Simulator}"
WORKSPACE="$SCANNER_DIR/ios/IthasFireScanner.xcworkspace"

if [ ! -d "$WORKSPACE" ]; then
  echo "Workspace not found: $WORKSPACE" >&2
  echo "Run 'pnpm -F scanner exec expo prebuild --platform ios' first." >&2
  exit 1
fi

if ! command -v xcbeautify >/dev/null 2>&1; then
  echo "xcbeautify not installed. Install with: brew install xcbeautify" >&2
  exit 1
fi

LOG_DIR="$REPO_ROOT/logs/dev/scanner-build"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
RAW_LOG="$LOG_DIR/build-$TS.log"

echo "→ scheme:        $SCHEME"
echo "→ configuration: $CONFIGURATION"
echo "→ destination:   $DESTINATION"
echo "→ raw log:       $RAW_LOG"
echo

# Tee the full log to disk and pipe a summary via xcbeautify to the terminal.
set +e
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "$DESTINATION" \
  -derivedDataPath "$LOG_DIR/.derived-data" \
  -quiet \
  build 2>&1 | tee "$RAW_LOG" | xcbeautify --renderer terminal --is-ci
STATUS=${PIPESTATUS[0]}
set -e

echo
if [ "$STATUS" -eq 0 ]; then
  APP_PATH="$(find "$LOG_DIR/.derived-data/Build/Products" -name "$SCHEME.app" -type d | head -1)"
  echo "✓ Build succeeded"
  [ -n "$APP_PATH" ] && echo "  app: $APP_PATH"
  echo "  full log: $RAW_LOG"
else
  echo "✗ Build failed (exit $STATUS)"
  echo "  full log: $RAW_LOG"
  echo
  echo "Recent errors:"
  grep -E "(error:|fatal error:)" "$RAW_LOG" | tail -20 || true
fi

exit "$STATUS"
