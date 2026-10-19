#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$TERRAFORM_ROOT/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform is required on PATH" >&2
  exit 1
fi

# Reuse downloaded providers across runs and modules.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

fmt_target="infra/terraform"
echo "==> terraform fmt check ($fmt_target)"
terraform fmt -recursive -check "$fmt_target"

declare -a terraform_dirs=()
while IFS= read -r -d '' path; do
  terraform_dirs+=("$path")
done < <(find infra/terraform/envs -maxdepth 1 -mindepth 1 -type d -print0)
while IFS= read -r -d '' path; do
  terraform_dirs+=("$path")
done < <(find infra/terraform/modules -maxdepth 1 -mindepth 1 -type d -print0)

run_tf_validate() {
  local dir="$1"
  if ! find "$dir" -maxdepth 1 -name '*.tf' -print -quit | grep -q .; then
    return
  fi

  echo "==> terraform validate ($dir)"
    local init_log
    init_log="$(mktemp "$dir/.tf-init.XXXXXX")"
  terraform -chdir="$dir" init -backend=false -input=false >"$init_log" 2>&1
  terraform -chdir="$dir" validate -no-color || {
    echo "Terraform validate failed for $dir. See $init_log for init output." >&2
    exit 1
  }
  rm -rf "$dir/.terraform" "$dir/.terraform.lock.hcl" "$init_log"
}

for dir in "${terraform_dirs[@]}"; do
  run_tf_validate "$dir"
done

echo "✅ infra validation complete"
