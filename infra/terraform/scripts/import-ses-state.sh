#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Import existing SES/SNS/DNS resources into Terraform state
#
# These resources were created manually (via aws CLI and Cloudflare API)
# before the Terraform modules were written. This script brings them under
# Terraform management so `terraform plan` shows no diff.
#
# Prerequisites:
#   - `terraform init` already run
#   - `dev` workspace selected
#   - infra/.env.local sourced (this script does it automatically via tf.sh)
#   - aws CLI configured (for looking up resource IDs)
#   - Cloudflare API accessible (for looking up DNS record IDs)
#
# Usage:
#   cd infra/terraform
#   bash scripts/import-ses-state.sh
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TF_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
INFRA_ROOT=$(cd -- "${TF_DIR}/.." && pwd)

# Source local secrets
ENV_FILE="${INFRA_ROOT}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  echo "==> Sourcing ${ENV_FILE}"
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
else
  echo "ERROR: ${ENV_FILE} not found" >&2
  exit 1
fi

# Also export standard AWS env vars for the aws CLI commands in this script
export AWS_ACCESS_KEY_ID="${TF_VAR_aws_access_key_id}"
export AWS_SECRET_ACCESS_KEY="${TF_VAR_aws_secret_access_key}"
export AWS_DEFAULT_REGION="${AWS_REGION:-us-east-1}"

# If assume_role_arn is set but the role doesn't exist, imports will fail.
# Unset it for direct-cred imports (the TF_VAR_ version feeds the provider
# config; unsetting it here prevents the aws CLI from trying to assume).
# The Terraform provider will still pick it up from TF_VAR_aws_assume_role_arn.
# But if the role doesn't exist, we need to unset that too:
if [[ -n "${TF_VAR_aws_assume_role_arn:-}" ]]; then
  echo "==> Checking if assume role exists..."
  ROLE_NAME=$(echo "${TF_VAR_aws_assume_role_arn}" | awk -F/ '{print $NF}')
  if ! aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
    echo "    Role '${ROLE_NAME}' does not exist — unsetting TF_VAR_aws_assume_role_arn"
    unset TF_VAR_aws_assume_role_arn
  else
    echo "    Role '${ROLE_NAME}' exists, keeping assume_role config"
  fi
fi

cd "${TF_DIR}"

TFVARS_FILE="envs/dev/dev.tfvars"
ZONE_ID="2681612fabe18dde4f3c2e2084c17a58"
DOMAIN="ithasfire.com"
CF_EMAIL="${TF_VAR_cloudflare_email}"
CF_KEY="${TF_VAR_cloudflare_api_key}"

echo ""
echo "============================================"
echo " Terraform State Import — SES/SNS/DNS (dev)"
echo "============================================"
echo ""

# Ensure dev workspace
echo "==> Selecting dev workspace..."
terraform workspace select dev 2>/dev/null || terraform workspace new dev

# ─────────────────────────────────────────────────────────────────────────────
# 1. AWS SES Domain Identity
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Phase 1: AWS SES resources ──"

echo "  Importing SES domain identity (ithasfire.com)..."
terraform import \
  -var-file="${TFVARS_FILE}" \
  'module.environment.module.ses[0].aws_sesv2_email_identity.domain' \
  "${DOMAIN}" 2>&1 || echo "  (already imported or error — continuing)"

echo "  Importing SES MAIL FROM attributes..."
terraform import \
  -var-file="${TFVARS_FILE}" \
  'module.environment.module.ses[0].aws_sesv2_email_identity_mail_from_attributes.domain' \
  "${DOMAIN}" 2>&1 || echo "  (already imported or error — continuing)"

# SES SMTP IAM user
echo "  Importing SES SMTP IAM user (hf-dev-ses-smtp)..."
terraform import \
  -var-file="${TFVARS_FILE}" \
  'module.environment.module.ses[0].aws_iam_user.smtp' \
  "hf-dev-ses-smtp" 2>&1 || echo "  (already imported or error — continuing)"

