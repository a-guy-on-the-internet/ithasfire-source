#!/usr/bin/env bash
# Wrapper for `terraform init` that sets TF_PLUGIN_CACHE_DIR so providers are
# downloaded once per runner. Single attempt, no retry: a transient registry
# failure (TLS handshake timeout to releases.hashicorp.com / a mirror) surfaces
# as a loud, single failure rather than being masked by a silent re-run.
#
# Usage: tf-init-cached.sh <chdir> [extra terraform-init args]
#   tf-init-cached.sh infra/terraform -input=false
#   tf-init-cached.sh infra/terraform -backend=false -input=false

set -euo pipefail

CHDIR="${1:-}"
if [[ -z "$CHDIR" ]]; then
  echo "Usage: $0 <chdir> [terraform-init args]" >&2
  exit 64
fi
shift

CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
export TF_PLUGIN_CACHE_DIR="$CACHE_DIR"
mkdir -p "$CACHE_DIR"

exec terraform -chdir="$CHDIR" init "$@"
