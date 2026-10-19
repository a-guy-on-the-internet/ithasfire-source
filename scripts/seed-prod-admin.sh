#!/usr/bin/env bash
#
# seed-prod-admin.sh — one-time bootstrap of the prod platform admin.
#
# Pulls the prod DATABASE_URL from GCP Secret Manager, prompts for the
# admin email + password interactively (password is hidden + never
# touches disk / shell history), then upserts the account via
# seed-platform-admin.ts.
#
# Requirements:
#   - gcloud authenticated as a principal with secretmanager.secretAccessor
#     on hearthfire-491918 (run `gcloud auth login` if needed).
#   - pnpm + the workspace installed locally (`pnpm install`).
#
# Usage:
#   ./scripts/seed-prod-admin.sh
#
# After running:
#   1. Log in immediately at https://ithasfire.com
#   2. Enable 2FA in Account Settings → Security
#   3. (Optional) Rotate the password once 2FA is on
#
# This script is intentionally NOT part of any CI workflow — admin
# auth should never be deploy-driven. Re-run only when bootstrapping
# a fresh prod environment or restoring break-glass access.

set -euo pipefail

PROJECT_ID="hearthfire-491918"
SECRET_NAME="hf-prod-database-url"
DEFAULT_EMAIL="admin@ithasfire.com"
DEFAULT_NAME="Platform Admin"

# ─── Pre-flight ────────────────────────────────────────────────────────────
if ! command -v gcloud >/dev/null 2>&1; then
  echo "error: gcloud not on PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not on PATH" >&2
  exit 1
fi

# Confirm the principal can actually read the secret before we prompt
# the human — fail fast on auth issues rather than after they've typed
# a password they expected us to use.
echo "→ Checking access to ${SECRET_NAME} in ${PROJECT_ID}…"
if ! gcloud secrets versions access latest \
       --secret="${SECRET_NAME}" \
       --project="${PROJECT_ID}" \
       >/dev/null 2>&1; then
  echo "error: cannot read ${SECRET_NAME}." >&2
  echo "       run \`gcloud auth login\` and confirm your account has" >&2
  echo "       roles/secretmanager.secretAccessor on ${PROJECT_ID}." >&2
  exit 1
fi
echo "  ✓ ok"
echo

# ─── Prompt ────────────────────────────────────────────────────────────────
read -r -p "Admin email [${DEFAULT_EMAIL}]: " EMAIL
EMAIL="${EMAIL:-$DEFAULT_EMAIL}"

read -r -p "Display name [${DEFAULT_NAME}]: " NAME
NAME="${NAME:-$DEFAULT_NAME}"

# -s: silent (no echo). -r: raw (no backslash escapes).
read -r -s -p "Password (≥12 chars, won't echo): " PASSWORD
echo
read -r -s -p "Confirm password: " PASSWORD_CONFIRM
echo

if [[ "${PASSWORD}" != "${PASSWORD_CONFIRM}" ]]; then
  echo "error: passwords do not match." >&2
  unset PASSWORD PASSWORD_CONFIRM
  exit 1
fi
unset PASSWORD_CONFIRM

if [[ ${#PASSWORD} -lt 12 ]]; then
  echo "error: password must be at least 12 characters." >&2
  unset PASSWORD
  exit 1
fi

# ─── Confirm before mutating prod ──────────────────────────────────────────
cat <<EOF

About to seed the PROD platform admin:
  project : ${PROJECT_ID}
  email   : ${EMAIL}
  name    : ${NAME}
  password: <hidden>

This is an UPSERT — if the account already exists, its password will
be reset to the value you just entered.

EOF

read -r -p "Proceed? (yes/no): " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "aborted." >&2
  unset PASSWORD
  exit 1
fi

# ─── Seed ──────────────────────────────────────────────────────────────────
echo "→ Fetching DATABASE_URL…"
DATABASE_URL="$(gcloud secrets versions access latest \
  --secret="${SECRET_NAME}" \
  --project="${PROJECT_ID}")"
export DATABASE_URL

echo "→ Running seed-platform-admin.ts…"
# Pass --email-verified so the admin can log in immediately without an
# email round-trip on a freshly-provisioned env.
DATABASE_URL="${DATABASE_URL}" pnpm -F api exec tsx \
  src/scripts/reference-data/seed-platform-admin.ts \
  --email "${EMAIL}" \
  --password "${PASSWORD}" \
  --name "${NAME}" \
  --email-verified

# ─── Cleanup ───────────────────────────────────────────────────────────────
unset PASSWORD DATABASE_URL

cat <<EOF

✓ Done.

Next steps (do these now):
  1. Log in at https://ithasfire.com using ${EMAIL}.
  2. Account Settings → Security → enable 2FA.
  3. Wipe the password from your shell history if you care
     (\`history -c\` for bash, \`fc -p\` for zsh).
EOF
