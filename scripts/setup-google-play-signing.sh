#!/usr/bin/env bash
# scripts/setup-google-play-signing.sh
#
# Helper script to set up Google Play App Signing.
# This creates an upload key for signing AABs before uploading to Play Store.
#
# Usage:
#   ./scripts/setup-google-play-signing.sh [--env dev|stage|prod] [--store]
#
# Options:
#   --env     Target environment (default: auto-detect from Terraform)
#   --store   Store the upload key in Google Secret Manager
#
# Prerequisites:
#   - OpenSSL installed
#   - gcloud CLI authenticated (if using --store)
#   - Google Play Console app created with Play App Signing enabled

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
INFRA_DIR="${ROOT_DIR}/infra"

# Defaults
ENVIRONMENT=""
STORE_SECRET=false
KEY_ALIAS="upload"
VALIDITY_DAYS=10950  # ~30 years
DNAME="CN=Ithas Fire,OU=Mobile,O=Ithas Fire,L=San Francisco,ST=California,C=US"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      ENVIRONMENT="$2"
      shift 2
      ;;
    --store)
      STORE_SECRET=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--env dev|stage|prod] [--store]"
      echo ""
      echo "Options:"
      echo "  --env     Target environment (default: auto-detect from Terraform)"
      echo "  --store   Store the upload key in Google Secret Manager"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Auto-detect environment from Terraform if not provided
if [[ -z "$ENVIRONMENT" ]]; then
  if [[ -f "${INFRA_DIR}/scripts/tf.sh" ]]; then
    echo "Auto-detecting environment from Terraform..."
    ENVIRONMENT=$(cd "$INFRA_DIR" && ./scripts/tf.sh output -raw environment 2>/dev/null || echo "")
  fi
  if [[ -z "$ENVIRONMENT" ]]; then
    echo "Could not auto-detect environment. Please specify with --env"
    exit 1
  fi
fi

echo "Environment: $ENVIRONMENT"

# Get project ID
PROJECT_ID=""
if [[ -f "${INFRA_DIR}/scripts/tf.sh" ]]; then
  PROJECT_ID=$(cd "$INFRA_DIR" && ./scripts/tf.sh output -raw project_id 2>/dev/null || echo "")
fi
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="hearthfire-491918"
fi

echo "Project ID: $PROJECT_ID"

# Create output directory
KEYSTORE_DIR="${ROOT_DIR}/keystores"
mkdir -p "$KEYSTORE_DIR"

# Generate timestamp for unique filename
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
KEYSTORE_NAME="ithasfire-upload-${ENVIRONMENT}-${TIMESTAMP}"
KEYSTORE_PATH="${KEYSTORE_DIR}/${KEYSTORE_NAME}.p12"
PASSWORD_FILE="${KEYSTORE_DIR}/${KEYSTORE_NAME}-password.txt"

# Generate random password
PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

echo ""
echo "Generating upload keystore..."
echo "  Keystore: ${KEYSTORE_PATH}"
echo "  Alias: ${KEY_ALIAS}"
echo "  Validity: ${VALIDITY_DAYS} days"

# Generate private key
TEMP_DIR=$(mktemp -d)
PRIVATE_KEY="${TEMP_DIR}/private.key"
CERT="${TEMP_DIR}/cert.pem"

openssl genrsa -out "$PRIVATE_KEY" 2048 2>/dev/null

# Generate self-signed certificate
openssl req -new -x509 \
  -key "$PRIVATE_KEY" \
  -out "$CERT" \
  -days "$VALIDITY_DAYS" \
  -subj "/$DNAME" \
  2>/dev/null

# Create PKCS12 keystore
openssl pkcs12 -export \
  -out "$KEYSTORE_PATH" \
  -inkey "$PRIVATE_KEY" \
  -in "$CERT" \
  -name "$KEY_ALIAS" \
  -passout "pass:${PASSWORD}" \
  2>/dev/null

