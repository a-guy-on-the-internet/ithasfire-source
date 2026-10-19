#!/usr/bin/env bash
#
# Refuse a prod deploy whose promoted images were built from a different
# commit than the one it was dispatched at. Used by
# .github/workflows/deploy-prod.yml's version_skew_guard job. Tests:
# scripts/ci/check-prod-version-skew.test.sh (run by hand; no CI job runs it).
#
# ── Why this exists ───────────────────────────────────────────────────────
# deploy-prod promotes api, jobs, tileserver and audio-transcoder by retagging
# an image already in the registry, but builds web and runs migrations from
# the dispatched commit. Before this guard it retagged the MOVING `:dev` tag
# and never compared it with that commit, so a dispatch could ship web from
# main HEAD against an api from an older commit that lacks a tRPC procedure
# web calls.
#
# ── Why "dev's last green run is this commit" is not enough ──────────────
# deploy-dev pushes `:dev` at BUILD time, before its deploy job, and rebuilds
# a service only when that push's own diff touched the service's path filter:
#   1. a run that builds and then fails or is cancelled leaves :dev AHEAD of
#      the last green run;
#   2. a cancelled api push followed by a web-only push goes green with
#      api:dev still from before the cancelled one;
#   3. a dispatch with services=web is green while the others are stale;
#   4. a push during a prod deploy moves :dev between any check and the retag.
# So the guard checks each image's own provenance, and the promote jobs then
# retag the DIGEST this guard verified rather than `:dev` (closes 4).
#
# ── The rule, per promoted service ───────────────────────────────────────
# Resolve the current digest of <service>:dev and every dev-<sha7> tag on it
# (deploy-dev pushes dev-${GITHUB_SHA::7} beside :dev). Pass if one of those
# commits S is an ancestor of REF_SHA and `git diff S REF_SHA` touches none of
# the service's path-filter globs in deploy-dev.yml: then dev's own rules
# would not rebuild that service for REF_SHA, so the image is what REF_SHA
# would build. The globs are read from deploy-dev.yml at run time so the two
# cannot drift.
#
# The diff runs with --no-renames (a rename shows both paths, so a file moved
# OUT of a filter still counts) and core.quotePath=false with -z (git would
# otherwise print a non-ASCII path as a quoted octal string no glob matches).
#
# ── Plus, once per run ───────────────────────────────────────────────────
# A successful deploy-dev run on main at REF_SHA, or one at an ancestor whose
# diff to REF_SHA touches only deploy-dev's paths-ignore globs (a docs-only
# push starts no dev run, so it can never go green itself). This is what ties
# the promoted set to a passing quality gate and a dev roll at this commit:
# provenance alone would accept a run that built every image and then failed
# its deploy.
#
# Every failure is collected before exiting, so one red run names every
# stale service at once.
#
# ── Known limitation (inherited from deploy-dev's filters) ───────────────
# The api, jobs and audio-transcoder Dockerfiles COPY docs/, and .dockerignore
# is in no filter, so a change to either reaches an image without deploy-dev
# rebuilding it, and this guard does not see it either.
#
# Required env: PROJECT_ID REGION AR_REPO REF_SHA REF_NAME GITHUB_REPOSITORY
#               GITHUB_TOKEN
# Optional env: SERVICES (default: api jobs tileserver audio-transcoder)
#               DEV_WORKFLOW_PATH (default: .github/workflows/deploy-dev.yml)
#               GITHUB_API_URL GITHUB_OUTPUT GITHUB_STEP_SUMMARY YQ
#
# Outputs (GITHUB_OUTPUT): <service>_digest per service, with '-' → '_'
# (api_digest, jobs_digest, tileserver_digest, audio_transcoder_digest).
#
# The registry and Actions API calls sit behind the four functions in the
# next section, so the provenance logic can be exercised locally by sourcing
# replacements for them (set VERSION_SKEW_STUBS to a file that redefines them).
# Each returns non-zero on failure, with the reason on stderr.

set -uo pipefail

: "${REF_SHA:?REF_SHA is required}"
: "${REF_NAME:?REF_NAME is required}"
SERVICES="${SERVICES:-api jobs tileserver audio-transcoder}"
DEV_WORKFLOW_PATH="${DEV_WORKFLOW_PATH:-.github/workflows/deploy-dev.yml}"
DEV_WORKFLOW_FILE="$(basename "$DEV_WORKFLOW_PATH")"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/null}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
YQ="${YQ:-yq}"

# ── External calls (replace these to test) ───────────────────────────────

# Print the digest (sha256:…) <service>:dev points at right now.
registry_dev_digest() {
  local service="$1"
  gcloud artifacts docker images describe \
    "${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${service}:dev" \
    --format='value(image_summary.digest)'
}

