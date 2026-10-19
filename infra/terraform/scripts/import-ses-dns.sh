#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Import SES DNS records and AWS resources into Terraform state
#
# Prerequisites:
#   1. `source infra/.env.local` (or let tf.sh do it)
#   2. Terraform must be initialized: `terraform init`
#   3. Workspace must be selected: `terraform workspace select dev`
#   4. ADC must be valid: `gcloud auth application-default login`
#
# Usage:
#   cd infra/terraform
#   ./scripts/import-ses-dns.sh
#
# What this does:
#   1. Looks up Cloudflare DNS record IDs for the SES DKIM CNAMEs, MAIL FROM
#      MX, and SPF TXT records that were created via the Cloudflare API.
#   2. Imports them into the correct Terraform resource addresses.
#   3. Imports the SES domain identity, IAM users, and access keys.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TF_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
INFRA_ROOT=$(cd -- "${TF_DIR}/.." && pwd)

# Load local secrets
ENV_FILE="${INFRA_ROOT}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

cd "${TF_DIR}"

# ── Export AWS creds for the aws CLI (TF_VAR_ prefix is for Terraform only) ──
export AWS_ACCESS_KEY_ID="${TF_VAR_aws_access_key_id:?Set TF_VAR_aws_access_key_id}"
export AWS_SECRET_ACCESS_KEY="${TF_VAR_aws_secret_access_key:?Set TF_VAR_aws_secret_access_key}"
export AWS_DEFAULT_REGION="${TF_VAR_aws_region:-us-east-1}"

# ── Cloudflare credentials ──────────────────────────────────────────────────
ZONE_ID="${TF_VAR_cloudflare_zone_id:?Set TF_VAR_cloudflare_zone_id}"
CF_EMAIL="${TF_VAR_cloudflare_email:?Set TF_VAR_cloudflare_email}"
CF_KEY="${TF_VAR_cloudflare_api_key:?Set TF_VAR_cloudflare_api_key}"
DOMAIN="ithasfire.com"

echo "=== SES DNS Record Import Script ==="
echo "Zone ID: ${ZONE_ID}"
echo "Domain:  ${DOMAIN}"
echo ""

