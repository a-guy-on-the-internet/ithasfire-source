#!/usr/bin/env bash
#
# Tests for check-prod-version-skew.sh. Run by hand; no CI job runs it:
#
#   bash scripts/ci/check-prod-version-skew.test.sh
#
# Needs bash 4+ (macOS: Homebrew bash), git, python3 and yq v4 on PATH.
#
# Builds a throwaway git repo with the REAL deploy-dev.yml (so the globs under
# test are the ones prod is checked against), makes a few commits that each
# change one kind of path, and runs the script with its registry and Actions
# API functions replaced by stubs that read STUB_* variables.

set -uo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "needs bash 4+ (this is ${BASH_VERSION})" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/check-prod-version-skew.sh"
dev_workflow="${here}/../../.github/workflows/deploy-dev.yml"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
repo="${work}/repo"
mkdir -p "$repo"

g() { git -C "$repo" -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }
commit() { g add -A && g commit -qm "$1" && g rev-parse HEAD; }

g init -q -b main
g config user.name test
g config user.email test@example.invalid

mkdir -p "$repo/.github/workflows" "$repo/apps/api/src" "$repo/apps/jobs" \
  "$repo/apps/audio-transcoder" "$repo/apps/web" "$repo/packages/core" \
  "$repo/infra/docker/tileserver" "$repo/docs" "$repo/tools"
cp "$dev_workflow" "$repo/.github/workflows/deploy-dev.yml"
echo a > "$repo/apps/api/src/a.ts"
echo "moved later, unique content" > "$repo/apps/api/src/old.ts"
echo j > "$repo/apps/jobs/j.ts"
echo i > "$repo/apps/audio-transcoder/i.ts"
echo w > "$repo/apps/web/w.ts"
echo x > "$repo/packages/core/x.ts"
echo t > "$repo/infra/docker/tileserver/t.json"
echo d > "$repo/docs/readme.md"
c0="$(commit base)"

echo a2 > "$repo/apps/api/src/a.ts";                c1="$(commit "api change")"
echo d2 > "$repo/docs/readme.md";                   c2="$(commit "docs only")"
echo x2 > "$repo/packages/core/x.ts";               c3="$(commit "packages change")"
g mv apps/api/src/old.ts tools/old.ts;              c4="$(commit "rename out of the api filter")"
echo c > "$repo/apps/api/src/café.ts";              c5="$(commit "non-ascii path")"
echo p > "$repo/apps/api/src/50%off.ts";            c6="$(commit "percent in a path")"

stubs="${work}/stubs.sh"
cat > "$stubs" <<'EOF'
registry_dev_digest() {
  local k="${1//-/_}" err="STUB_DIGEST_ERR_${1//-/_}"
  if [[ -n "${!err:-}" ]]; then echo "${!err}" >&2; return 1; fi
  printf 'sha256:%s\n' "$(printf '%s' "$k" | git hash-object --stdin)$(printf '%s' "$k" | git hash-object --stdin | cut -c1-24)"
}
registry_tags_on_digest() {
  local tags="STUB_TAGS_${1//-/_}" err="STUB_TAGS_ERR_${1//-/_}"
  if [[ -n "${!err:-}" ]]; then echo "${!err}" >&2; return 1; fi
  local t
  for t in ${!tags:-}; do printf '%s\n' "$t"; done
}
green_dev_runs_at() {
  [[ -z "${STUB_API_ERR:-}" ]] || { echo "$STUB_API_ERR" >&2; return 1; }
  [[ -n "${STUB_GREEN_AT:-}" ]] && printf '%s\n' "$STUB_GREEN_AT"
  return 0
}
green_dev_head_shas() {
  [[ -z "${STUB_API_ERR:-}" ]] || { echo "$STUB_API_ERR" >&2; return 1; }
  local h
  for h in ${STUB_GREEN_HEADS:-}; do printf '%s\n' "$h"; done
}
EOF

# All four services tagged dev-<sha7 of $1>.
all_at() {
  local s="${1:0:7}"
  printf '%s\n' "STUB_TAGS_api=dev-$s" "STUB_TAGS_jobs=dev-$s" \
    "STUB_TAGS_tileserver=dev-$s" "STUB_TAGS_audio_transcoder=dev-$s"
}

passed=0
failed=0