# Print every tag on <service>@<digest>, one short name per line. Same listing
# as check-infra-drift.sh: gcloud returns fully-qualified tag names
# (…/tags/dev-abc1234) and the version column carries the digest. The listing
# is captured first so a gcloud failure is a failure, not an empty tag list.
registry_tags_on_digest() {
  local service="$1" digest="$2" listing
  listing="$(gcloud artifacts docker tags list \
    "${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${service}" \
    --format='csv[no-heading](tag,version)')" || return 1
  awk -F, -v d="$digest" 'index($2, d) { n = split($1, p, "/"); print p[n] }' <<< "$listing"
}

# branch=main on both queries: a deploy-dev dispatched from another branch
# built from that branch, not from main.
actions_runs() {
  local query="$1" body
  body="$(curl -fsS -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/${DEV_WORKFLOW_FILE}/runs?status=success&branch=main&${query}")" || return 1
  printf '%s' "$body"
}

# Print the html_url of each successful deploy-dev run on main at <sha>.
green_dev_runs_at() {
  local body
  body="$(actions_runs "head_sha=$1&per_page=20")" || return 1
  jq -r '.workflow_runs[].html_url' <<< "$body"
}

# Print the head_sha of the newest successful deploy-dev runs on main,
# newest first.
green_dev_head_shas() {
  local body
  body="$(actions_runs "per_page=50")" || return 1
  jq -r '.workflow_runs[].head_sha' <<< "$body"
}

if [[ -n "${VERSION_SKEW_STUBS:-}" ]]; then
  # shellcheck source=/dev/null
  source "$VERSION_SKEW_STUBS"
else
  : "${PROJECT_ID:?PROJECT_ID is required}"
  : "${REGION:?REGION is required}"
  : "${AR_REPO:?AR_REPO is required}"
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
fi

errf="$(mktemp)"
trap 'rm -f "$errf"' EXIT

# The stderr of the last external call, on one line.
last_error() { tr '\n' ' ' < "$errf" | sed 's/  */ /g; s/ $//'; }

# ── Globs ────────────────────────────────────────────────────────────────

# Print the path-filter globs of deploy-dev's `changes` job for <filter key>.
# The filters are a YAML string inside the workflow (dorny/paths-filter's
# `filters: |`), hence the second yq pass; explode() resolves the *shared
# anchor and flatten() the nested list it leaves. A missing key is an error,
# not an empty list, so a renamed filter fails the guard instead of passing.
service_globs() {
  local key="$1"
  "$YQ" '.jobs.changes.steps[] | select(.id == "filter") | .with.filters' "$DEV_WORKFLOW_PATH" \
    | "$YQ" "explode(.) | .${key} | flatten | .[]"
}

dev_paths_ignore() {
  "$YQ" '.on.push.paths-ignore[]' "$DEV_WORKFLOW_PATH"
}

# match_globs <match|invert> <glob>...
# Read NUL-separated paths on stdin; print, one per line, those that match
# any glob (match) or none of them (invert). A newline inside a path is
# printed as \n.
#
# GitHub's filter-pattern semantics: `**` matches across directories wherever
# it appears, `*` and `?` stop at `/`. That is exact for paths-ignore, which
# GitHub evaluates. dorny/paths-filter uses picomatch, where a `**` that is
# not a whole segment (`dir/**.ext`) behaves like `*`; matching it across
# directories instead can only report MORE files as touching a service, so
# the difference fails closed. Anything this does not understand (character
# classes, braces, extglobs, negation) is an error rather than a guess: read
# literally, `[...]` would match less than picomatch does, which fails open.
match_globs() {
  python3 -c '
import re, sys

def to_regex(glob):
    if glob.startswith("!") or any(c in glob for c in "[]{}()+@"):
        sys.exit("unsupported glob syntax: " + glob)
    out, i = [], 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out.append("(?:.*/)?"); i += 3
        elif glob.startswith("**", i):
            out.append(".*"); i += 2
        elif glob[i] == "*":
            out.append("[^/]*"); i += 1
        elif glob[i] == "?":
            out.append("[^/]"); i += 1
        else:
            out.append(re.escape(glob[i])); i += 1
    return re.compile("".join(out) + r"\Z", re.S)

mode, globs = sys.argv[1], sys.argv[2:]
if mode not in ("match", "invert"):
    sys.exit("mode must be match or invert")
if not globs:
    sys.exit("no globs given")
patterns = [to_regex(g) for g in globs]
out = sys.stdout.buffer
for raw in sys.stdin.buffer.read().split(b"\0"):
    if not raw:
        continue
    path = raw.decode("utf-8", "surrogateescape")
    if any(p.match(path) for p in patterns) == (mode == "match"):
        out.write(raw.replace(b"\n", b"\\n") + b"\n")
' "$@"
}