# ── Helper: look up a Cloudflare DNS record ID by name + type ───────────────
cf_get_record_id() {
  local name="$1"
  local type="$2"
  local result
  result=$(curl -s -X GET \
    "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?name=${name}&type=${type}" \
    -H "X-Auth-Email: ${CF_EMAIL}" \
    -H "X-Auth-Key: ${CF_KEY}" \
    -H "Content-Type: application/json")

  local record_id
  record_id=$(echo "${result}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data.get('success') and data.get('result'):
    print(data['result'][0]['id'])
else:
    print('NOT_FOUND')
" 2>/dev/null || echo "ERROR")
  echo "${record_id}"
}

# ── Step 1: Look up DKIM CNAME record IDs ──────────────────────────────────
echo "--- Step 1: Looking up DKIM CNAME record IDs ---"

# Get DKIM tokens from TF state (they were already applied via the SES module)
DKIM_TOKENS=$(terraform state show 'module.environment.module.ses[0].aws_sesv2_email_identity.domain' 2>/dev/null \
  | grep -A 5 'tokens' | grep '"' | tr -d ' ",' | head -3)

if [[ -z "${DKIM_TOKENS}" ]]; then
  echo "Could not extract DKIM tokens from state. Trying AWS CLI..."
  DKIM_TOKENS=$(aws sesv2 get-email-identity \
    --email-identity "${DOMAIN}" \
    --region us-east-1 \
    --query 'DkimAttributes.Tokens[]' \
    --output text 2>/dev/null | tr '\t' '\n')
fi

if [[ -z "${DKIM_TOKENS}" ]]; then
  echo "ERROR: Could not fetch DKIM tokens. Get them from the SES console (or" >&2
  echo "'aws ses get-identity-dkim-attributes') and export DKIM_TOKENS." >&2
  exit 1
fi

echo "DKIM tokens:"
echo "${DKIM_TOKENS}"
echo ""

IDX=0
while IFS= read -r token; do
  [[ -z "${token}" ]] && continue
  record_name="${token}._domainkey.${DOMAIN}"
  echo "Looking up CNAME: ${record_name}"
  RECORD_ID=$(cf_get_record_id "${record_name}" "CNAME")

  if [[ "${RECORD_ID}" == "NOT_FOUND" || "${RECORD_ID}" == "ERROR" ]]; then
    echo "  WARNING: Record not found (${RECORD_ID}). Skipping — Terraform will create it."
  else
    echo "  Found: ${RECORD_ID}"
    TF_ADDRESS="cloudflare_record.ses_dkim[\"dkim-${IDX}\"]"
    echo "  Importing: ${TF_ADDRESS} <- ${ZONE_ID}/${RECORD_ID}"

    # Check if already in state
    if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
      echo "  Already in state. Skipping."
    else
      terraform import \
        -var-file=envs/dev/dev.tfvars \
        "${TF_ADDRESS}" \
        "${ZONE_ID}/${RECORD_ID}" || echo "  IMPORT FAILED (may need manual review)"
    fi
  fi
  IDX=$((IDX + 1))
done <<< "${DKIM_TOKENS}"

echo ""

# ── Step 2: Look up MAIL FROM MX record ────────────────────────────────────
echo "--- Step 2: MAIL FROM MX record ---"
MX_NAME="mail.${DOMAIN}"
echo "Looking up MX: ${MX_NAME}"
MX_RECORD_ID=$(cf_get_record_id "${MX_NAME}" "MX")

if [[ "${MX_RECORD_ID}" == "NOT_FOUND" || "${MX_RECORD_ID}" == "ERROR" ]]; then
  echo "  WARNING: MX record not found. Terraform will create it."
else
  echo "  Found: ${MX_RECORD_ID}"
  TF_ADDRESS='cloudflare_record.ses_mail_from_mx[0]'
  if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
    echo "  Already in state. Skipping."
  else
    echo "  Importing: ${TF_ADDRESS} <- ${ZONE_ID}/${MX_RECORD_ID}"
    terraform import \
      -var-file=envs/dev/dev.tfvars \
      "${TF_ADDRESS}" \
      "${ZONE_ID}/${MX_RECORD_ID}" || echo "  IMPORT FAILED"
  fi
fi

echo ""

# ── Step 3: Look up MAIL FROM SPF record ───────────────────────────────────
echo "--- Step 3: MAIL FROM SPF TXT record ---"
echo "Looking up TXT: ${MX_NAME}"
SPF_RECORD_ID=$(cf_get_record_id "${MX_NAME}" "TXT")

if [[ "${SPF_RECORD_ID}" == "NOT_FOUND" || "${SPF_RECORD_ID}" == "ERROR" ]]; then
  echo "  WARNING: SPF TXT record not found. Terraform will create it."
else
  echo "  Found: ${SPF_RECORD_ID}"
  TF_ADDRESS='cloudflare_record.ses_mail_from_spf[0]'
  if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
    echo "  Already in state. Skipping."
  else
    echo "  Importing: ${TF_ADDRESS} <- ${ZONE_ID}/${SPF_RECORD_ID}"
    terraform import \
      -var-file=envs/dev/dev.tfvars \
      "${TF_ADDRESS}" \
      "${ZONE_ID}/${SPF_RECORD_ID}" || echo "  IMPORT FAILED"
  fi
fi

echo ""

# ── Step 4: Import AWS SES domain identity ──────────────────────────────────
echo "--- Step 4: SES domain identity ---"
TF_ADDRESS='module.environment.module.ses[0].aws_sesv2_email_identity.domain'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  echo "  Importing: ${TF_ADDRESS} <- ${DOMAIN}"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "${DOMAIN}" || echo "  IMPORT FAILED"
fi

echo ""

# ── Step 5: Import SES MAIL FROM attributes ─────────────────────────────────
echo "--- Step 5: SES MAIL FROM attributes ---"
TF_ADDRESS='module.environment.module.ses[0].aws_sesv2_email_identity_mail_from_attributes.domain'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  echo "  Importing: ${TF_ADDRESS} <- ${DOMAIN}"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "${DOMAIN}" || echo "  IMPORT FAILED"
fi

echo ""

# ── Step 6: Import SES SMTP IAM user ────────────────────────────────────────
echo "--- Step 6: SES SMTP IAM user (hf-dev-ses-smtp) ---"
TF_ADDRESS='module.environment.module.ses[0].aws_iam_user.smtp'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  echo "  Importing: ${TF_ADDRESS} <- hf-dev-ses-smtp"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "hf-dev-ses-smtp" || echo "  IMPORT FAILED"
fi

echo ""

# ── Step 7: Import SES SMTP IAM policy ──────────────────────────────────────
echo "--- Step 7: SES SMTP IAM policy ---"
TF_ADDRESS='module.environment.module.ses[0].aws_iam_user_policy.smtp_send'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  echo "  Importing: ${TF_ADDRESS} <- hf-dev-ses-smtp:hf-dev-ses-smtp-send"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "hf-dev-ses-smtp:hf-dev-ses-smtp-send" || echo "  IMPORT FAILED"
fi

echo ""

# ── Step 8: Import SES SMTP IAM access key ──────────────────────────────────
echo "--- Step 8: SES SMTP IAM access key ---"
TF_ADDRESS='module.environment.module.ses[0].aws_iam_access_key.smtp'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  # Get the access key ID
  SMTP_ACCESS_KEY_ID=$(aws iam list-access-keys \
    --user-name hf-dev-ses-smtp \
    --query 'AccessKeyMetadata[0].AccessKeyId' \
    --output text 2>/dev/null || echo "")
  echo "  Access key: ${SMTP_ACCESS_KEY_ID}"
  echo "  Importing: ${TF_ADDRESS} <- hf-dev-ses-smtp/${SMTP_ACCESS_KEY_ID}"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "hf-dev-ses-smtp/${SMTP_ACCESS_KEY_ID}" || echo "  IMPORT FAILED (access keys with secrets may need taint/recreate)"
fi

echo ""

# ── Step 9: Import AWS API IAM user (hf-dev-api) ────────────────────────────
echo "--- Step 9: AWS API IAM user (hf-dev-api) ---"
TF_ADDRESS='module.environment.module.aws_hf_api[0].aws_iam_user.api'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  echo "  Importing: ${TF_ADDRESS} <- hf-dev-api"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "hf-dev-api" || echo "  IMPORT FAILED"
fi

echo ""

# ── Step 10: Import AWS API IAM policy ───────────────────────────────────────
echo "--- Step 10: AWS API IAM policy ---"
TF_ADDRESS='module.environment.module.aws_hf_api[0].aws_iam_user_policy.sns_publish'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  echo "  Importing: ${TF_ADDRESS} <- hf-dev-api:hf-dev-api-sns-publish"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "hf-dev-api:hf-dev-api-sns-publish" || echo "  IMPORT FAILED"
fi

echo ""

# ── Step 11: Import AWS API IAM access key ───────────────────────────────────
echo "--- Step 11: AWS API IAM access key ---"
TF_ADDRESS='module.environment.module.aws_hf_api[0].aws_iam_access_key.api'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  API_ACCESS_KEY_ID=$(aws iam list-access-keys \
    --user-name hf-dev-api \
    --query 'AccessKeyMetadata[0].AccessKeyId' \
    --output text 2>/dev/null || echo "")
  echo "  Access key: ${API_ACCESS_KEY_ID}"
  echo "  Importing: ${TF_ADDRESS} <- hf-dev-api/${API_ACCESS_KEY_ID}"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "hf-dev-api/${API_ACCESS_KEY_ID}" || echo "  IMPORT FAILED (access keys with secrets may need taint/recreate)"
fi

echo ""

# ── Step 12: Import SNS topic ───────────────────────────────────────────────
echo "--- Step 12: SNS topic (hf-dev-notifications) ---"
TF_ADDRESS='module.environment.module.sns[0].aws_sns_topic.this'
if terraform state show "${TF_ADDRESS}" >/dev/null 2>&1; then
  echo "  Already in state. Skipping."
else
  SNS_ARN="arn:aws:sns:us-east-1:513758041680:hf-dev-notifications"
  echo "  Importing: ${TF_ADDRESS} <- ${SNS_ARN}"
  terraform import \
    -var-file=envs/dev/dev.tfvars \
    "${TF_ADDRESS}" \
    "${SNS_ARN}" || echo "  IMPORT FAILED"
fi

echo ""

# ── Done ─────────────────────────────────────────────────────────────────────
echo "=== Import complete ==="
echo ""
echo "Next steps:"
echo "  1. Run: terraform plan -var-file=envs/dev/dev.tfvars"
echo "     Check that the plan shows NO unexpected creates/destroys."
echo "  2. If there are drifts (e.g. TTL, content), review and apply:"
echo "     terraform apply -var-file=envs/dev/dev.tfvars"
echo "  3. If IAM access key imports failed (missing secret_key in state),"
echo "     you may need to taint + recreate them and update Cloud Run env:"
echo "     terraform taint 'module.environment.module.ses[0].aws_iam_access_key.smtp'"
echo "     terraform apply -var-file=envs/dev/dev.tfvars"
echo ""