# Save password locally (for reference)
echo -n "$PASSWORD" > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"

# Extract fingerprints
echo ""
echo "Certificate fingerprints:"
echo "─────────────────────────────────────────────────────────────────"

SHA1=$(openssl x509 -in "$CERT" -fingerprint -sha1 -noout | sed 's/.*=//')
SHA256=$(openssl x509 -in "$CERT" -fingerprint -sha256 -noout | sed 's/.*=//')

echo "  SHA-1:   $SHA1"
echo "  SHA-256: $SHA256"

# Clean up temp files
rm -rf "$TEMP_DIR"

echo ""
echo "Keystore created successfully!"
echo "─────────────────────────────────────────────────────────────────"
echo "  Path:     ${KEYSTORE_PATH}"
echo "  Password: ${PASSWORD_FILE}"
echo "  Alias:    ${KEY_ALIAS}"

# Store in Secret Manager if requested
if [[ "$STORE_SECRET" == true ]]; then
  echo ""
  echo "Storing in Google Secret Manager..."
  
  SECRET_NAME_KEYSTORE="th-${ENVIRONMENT}-android-upload-keystore"
  SECRET_NAME_PASSWORD="th-${ENVIRONMENT}-android-upload-keystore-password"
  
  # Create or update keystore secret
  if gcloud secrets describe "$SECRET_NAME_KEYSTORE" --project="$PROJECT_ID" &>/dev/null; then
    echo "  Updating existing secret: ${SECRET_NAME_KEYSTORE}"
    gcloud secrets versions add "$SECRET_NAME_KEYSTORE" \
      --data-file="$KEYSTORE_PATH" \
      --project="$PROJECT_ID"
  else
    echo "  Creating new secret: ${SECRET_NAME_KEYSTORE}"
    gcloud secrets create "$SECRET_NAME_KEYSTORE" \
      --data-file="$KEYSTORE_PATH" \
      --project="$PROJECT_ID"
  fi
  
  # Create or update password secret
  if gcloud secrets describe "$SECRET_NAME_PASSWORD" --project="$PROJECT_ID" &>/dev/null; then
    echo "  Updating existing secret: ${SECRET_NAME_PASSWORD}"
    echo -n "$PASSWORD" | gcloud secrets versions add "$SECRET_NAME_PASSWORD" \
      --data-file=- \
      --project="$PROJECT_ID"
  else
    echo "  Creating new secret: ${SECRET_NAME_PASSWORD}"
    echo -n "$PASSWORD" | gcloud secrets create "$SECRET_NAME_PASSWORD" \
      --data-file=- \
      --project="$PROJECT_ID"
  fi
  
  echo ""
  echo "Secrets stored:"
  echo "  ${SECRET_NAME_KEYSTORE}"
  echo "  ${SECRET_NAME_PASSWORD}"
fi

echo ""
echo "─────────────────────────────────────────────────────────────────"
echo "NEXT STEPS:"
echo "─────────────────────────────────────────────────────────────────"
echo ""
echo "1. Go to Google Play Console > Your App > Setup > App integrity"
echo ""
echo "2. If you haven't enrolled in Play App Signing yet:"
echo "   - Choose 'Use Google-generated key' (recommended)"
echo "   - Or export your existing key using PEPK tool"
echo ""
echo "3. Upload this keystore as your 'Upload key':"
echo "   - Click 'Upload new upload key certificate'"
echo "   - Use the PEM certificate or upload the .der file"
echo ""
echo "4. Register the SHA-1 fingerprint in Google Cloud Console:"
echo "   - Go to APIs & Services > Credentials"
echo "   - Create/edit Android OAuth client"
echo "   - Package name: com.ithasfire"
echo "   - SHA-1: ${SHA1}"
echo ""
echo "NOTE: After enrolling in Play App Signing, Google will provide"
echo "      the app signing key fingerprint. Use THAT fingerprint"
echo "      (not this upload key) for production OAuth clients."
echo ""