# changed_matching <match|invert> <from> <to> <glob>...
# Files changed between two commits, filtered by match_globs. Non-zero if
# either the diff or the match fails, so an error can never read as "no
# changes". A temp file carries the NUL-separated list, which a shell
# variable cannot hold.
changed_matching() {
  local mode="$1" from="$2" to="$3" tmp rc
  shift 3
  tmp="$(mktemp)"
  if ! git -c core.quotePath=false diff --no-renames --name-only -z "$from" "$to" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  match_globs "$mode" "$@" < "$tmp"
  rc=$?
  rm -f "$tmp"
  return "$rc"
}

# ── Reporting ────────────────────────────────────────────────────────────

failures=0
fail() {
  local msg="$1"
  # Workflow-command escaping, so a % or a newline in a path cannot end or
  # rewrite the annotation.
  msg="${msg//'%'/%25}"
  msg="${msg//$'\r'/%0D}"
  msg="${msg//$'\n'/%0A}"
  echo "::error::${msg}"
  printf -- '- %s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  failures=$((failures + 1))
}

short() { printf '%s' "${1:0:9}"; }

# Join lines into "a, b, c (+N more)" so an ::error:: stays one line.
list_files() {
  local -a files
  mapfile -t files
  local n=${#files[@]} max=10
  if (( n <= max )); then
    (IFS=','; printf '%s' "${files[*]}" | sed 's/,/, /g')
  else
    (IFS=','; printf '%s' "${files[*]:0:max}" | sed 's/,/, /g')
    printf ' (+%d more)' "$((n - max))"
  fi
}

# ── Ref ──────────────────────────────────────────────────────────────────

echo "## Prod version-skew guard" >> "$GITHUB_STEP_SUMMARY"

# Only main is ever built into :dev, so provenance against any other ref is
# meaningless, and a branch dispatch would also build web and migrate the
# prod schema from unreviewed code. The workflow refuses this before its GCP
# auth too; the check stays here so the script is safe on its own.
if [[ "$REF_NAME" != "refs/heads/main" ]]; then
  fail "deploy-prod was dispatched from ${REF_NAME}. Dispatch it from main."
  exit 1
fi

if ! git cat-file -e "${REF_SHA}^{commit}" 2>/dev/null; then
  fail "The dispatched commit ${REF_SHA} is not in this checkout (it needs fetch-depth: 0)."
  exit 1
fi

# ── deploy-dev green at this commit ──────────────────────────────────────

green_at=""   # newest commit dev is green at, for the messages below
if ! runs="$(green_dev_runs_at "$REF_SHA" 2>"$errf")"; then
  fail "Could not query ${DEV_WORKFLOW_FILE} runs from the Actions API: $(last_error)"
  exit 1
fi

if [[ -n "$runs" ]]; then
  green_at="$REF_SHA"
  echo "deploy-dev is green at $(short "$REF_SHA"): $(head -n1 <<< "$runs")"
else
  if ! heads="$(green_dev_head_shas 2>"$errf")"; then
    fail "Could not query ${DEV_WORKFLOW_FILE} runs from the Actions API: $(last_error)"
    exit 1
  fi
  # The newest green run that is an ancestor. A green run at a commit that is
  # not one (main moved on since dispatch) says nothing about this commit.
  while IFS= read -r h; do
    [[ -n "$h" ]] || continue
    if git merge-base --is-ancestor "$h" "$REF_SHA" 2>/dev/null; then
      green_at="$h"
      break
    fi
  done <<< "$heads"

  if [[ -z "$green_at" ]]; then
    fail "No successful ${DEV_WORKFLOW_FILE} run on main at $(short "$REF_SHA") or at any ancestor of it. Wait for deploy-dev to go green at $(short "$REF_SHA"), then dispatch deploy-prod again."
  else
    if ! ignore_globs="$(dev_paths_ignore)"; then
      fail "Could not read on.push.paths-ignore from ${DEV_WORKFLOW_PATH}."
      exit 1
    fi
    mapfile -t ignore_arr <<< "$ignore_globs"
    if ! not_ignored="$(changed_matching invert "$green_at" "$REF_SHA" "${ignore_arr[@]}")"; then
      fail "Could not diff $(short "$green_at")..$(short "$REF_SHA") against ${DEV_WORKFLOW_PATH}'s paths-ignore globs."
      exit 1
    fi
    if [[ -n "$not_ignored" ]]; then
      fail "deploy-dev has no successful run at $(short "$REF_SHA"). It is green at $(short "$green_at"), and since then these files changed outside paths-ignore: $(list_files <<< "$not_ignored"). Wait for deploy-dev to go green at $(short "$REF_SHA"), then dispatch deploy-prod again."
    else
      echo "deploy-dev is green at $(short "$green_at"); everything since is in paths-ignore, so no dev run was due."
    fi
  fi
fi

# ── Per-service provenance ───────────────────────────────────────────────

for service in $SERVICES; do
  key="${service//-/_}"

  if ! globs="$(service_globs "$key")" || [[ -z "$globs" ]]; then
    fail "${service}: no path filter '${key}' in ${DEV_WORKFLOW_PATH}'s changes job, so its image cannot be checked."
    continue
  fi
  mapfile -t glob_arr <<< "$globs"

  # Registry errors get no rebuild advice: the image may be fine, the read
  # failed (permissions, a wrong variable), and a rebuild would not fix it.
  if ! digest="$(registry_dev_digest "$service" 2>"$errf")"; then
    fail "${service}: could not read the digest of ${service}:dev: $(last_error)"
    continue
  fi
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail "${service}: ${service}:dev resolved to '${digest}', which is not a sha256 digest."
    continue
  fi

  if ! tags="$(registry_tags_on_digest "$service" "$digest" 2>"$errf")"; then
    fail "${service}: could not list tags for ${service}: $(last_error)"
    continue
  fi
  mapfile -t built_from < <(sed -n 's/^dev-\([0-9a-f]\{7,40\}\)$/\1/p' <<< "$tags")

  ok=""
  newer=""     # a dev-<sha> commit that is a DESCENDANT of REF_SHA
  detail=""
  for s7 in "${built_from[@]}"; do
    # rev-parse fails on an unknown or ambiguous short sha; both fail closed.
    if ! s="$(git rev-parse --verify --quiet "${s7}^{commit}" 2>/dev/null)"; then
      detail="${detail}${detail:+; }dev-${s7} does not resolve to exactly one commit"
      continue
    fi
    if ! git merge-base --is-ancestor "$s" "$REF_SHA"; then
      if git merge-base --is-ancestor "$REF_SHA" "$s"; then
        newer="$s"
      else
        detail="${detail}${detail:+; }its image was built from $(short "$s"), which is not on this commit's history"
      fi
      continue
    fi
    if ! touched="$(changed_matching match "$s" "$REF_SHA" "${glob_arr[@]}")"; then
      detail="${detail}${detail:+; }could not diff $(short "$s")..$(short "$REF_SHA") against the '${key}' globs"
      continue
    fi
    if [[ -z "$touched" ]]; then
      ok="$s"
      break
    fi
    detail="${detail}${detail:+; }its image was built from $(short "$s"), and since then these files in its path filter changed: $(list_files <<< "$touched")"
  done

  if [[ -n "$ok" ]]; then
    echo "${service}: ${digest} built from $(short "$ok"); nothing in its path filter changed up to $(short "$REF_SHA")."
    # shellcheck disable=SC2016 # the backticks are Markdown, not expansion
    printf -- '- %s: `%s` built from %s, current\n' "$service" "$digest" "$(short "$ok")" >> "$GITHUB_STEP_SUMMARY"
    echo "${key}_digest=${digest}" >> "$GITHUB_OUTPUT"
    continue
  fi

  if [[ -n "$newer" ]]; then
    # The usual red: main moved on after this run was dispatched (or while it
    # queued behind hf-prod) and deploy-dev has already built the newer
    # commit. Dispatching deploy-dev now would cancel the run that is doing
    # the work (hf-dev cancels in progress), so the advice is to wait.
    fail "${service}: ${service}:dev was built from $(short "$newer"), newer than this commit ($(short "$REF_SHA")). Wait for the running deploy-dev to finish, then dispatch deploy-prod again; it will run at main HEAD."
    continue
  fi

  # Stale: :dev is behind this commit. deploy-dev's `services` input calls
  # audio-transcoder "audio".
  [[ -n "$detail" ]] || detail="${service}:dev (${digest}) carries no dev-<sha> tag, so the commit it was built from is unknown"
  rebuild="dispatch deploy-dev from main with services=${service/audio-transcoder/audio}, but only while no deploy-dev run is in progress (a dispatch cancels a running one), then dispatch deploy-prod again"
  if [[ "$green_at" == "$REF_SHA" ]]; then
    # Green here but stale: a run only rebuilds what its own diff touched
    # (cases 2 and 3 in the header), so waiting will not fix it.
    fail "${service}: ${service}:dev does not match $(short "$REF_SHA"): ${detail}. deploy-dev is green at $(short "$REF_SHA") but did not rebuild ${service}. To ship this commit, ${rebuild}."
  else
    fail "${service}: ${service}:dev does not match $(short "$REF_SHA"): ${detail}.${green_at:+ The newest commit deploy-dev is green at is $(short "$green_at").} Wait for deploy-dev to go green at $(short "$REF_SHA"); if ${service} is still stale after that, ${rebuild}."
  fi
done

if (( failures > 0 )); then
  echo "::error::Version-skew guard: ${failures} problem(s). Nothing was promoted."
  exit 1
fi

echo "Version-skew guard passed for $(short "$REF_SHA")."
