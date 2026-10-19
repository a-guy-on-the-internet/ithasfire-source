#!/usr/bin/env bash
#
# Upload a Node service's bundle source maps (apps/api, apps/jobs) to Sentry.
# Run it in the same job, right after the `docker buildx build` that pushed
# the service's image: deploy-dev.yml (build_api, build_jobs) and hotfix.yml.
#
#   scripts/ci/upload-service-sourcemaps.sh <service> <dockerfile>
#
# Why: the images run `node dist/index.js` WITHOUT --enable-source-maps.
# With the flag, node kept the parsed map of the app chunk resident once
# Sentry formatted a stack (~140 MiB heap, 160-170 MiB RSS on the API, A/B
# 2026-10-18). The Dockerfile injects Sentry debug IDs into the bundle
# (`sentry-cli sourcemaps inject`), and Sentry resolves frames server-side
# against the maps uploaded here, matched by debug ID. No release and no
# file-name prefix are involved, so one upload from the dev build also covers
# prod: deploy-prod.yml promotes
# the dev-built api/jobs image by retag, the same bytes with the same ids.
#
# How: build the Dockerfile's `sourcemaps` stage to a local directory. It is
# a FROM-scratch copy of the install stage's /opt/sourcemaps (injected JS +
# maps + the lockfile-pinned sentry-cli binary). When the image build just
# ran the install stage, every layer here is a builder-cache hit. When that
# build was a gha cache hit (mode=min keeps only runtime layers), the install
# stage never ran on this runner and this export is a full rebuild. The ids
# still match either way: each is a hash of its file, and the bundle is
# deterministic (checked 2026-10-18: a full rebuild gave JS byte-identical to
# the image's, 43 of 43 files). A rebuild only costs time; the step has a
# timeout.
# Several pure re-export chunks share one id (their maps are all empty);
# harmless, no frame resolves inside them.
#
# NEVER fails the deploy. A missing token, a failed export or a failed upload
# prints a ::warning:: and exits 0: the cost of a miss is unresolved Sentry
# frames (dist/chunks/<name>-<hash>.js:<line>, function names still readable)
# for that build, not an outage.
#
# Required env: SENTRY_AUTH_TOKEN (a step env from secrets, never a
#   --build-arg: build args persist in the image history)
# Optional env: SENTRY_ORG (default hearth-fire)
#   SENTRY_PROJECT (default hearth-fire-web; API and jobs events land there)
#   SOURCEMAPS_PLATFORM (default linux/amd64, the platform the image is built
#   for; the exported sentry-cli binary is that platform's)

set -uo pipefail

service="${1:-}"
dockerfile="${2:-}"
if [[ -z "$service" || -z "$dockerfile" ]]; then
  echo "usage: $0 <service> <dockerfile>" >&2
  exit 2
fi

warn() {
  echo "::warning title=Sentry source maps (${service})::$*; Sentry frames for this build stay unresolved"
  exit 0
}

if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  warn "SENTRY_AUTH_TOKEN is empty, nothing uploaded"
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

echo "── Exporting ${service} source maps (${dockerfile}, target sourcemaps) ──"
if ! docker buildx build \
  --platform "${SOURCEMAPS_PLATFORM:-linux/amd64}" \
  --provenance=false \
  --target sourcemaps \
  --output "type=local,dest=${out}" \
  -f "$dockerfile" \
  .; then
  warn "exporting the sourcemaps stage failed"
fi

cli="${out}/sentry-cli"
[[ -x "$cli" ]] || warn "the sourcemaps stage has no executable sentry-cli"

js_count="$(find "${out}/dist" -name '*.js' | wc -l | tr -d ' ')"
map_count="$(find "${out}/dist" -name '*.js.map' | wc -l | tr -d ' ')"
unmarked="$(find "${out}/dist" -name '*.js' ! -exec grep -q '^//# debugId=' {} \; -print | wc -l | tr -d ' ')"
echo "Found ${js_count} .js and ${map_count} .js.map; ${unmarked} .js without a debugId comment"
if [[ "$js_count" == "0" || "$js_count" != "$map_count" || "$unmarked" != "0" ]]; then
  warn "the export is not a matched set of injected .js and .map files"
fi

"$cli" --version
if ! "$cli" sourcemaps upload \
  --org "${SENTRY_ORG:-hearth-fire}" \
  --project "${SENTRY_PROJECT:-hearth-fire-web}" \
  "${out}/dist"; then
  warn "sentry-cli sourcemaps upload failed"
fi
echo "Uploaded ${service} source maps to ${SENTRY_ORG:-hearth-fire}/${SENTRY_PROJECT:-hearth-fire-web}"