# SES SMTP IAM policy
echo "  Importing SES SMTP IAM user policy..."
terraform import \
  -var-file="${TFVARS_FILE}" \
  'module.environment.module.ses[0].aws_iam_user_policy.smtp_send' \
  "hf-dev-ses-smtp:hf-dev-ses-smtp-send" 2>&1 || echo "  (already imported or error — continuing)"

# SES SMTP IAM access key
SMTP_KEY_ID=$(aws iam list-access-keys --user-name hf-dev-ses-smtp --query 'AccessKeyMetadata[0].AccessKeyId' --output text 2>/dev/null || echo "")
if [[ -n "${SMTP_KEY_ID}" && "${SMTP_KEY_ID}" != "None" ]]; then
  echo "  Importing SES SMTP access key (${SMTP_KEY_ID})..."
  terraform import \
    -var-file="${TFVARS_FILE}" \
    'module.environment.module.ses[0].aws_iam_access_key.smtp' \
    "hf-dev-ses-smtp/${SMTP_KEY_ID}" 2>&1 || echo "  (already imported or error — continuing)"
else
  echo "  WARN: Could not find access key for hf-dev-ses-smtp — will be created on apply"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. AWS SNS Topic
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Phase 2: AWS SNS ──"

SNS_TOPIC_ARN=$(aws sns list-topics --region us-east-1 --query "Topics[?ends_with(TopicArn, ':hf-dev-notifications')].TopicArn" --output text 2>/dev/null || echo "")
if [[ -n "${SNS_TOPIC_ARN}" && "${SNS_TOPIC_ARN}" != "None" ]]; then
  echo "  Importing SNS topic (${SNS_TOPIC_ARN})..."
  terraform import \
    -var-file="${TFVARS_FILE}" \
    'module.environment.module.sns[0].aws_sns_topic.this' \
    "${SNS_TOPIC_ARN}" 2>&1 || echo "  (already imported or error — continuing)"
else
  echo "  SNS topic hf-dev-notifications not found — will be created on apply"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. AWS IAM API user (hf-dev-api — for SNS SMS)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Phase 3: AWS IAM API user (hf-dev-api) ──"

echo "  Importing IAM user (hf-dev-api)..."
terraform import \
  -var-file="${TFVARS_FILE}" \
  'module.environment.module.aws_hf_api[0].aws_iam_user.api' \
  "hf-dev-api" 2>&1 || echo "  (already imported or error — continuing)"

echo "  Importing IAM policy (hf-dev-api-sns-publish)..."
terraform import \
  -var-file="${TFVARS_FILE}" \
  'module.environment.module.aws_hf_api[0].aws_iam_user_policy.sns_publish' \
  "hf-dev-api:hf-dev-api-sns-publish" 2>&1 || echo "  (already imported or error — continuing)"

API_KEY_ID=$(aws iam list-access-keys --user-name hf-dev-api --query 'AccessKeyMetadata[0].AccessKeyId' --output text 2>/dev/null || echo "")
if [[ -n "${API_KEY_ID}" && "${API_KEY_ID}" != "None" ]]; then
  echo "  Importing IAM access key (${API_KEY_ID})..."
  terraform import \
    -var-file="${TFVARS_FILE}" \
    'module.environment.module.aws_hf_api[0].aws_iam_access_key.api' \
    "hf-dev-api/${API_KEY_ID}" 2>&1 || echo "  (already imported or error — continuing)"
else
  echo "  WARN: Could not find access key for hf-dev-api — will be created on apply"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Cloudflare DNS records (DKIM + MAIL FROM)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── Phase 4: Cloudflare DNS records ──"

# Fetch all DNS records for the zone
echo "  Fetching Cloudflare DNS records..."
CF_RECORDS=$(curl -sS "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?per_page=100" \
  -H "X-Auth-Email: ${CF_EMAIL}" \
  -H "X-Auth-Key: ${CF_KEY}" 2>/dev/null)

