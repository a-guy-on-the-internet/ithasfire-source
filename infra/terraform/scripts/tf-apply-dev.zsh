#!/usr/bin/env zsh
set -euo pipefail

# Terraform pipeline (dev)
#
# Purpose: one command that reliably loads infra/.env.local and applies the dev
# environment configuration.
#
# Usage:
#   ./infra/scripts/tf-apply-dev.zsh
#   ./infra/scripts/tf-apply-dev.zsh plan
#   ./infra/scripts/tf-apply-dev.zsh apply
#   ./infra/scripts/tf-apply-dev.zsh destroy

SCRIPT_DIR=${0:A:h}
TERRAFORM_DIR=${SCRIPT_DIR:h}
INFRA_DIR=${TERRAFORM_DIR:h}

ENV_FILE="${INFRA_DIR}/.env.local"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

CMD=${1:-apply}
shift || true

cd "${TERRAFORM_DIR}"

# Our remote state backend is configured in infra/terraform/main.tf and isolates envs via
# Terraform CLI workspaces.
terraform init -upgrade
terraform workspace select dev >/dev/null 2>&1 || terraform workspace new dev

case "${CMD}" in
  plan)
    exec terraform plan -var-file=envs/dev/dev.tfvars "$@"
    ;;
  apply)
    exec terraform apply -auto-approve -var-file=envs/dev/dev.tfvars "$@"
    ;;
  destroy)
    exec terraform destroy -auto-approve -var-file=envs/dev/dev.tfvars "$@"
    ;;
  *)
    echo "Unknown command: ${CMD} (expected: plan|apply|destroy)" >&2
    exit 2
    ;;
esac
