#!/usr/bin/env bash
set -euo pipefail

# Terraform wrapper that loads local secrets from infra/.env.local.
#
# Why this exists:
# - Our preferred workflow uses direnv to export TF_VAR_*.
# - Some environments (CI, fresh laptops) might not have direnv installed.
#
# Usage:
#   ./scripts/tf.sh plan -var-file=envs/dev/dev.tfvars
#   ./scripts/tf.sh workspace list
#   ./scripts/tf.sh plan-env dev
#   ./scripts/tf.sh plan-all
#
# Notes:
# - infra/.env.local is gitignored and should contain `export TF_VAR_...` lines.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
INFRA_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)

# Load local secrets from infra/.env.local (one level up from terraform/)
INFRA_ROOT=$(cd -- "${INFRA_DIR}/.." && pwd)
ENV_FILE="${INFRA_ROOT}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

if [[ "${1:-}" == "--" ]]; then
  shift
  exec "$@"
fi

cmd="${1:-}"

run_plan_for_env() {
  local env="$1"
  local tfvars_file="${INFRA_DIR}/vars/${env}.tfvars"

  if [[ ! -f "${tfvars_file}" ]]; then
    echo "Missing tfvars file: ${tfvars_file}" >&2
    echo "Expected one of: envs/dev/dev.tfvars, envs/stage/stage.tfvars, envs/prod/prod.tfvars in ${INFRA_DIR}" >&2
    exit 1
  fi

  terraform workspace select "${env}" >/dev/null 2>&1 || terraform workspace new "${env}" >/dev/null

  echo "==> terraform plan (${env})" >&2
  terraform plan -input=false -var-file="${tfvars_file}"
}

case "${cmd}" in
  plan-all)
    shift
    (cd "${INFRA_DIR}" && run_plan_for_env dev)
    (cd "${INFRA_DIR}" && run_plan_for_env stage)
    (cd "${INFRA_DIR}" && run_plan_for_env prod)
    ;;
  plan-env)
    env="${2:-}"
    if [[ -z "${env}" ]]; then
      echo "Usage: ./scripts/tf.sh plan-env <dev|stage|prod>" >&2
      exit 1
    fi
    shift 2
    if [[ "${env}" != "dev" && "${env}" != "stage" && "${env}" != "prod" ]]; then
      echo "Unknown env: ${env} (expected dev|stage|prod)" >&2
      exit 1
    fi
    (cd "${INFRA_DIR}" && run_plan_for_env "${env}")
    ;;
  *)
    exec terraform "$@"
    ;;
esac
