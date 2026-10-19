#!/usr/bin/env bash
set -euo pipefail

# Generate a PKCS#12 (P12) keystore and optionally store it in Google Secret Manager.
# This avoids requiring 'keytool' / JDK for initial generation (we use OpenSSL).
#
# Usage:
#   ./scripts/generate-android-keystore-and-store.sh [--env dev] [--out ./keystores/my.jks] [--alias <alias>] [--store] [--add-member <member>]
#
# Examples:
#   ./scripts/generate-android-keystore-and-store.sh --store --add-member "serviceAccount:ci@PROJECT.iam.gserviceaccount.com"
#
# Notes:
# - The script will output SHA-1 and SHA-256 certificate fingerprints suitable for Google OAuth/Play Console.
# - If --store is passed, it will create two secrets in Secret Manager:
#     th-<env>-android-release-keystore          (binary P12)
#     th-<env>-android-release-keystore-password (text)
# - Keep the keystore and password safe. Do NOT commit them to source control.

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

ENV="dev"
OUT_DIR="$ROOT_DIR/keystores"
OUT_FILE="" # if empty will be generated
ALIAS="ithasfire-release"
STORE=0
ADD_MEMBER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) shift; ENV="$1"; shift;;
    --out) shift; OUT_FILE="$1"; shift;;
    --alias) shift; ALIAS="$1"; shift;;
    --store) STORE=1; shift;;
    --add-member) shift; ADD_MEMBER="$1"; shift;;
    -h|--help) echo "Usage: $0 [--env dev] [--out <path>] [--alias <alias>] [--store] [--add-member <member>]"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

# If ENV not provided explicitly, try to read it from Terraform outputs
if [[ -z "${ENV-}" || "${ENV}" == "dev" ]]; then
  if [[ -d "$INFRA_DIR" && -x "$INFRA_DIR/scripts/tf.sh" ]]; then
    TF_ENV=$(cd "$INFRA_DIR" && ./scripts/tf.sh output -json 2>/dev/null | jq -r '.environment.value' 2>/dev/null || true)
    if [[ -n "$TF_ENV" && "$TF_ENV" != "null" ]]; then
      ENV="$TF_ENV"
      echo "Detected terraform workspace environment: $ENV"
    fi
  fi
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: OpenSSL is required but not found in PATH." >&2
  exit 2
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "WARNING: gcloud not found. --store will not work without gcloud CLI installed." >&2
  if [[ $STORE -eq 1 ]]; then
    echo "Install gcloud CLI and ensure you're authenticated with a project that has Secret Manager enabled." >&2
    exit 2
  fi
fi

mkdir -p "$OUT_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
if [[ -z "$OUT_FILE" ]]; then
  OUT_FILE="$OUT_DIR/ithasfire-release-${TIMESTAMP}.p12"
fi
TMP_DIR=$(mktemp -d)
KEY_PEM="$TMP_DIR/key.pem"
CERT_PEM="$TMP_DIR/cert.pem"
PKCS12="$OUT_FILE"

# Generate a strong random password
PASSWORD=$(openssl rand -base64 32)

echo "Generating private key and self-signed certificate..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$KEY_PEM"
# 10000 days ~= ~27 years
openssl req -new -x509 -days 10000 -key "$KEY_PEM" -out "$CERT_PEM" -subj "/CN=Ithas Fire/O=Ithas Fire/C=US"

echo "Exporting PKCS#12 keystore to: $PKCS12"
openssl pkcs12 -export -inkey "$KEY_PEM" -in "$CERT_PEM" -name "$ALIAS" -out "$PKCS12" -passout pass:"$PASSWORD"

# Compute fingerprints
SHA1_COLON=$(openssl x509 -in "$CERT_PEM" -noout -fingerprint -sha1 | sed 's/^.*=//')
SHA1_NOCOLON=$(echo "$SHA1_COLON" | sed 's/://g')
SHA256_COLON=$(openssl x509 -in "$CERT_PEM" -noout -fingerprint -sha256 | sed 's/^.*=//')
SHA256_NOCOLON=$(echo "$SHA256_COLON" | sed 's/://g')

echo ""
echo "Generated keystore: $PKCS12"
echo "Keystore alias: $ALIAS"
echo "Keystore password: (stored in Secret Manager when --store is used)"
echo ""
echo "Certificate fingerprints (use these in Google Console / Play Console):"
echo "SHA1  : $SHA1_COLON"
echo "SHA1  (no-colon): $SHA1_NOCOLON"
echo "SHA256: $SHA256_COLON"
echo "SHA256 (no-colon): $SHA256_NOCOLON"

if [[ $STORE -eq 1 ]]; then
  if [[ -z "${PROJECT_ID:-}" ]]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
  fi
  if [[ -z "$PROJECT_ID" ]]; then
    echo "ERROR: Could not determine GCP project. Configure gcloud with 'gcloud config set project <PROJECT>' or set PROJECT_ID env var." >&2
    exit 2
  fi

  SECRET_ID="th-${ENV}-android-release-keystore"
  SECRET_PASS_ID="th-${ENV}-android-release-keystore-password"

  echo "Storing keystore in Secret Manager as: $SECRET_ID (project: $PROJECT_ID)"
  if gcloud secrets describe "$SECRET_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "Secret exists, adding new version..."
    gcloud secrets versions add "$SECRET_ID" --data-file="$PKCS12" --project="$PROJECT_ID"
  else
    echo "Creating secret..."
    gcloud secrets create "$SECRET_ID" --data-file="$PKCS12" --replication-policy="automatic" --project="$PROJECT_ID"
  fi

  echo "Storing keystore password in Secret Manager as: $SECRET_PASS_ID"
  if gcloud secrets describe "$SECRET_PASS_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets versions add "$SECRET_PASS_ID" --data-file=<(echo -n "$PASSWORD") --project="$PROJECT_ID"
  else
    echo -n "$PASSWORD" | gcloud secrets create "$SECRET_PASS_ID" --data-file=- --replication-policy="automatic" --project="$PROJECT_ID"
  fi

  echo "Secrets stored. To access keystore locally run:"
  echo "  gcloud secrets versions access latest --secret=$SECRET_ID --project=$PROJECT_ID > ./keystores/ithasfire-release.p12"
  echo "  gcloud secrets versions access latest --secret=$SECRET_PASS_ID --project=$PROJECT_ID | tr -d '\n' > ./keystores/ithasfire-release-password.txt"

  if [[ -n "$ADD_MEMBER" ]]; then
    echo "Adding IAM binding: $ADD_MEMBER -> roles/secretmanager.secretAccessor"
    gcloud secrets add-iam-policy-binding "$SECRET_ID" --member="$ADD_MEMBER" --role="roles/secretmanager.secretAccessor" --project="$PROJECT_ID"
    gcloud secrets add-iam-policy-binding "$SECRET_PASS_ID" --member="$ADD_MEMBER" --role="roles/secretmanager.secretAccessor" --project="$PROJECT_ID"
    echo "Added IAM binding."
  else
    echo "NOTE: No additional IAM bindings added. You may want to grant your CI/service account access with:"
    echo "  gcloud secrets add-iam-policy-binding $SECRET_ID --member='serviceAccount:YOUR_SA@${PROJECT_ID}.iam.gserviceaccount.com' --role=roles/secretmanager.secretAccessor --project=$PROJECT_ID"
  fi
fi

# Cleanup
rm -rf "$TMP_DIR"

echo "Done"
