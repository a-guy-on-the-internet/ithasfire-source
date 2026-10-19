#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 --out <keystore-path> [--alias <alias>] [--storepass <storepass>] [--keypass <keypass>] [--dname "CN=..."]

Creates a new Java keystore suitable for signing Android release builds and prints SHA1/SHA256 fingerprints.

Examples:
  $0 --out ./keystores/ithasfire-release.jks --alias ithasfire-release

Notes:
- You must have 'keytool' available (JDK). On macOS: 'brew install --cask temurin' or 'brew install openjdk'.
- Keep the keystore and passwords secure and do NOT commit them to git.
- If you use Google Play "App Signing by Google Play", you'll need to obtain the Play signing certificate fingerprint from Play Console instead of this keystore for the production fingerprint.
EOF
}

if ! command -v keytool >/dev/null 2>&1; then
  echo "ERROR: 'keytool' not found. Install a JDK (e.g. 'brew install --cask temurin' or 'brew install openjdk') and ensure 'keytool' is on PATH." >&2
  exit 2
fi

OUT=""
ALIAS="ithasfire-release"
STOREPASS=""
KEYPASS=""
DNAME="CN=Ithas Fire, OU=Dev, O=Ithas Fire, L=San Francisco, S=CA, C=US"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) shift; OUT="$1"; shift;;
    --alias) shift; ALIAS="$1"; shift;;
    --storepass) shift; STOREPASS="$1"; shift;;
    --keypass) shift; KEYPASS="$1"; shift;;
    --dname) shift; DNAME="$1"; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [[ -z "$OUT" ]]; then
  echo "--out <keystore-path> is required" >&2
  usage
  exit 2
fi

if [[ -f "$OUT" ]]; then
  echo "Keystore already exists at $OUT. Overwrite? (type 'yes' to confirm)" >&2
  read -r confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborting" >&2
    exit 1
  fi
fi

if [[ -z "$STOREPASS" ]]; then
  read -s -p "Enter store password (will not echo): " STOREPASS
  echo
fi
if [[ -z "$KEYPASS" ]]; then
  read -s -p "Enter key password (or press Enter to use store password): " KEYPASS
  echo
  if [[ -z "$KEYPASS" ]]; then
    KEYPASS="$STOREPASS"
  fi
fi

mkdir -p "$(dirname "$OUT")"

echo "Creating keystore at $OUT with alias $ALIAS..."
keytool -genkeypair -v -keystore "$OUT" -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$STOREPASS" -keypass "$KEYPASS" \
  -dname "$DNAME"

echo "Keystore created. Fingerprints:"
keytool -list -v -keystore "$OUT" -alias "$ALIAS" -storepass "$STOREPASS" -keypass "$KEYPASS" | awk '/SHA1:|SHA256:/'

echo
echo "Copy these fingerprints into Google Cloud Console 'OAuth client for Android' for package name 'com.ithasfire', and/or upload the keystore to Google Play or EAS as appropriate."