if ! echo "${CF_RECORDS}" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r['success']" 2>/dev/null; then
  echo "  ERROR: Could not fetch Cloudflare DNS records. Check credentials."
  echo "  Response: $(echo "${CF_RECORDS}" | head -200)"
  echo "  Skipping DNS imports — run 'terraform apply' to create them fresh."
else
  # DKIM tokens from SES — export DKIM_TOKENS (space-separated) before running,
  # e.g. from `aws ses get-identity-dkim-attributes --identities "$DOMAIN"`.
  read -r -a DKIM_TOKENS <<< "${DKIM_TOKENS:?Set DKIM_TOKENS to the three SES DKIM tokens for the domain, space-separated}"

  for i in 0 1 2; do
    TOKEN="${DKIM_TOKENS[$i]}"
    RECORD_NAME="${TOKEN}._domainkey.${DOMAIN}"
    RECORD_ID=$(echo "${CF_RECORDS}" | python3 -c "
import sys, json
records = json.load(sys.stdin)['result']
for r in records:
    if r['type'] == 'CNAME' and r['name'] == '${RECORD_NAME}':
        print(r['id'])
        break
" 2>/dev/null || echo "")

    if [[ -n "${RECORD_ID}" ]]; then
      echo "  Importing DKIM CNAME dkim-${i} (${RECORD_ID})..."
      terraform import \
        -var-file="${TFVARS_FILE}" \
        "cloudflare_record.ses_dkim[\"dkim-${i}\"]" \
        "${ZONE_ID}/${RECORD_ID}" 2>&1 || echo "  (already imported or error — continuing)"
    else
      echo "  WARN: DKIM CNAME for ${TOKEN} not found in Cloudflare — will be created on apply"
    fi
  done

  # MAIL FROM MX record
  MX_RECORD_ID=$(echo "${CF_RECORDS}" | python3 -c "
import sys, json
records = json.load(sys.stdin)['result']
for r in records:
    if r['type'] == 'MX' and r['name'] == 'mail.${DOMAIN}':
        print(r['id'])
        break
" 2>/dev/null || echo "")

  if [[ -n "${MX_RECORD_ID}" ]]; then
    echo "  Importing MAIL FROM MX record (${MX_RECORD_ID})..."
    terraform import \
      -var-file="${TFVARS_FILE}" \
      'cloudflare_record.ses_mail_from_mx[0]' \
      "${ZONE_ID}/${MX_RECORD_ID}" 2>&1 || echo "  (already imported or error — continuing)"
  else
    echo "  WARN: MAIL FROM MX record not found — will be created on apply"
  fi

  # MAIL FROM SPF record
  SPF_RECORD_ID=$(echo "${CF_RECORDS}" | python3 -c "
import sys, json
records = json.load(sys.stdin)['result']
for r in records:
    if r['type'] == 'TXT' and r['name'] == 'mail.${DOMAIN}' and 'amazonses' in r.get('content', ''):
        print(r['id'])
        break
" 2>/dev/null || echo "")

  if [[ -n "${SPF_RECORD_ID}" ]]; then
    echo "  Importing MAIL FROM SPF record (${SPF_RECORD_ID})..."
    terraform import \
      -var-file="${TFVARS_FILE}" \
      'cloudflare_record.ses_mail_from_spf[0]' \
      "${ZONE_ID}/${SPF_RECORD_ID}" 2>&1 || echo "  (already imported or error — continuing)"
  else
    echo "  WARN: MAIL FROM SPF record not found — will be created on apply"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Verify
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo " Import complete. Running targeted plan..."
echo "============================================"
echo ""

terraform plan \
  -var-file="${TFVARS_FILE}" \
  -target='module.environment.module.ses' \
  -target='module.environment.module.aws_hf_api' \
  -target='module.environment.module.sns' \
  -target='cloudflare_record.ses_dkim' \
  -target='cloudflare_record.ses_mail_from_mx' \
  -target='cloudflare_record.ses_mail_from_spf' \
  2>&1 | tail -30

echo ""
echo "Done. If the plan shows 0 to add/change/destroy, all resources are imported."
echo "If there are diffs, review them and run 'terraform apply' to reconcile."