# check <name> <pass|fail> <env assignments...> -- <expectations...>
# An expectation is a substring the output must contain, or !substring it
# must not contain. "out:<text>" checks GITHUB_OUTPUT instead.
check() {
  local name="$1" want="$2"
  shift 2
  local -a envs=()
  while (( $# )) && [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  [[ "${1:-}" == "--" ]] && shift

  local out="${work}/out-${name}" ghout="${work}/ghout-${name}"
  : > "$ghout"
  (cd "$repo" && env VERSION_SKEW_STUBS="$stubs" REF_NAME=refs/heads/main \
    GITHUB_OUTPUT="$ghout" GITHUB_STEP_SUMMARY=/dev/null "${envs[@]}" \
    "$BASH" "$script") > "$out" 2>&1
  local rc=$? got=pass problems=""
  (( rc == 0 )) || got=fail
  [[ "$got" == "$want" ]] || problems+=" expected ${want}, got ${got} (rc=${rc});"

  local e file text
  for e in "$@"; do
    file="$out"; text="$e"
    local negate=""
    [[ "$text" == "!"* ]] && { negate=1; text="${text:1}"; }
    [[ "$text" == out:* ]] && { file="$ghout"; text="${text#out:}"; }
    if grep -qF -- "$text" "$file"; then
      [[ -z "$negate" ]] || problems+=" must not contain '${text}';"
    else
      [[ -n "$negate" ]] || problems+=" missing '${text}';"
    fi
  done

  if [[ -z "$problems" ]]; then
    echo "ok   ${name}"
    passed=$((passed + 1))
  else
    echo "FAIL ${name}:${problems}"
    sed 's/^/       | /' "$out"
    failed=$((failed + 1))
  fi
}

mapfile -t at_c1 < <(all_at "$c1")
mapfile -t at_c3 < <(all_at "$c3")

check all-current pass REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" -- \
  out:api_digest=sha256: out:jobs_digest=sha256: out:tileserver_digest=sha256: \
  out:audio_transcoder_digest=sha256:

check stale-ancestor fail REF_SHA="$c1" STUB_GREEN_AT=run "${at_c1[@]}" \
  STUB_TAGS_api="dev dev-${c0:0:7}" -- \
  "api: api:dev does not match" "apps/api/src/a.ts" "services=api" \
  "only while no deploy-dev run is in progress" "!::error::jobs" out:jobs_digest

check docs-only pass REF_SHA="$c2" STUB_GREEN_AT= STUB_GREEN_HEADS="$c1" "${at_c1[@]}" -- \
  "everything since is in paths-ignore" out:api_digest

check docs-only-but-code-since fail REF_SHA="$c3" STUB_GREEN_AT= STUB_GREEN_HEADS="$c1" "${at_c3[@]}" -- \
  "changed outside paths-ignore: packages/core/x.ts"

check packages-change fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" \
  STUB_TAGS_jobs="dev-${c2:0:7}" STUB_TAGS_tileserver="dev-${c2:0:7}" -- \
  "jobs: jobs:dev does not match" "packages/core/x.ts" "services=jobs" \
  out:tileserver_digest "!out:jobs_digest"

check dev-newer fail REF_SHA="$c1" STUB_GREEN_AT=run "${at_c1[@]}" \
  STUB_TAGS_api="dev-${c3:0:7}" -- \
  "api:dev was built from ${c3:0:9}, newer than this commit" \
  "Wait for the running deploy-dev to finish" "!services=api"

check rename-out-of-filter fail REF_SHA="$c4" STUB_GREEN_AT=run "${at_c3[@]}" \
  STUB_TAGS_jobs="dev-${c4:0:7}" STUB_TAGS_tileserver="dev-${c4:0:7}" \
  STUB_TAGS_audio_transcoder="dev-${c4:0:7}" -- \
  "apps/api/src/old.ts" out:jobs_digest

check non-ascii-path fail REF_SHA="$c5" STUB_GREEN_AT=run STUB_TAGS_api="dev-${c4:0:7}" \
  STUB_TAGS_jobs="dev-${c5:0:7}" STUB_TAGS_tileserver="dev-${c5:0:7}" \
  STUB_TAGS_audio_transcoder="dev-${c5:0:7}" -- \
  "apps/api/src/café.ts"

check percent-escaped fail REF_SHA="$c6" STUB_GREEN_AT=run STUB_TAGS_api="dev-${c5:0:7}" \
  STUB_TAGS_jobs="dev-${c6:0:7}" STUB_TAGS_tileserver="dev-${c6:0:7}" \
  STUB_TAGS_audio_transcoder="dev-${c6:0:7}" -- \
  "apps/api/src/50%25off.ts" "!50%off"

check tags-list-error fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" \
  STUB_TAGS_ERR_api="ERROR: PERMISSION_DENIED on tags list" -- \
  "could not list tags for api: ERROR: PERMISSION_DENIED on tags list" "!services=api" \
  out:jobs_digest

check describe-error fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" \
  STUB_DIGEST_ERR_jobs="ERROR: NOT_FOUND" -- \
  "could not read the digest of jobs:dev: ERROR: NOT_FOUND" "!services=jobs"

check no-sha-tag fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" STUB_TAGS_api="dev buildcache-v2" -- \
  "carries no dev-<sha> tag" "services=api"

check unknown-sha fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" STUB_TAGS_api="dev-0000000" -- \
  "dev-0000000 does not resolve to exactly one commit"

check two-tags-one-good pass REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" \
  STUB_TAGS_api="dev-${c0:0:7} dev-${c3:0:7}" -- out:api_digest

check no-green-anywhere fail REF_SHA="$c3" STUB_GREEN_AT= STUB_GREEN_HEADS= "${at_c3[@]}" -- \
  "No successful deploy-dev.yml run on main"

check actions-api-error fail REF_SHA="$c3" STUB_API_ERR="curl: (22) 403" "${at_c3[@]}" -- \
  "Could not query deploy-dev.yml runs from the Actions API: curl: (22) 403"

check branch-ref fail REF_SHA="$c3" REF_NAME=refs/heads/feature STUB_GREEN_AT=run "${at_c3[@]}" -- \
  "dispatched from refs/heads/feature"

check unknown-filter-key fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" SERVICES="api web2" -- \
  "no path filter 'web2'"

check collects-every-failure fail REF_SHA="$c3" STUB_GREEN_AT=run "${at_c3[@]}" \
  STUB_TAGS_api="dev-${c0:0:7}" STUB_TAGS_ERR_jobs="boom" -- \
  "api: api:dev does not match" "could not list tags for jobs: boom" "2 problem(s)"

echo
echo "${passed} passed, ${failed} failed"
# Zero cases run must not read as a pass.
(( failed == 0 && passed == 19 ))
