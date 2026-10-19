#!/usr/bin/env zsh
set -euo pipefail

# Local Terraform wrapper for the dev env that makes zsh + infra/.env.local Just Work™.
#
# Why this exists:
# - We prefer direnv, but sometimes it's not installed / not allowed yet.
# - This wrapper is the lowest-friction way to ensure TF_VAR_* exists.
#
# Usage:
#   ./infra/scripts/tf-dev.zsh init
#   ./infra/scripts/tf-dev.zsh plan -var-file=dev.tfvars
#   ./infra/scripts/tf-dev.zsh apply -var-file=dev.tfvars

SCRIPT_DIR=${0:A:h}
INFRA_DIR=${SCRIPT_DIR:h}

ENV_FILE="${INFRA_DIR}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

exec terraform "$@"
