#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# setup-secrets.sh — Interactive secret setup for local deploys + Forgejo
#
# Writes to:
#   .env.deploy     — sourced by deploy.sh for Docker build args
#   Forgejo secrets — via API (for future CI/CD)
#
# Usage: ./scripts/setup-secrets.sh
# ─────────────────────────────────────────────────────────────────────────────

FORGEJO_URL="https://git.unme.me"
FORGEJO_REPO="Somehuman/ithasfire"
FORGEJO_TOKEN="${FORGEJO_TOKEN:-}"
FORGEJO_SKIP_WARNED=0
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.deploy"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Ithas Fire Secret Setup"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "This will set secrets in:"
echo "  1. .env.deploy (local deploys)"
echo "  2. Forgejo repo secrets (CI/CD)"
echo ""
echo "Press Enter to skip any value you don't have yet."
echo ""

# ── Helper ───────────────────────────────────────────────────────────────────

set_forgejo_secret() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then return; fi

  if [[ -z "$FORGEJO_TOKEN" ]]; then
    if [[ "$FORGEJO_SKIP_WARNED" -eq 0 ]]; then
      echo "  ! Forgejo secrets skipped: FORGEJO_TOKEN is not set; local .env.deploy writes still work."
      FORGEJO_SKIP_WARNED=1
    fi
    echo "  ⤳ Forgejo: ${name} (skipped)"
    return 0
  fi

  curl -s -X PUT "${FORGEJO_URL}/api/v1/repos/${FORGEJO_REPO}/actions/secrets/${name}" \
    -H "Authorization: token ${FORGEJO_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"data\": $(python3 -c "import json; print(json.dumps('$value'))")}" >/dev/null 2>&1 \
    && echo "  ✓ Forgejo: ${name}" \
    || echo "  ✗ Forgejo: ${name} (failed)"
}

prompt_secret() {
  local name="$1"
  local description="$2"
  local env_key="${3:-}"       # key name for .env.deploy (empty = don't write)
  local forgejo_key="${4:-}"   # key name for Forgejo (empty = don't write)
  local default_val="${5:-}"

  echo "─── ${description} ───"
  if [[ -n "$default_val" ]]; then
    echo "  Current/default: ${default_val:0:20}..."
  fi
  read -r -p "  Value (Enter to skip): " value
  value="${value:-$default_val}"

  if [[ -z "$value" ]]; then
    echo "  ⤳ Skipped"
    echo ""
    return
  fi

  if [[ -n "$env_key" ]]; then
    # Remove existing line if present, then append
    grep -v "^${env_key}=" "$ENV_FILE" > "${ENV_FILE}.tmp" 2>/dev/null || true
    echo "${env_key}=${value}" >> "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "$ENV_FILE"
    echo "  ✓ .env.deploy: ${env_key}"
  fi

  if [[ -n "$forgejo_key" ]]; then
    set_forgejo_secret "$forgejo_key" "$value"
  fi

  echo ""
}

# ── Ensure .env.deploy exists with header ────────────────────────────────────

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" << 'HEADER'
# Deploy secrets — sourced by scripts/deploy.sh
# DO NOT COMMIT (listed in .gitignore)
HEADER
fi

# ── Prompt for each secret ───────────────────────────────────────────────────

echo "══ Web Build Args (NEXT_PUBLIC_*) ══"
echo ""

prompt_secret "stripe_pub" "Stripe publishable key (pk_test_... or pk_live_...)" \
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY" "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY" \
  "pk_test_51TFMBLPCJUxbanenWfp3ovOKkr09vRohj8FEM5xWZ8911npO7smnpG8pXbLvE6MrMaEIThBGZ06tFr7bSYbmrbuI00YzlYTgT0"

prompt_secret "geoapify" "Geoapify API key" \
  "NEXT_PUBLIC_GEOAPIFY_API_KEY" "NEXT_PUBLIC_GEOAPIFY_API_KEY" \
  "610fd6a35bdc43c9acdb1a093fb63b0d"

prompt_secret "sentry_dsn" "Sentry DSN (https://...@sentry.io/...)" \
  "NEXT_PUBLIC_SENTRY_DSN" "NEXT_PUBLIC_SENTRY_DSN"

prompt_secret "tileserver" "Tileserver URL" \
  "NEXT_PUBLIC_TILESERVER_URL" "" \
  "https://tiles-dev.ithasfire.com"

echo ""
echo "══ Database ══"
echo ""

prompt_secret "dev_db" "Dev database URL (postgres://...)" \
  "DEV_DATABASE_URL" "DEV_DATABASE_URL"

prompt_secret "prod_db" "Prod database URL (postgres://...)" \
  "PROD_DATABASE_URL" "PROD_DATABASE_URL"

echo ""
echo "══ Stripe (Server) ══"
echo ""

prompt_secret "stripe_secret" "Stripe secret key (sk_test_... or sk_live_...)" \
  "STRIPE_SECRET_KEY" "TF_VAR_STRIPE_SECRET_KEY"

echo ""
echo "══ Discord Webhooks ══"
echo ""

prompt_secret "discord_dev" "Discord webhook — dev deploys" \
  "DISCORD_DEPLOY_DEV_WEBHOOK" "DISCORD_DEPLOY_DEV_WEBHOOK"

prompt_secret "discord_prod" "Discord webhook — prod deploys" \
  "DISCORD_DEPLOY_PROD_WEBHOOK" "DISCORD_DEPLOY_PROD_WEBHOOK"

echo ""
echo "══ Platform Admin Seed ══"
echo ""

prompt_secret "admin_email" "Platform admin email" \
  "SEED_ADMIN_EMAIL" "SEED_ADMIN_EMAIL"

prompt_secret "admin_pass" "Platform admin password" \
  "SEED_ADMIN_PASSWORD" "SEED_ADMIN_PASSWORD"

echo ""
echo "══ GCP / Terraform ══"
echo ""

prompt_secret "better_auth" "Better Auth secret" \
  "TF_VAR_BETTER_AUTH_SECRET" "TF_VAR_BETTER_AUTH_SECRET"

prompt_secret "neon_key" "Neon API key" \
  "" "TF_VAR_NEON_API_KEY"

prompt_secret "cf_api_key" "Cloudflare API key" \
  "" "TF_VAR_CLOUDFLARE_API_KEY"

prompt_secret "cf_email" "Cloudflare email" \
  "" "TF_VAR_CLOUDFLARE_EMAIL"

prompt_secret "cf_api_token" "Cloudflare API token" \
  "" "CLOUDFLARE_API_TOKEN"

prompt_secret "cf_zone" "Cloudflare zone ID" \
  "" "CLOUDFLARE_ZONE_ID"

prompt_secret "jobs_api_key" "Jobs API key" \
  "" "TF_VAR_JOBS_API_KEY"

prompt_secret "sentry_auth" "Sentry auth token" \
  "" "TF_VAR_SENTRY_AUTH_TOKEN"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Done! Secrets written to:"
echo "    .env.deploy (local deploys)"
echo "    Forgejo repo secrets (CI/CD)"
echo ""
echo "  To deploy:  ./scripts/deploy.sh dev"
echo "═══════════════════════════════════════════════════════"
echo ""
