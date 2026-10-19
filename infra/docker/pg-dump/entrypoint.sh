#!/usr/bin/env bash
# pg-dump backup job entrypoint (Cloud Run Job).
#
# Spec: docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md
#
# MODE=dump (default):
#   pg_dump (custom format) | zstd -19 → gs://$GCS_BUCKET/daily/YYYY/MM/DD.dump.zst
#   then publishes a manifest event (sha256, size, duration) to $PUBSUB_TOPIC.
#
# MODE=promote (1st of month, after the daily dump):
#   copies daily/YYYY/MM/01.dump.zst → monthly/YYYY-MM.dump.zst
#   and on Jan 1 also → yearly/YYYY.dump.zst. Idempotent (skips existing).
#
# Env:
#   GCS_BUCKET            (required) backup bucket name
#   DATABASE_URL          (required for MODE=dump) DIRECT Neon endpoint — not
#                         the pooler; pg_dump needs session state
#   PUBSUB_TOPIC          (optional) full topic id (projects/.../topics/...)
#   DAILY_PREFIX / MONTHLY_PREFIX / YEARLY_PREFIX (default daily/monthly/yearly)
#   BACKUP_ALERT_WEBHOOK  (optional) Discord webhook for failure alerts
#
# Memory note: Cloud Run /tmp is tmpfs and counts against the container's
# memory limit. pg_dump streams straight into zstd so only the COMPRESSED
# dump (~2 GB today) ever touches /tmp — size the job's memory at ~2x that.
#
# -E (errtrace) is load-bearing: without it the ERR trap is not inherited by
# shell functions, so failures inside run_dump/run_promote would exit without
# firing the Discord alert — a silently failing backup.
set -Eeuo pipefail

MODE="${MODE:-dump}"
: "${GCS_BUCKET:?GCS_BUCKET is required}"
DAILY_PREFIX="${DAILY_PREFIX:-daily}"
MONTHLY_PREFIX="${MONTHLY_PREFIX:-monthly}"
YEARLY_PREFIX="${YEARLY_PREFIX:-yearly}"
PUBSUB_TOPIC="${PUBSUB_TOPIC:-}"

DATE="$(date -u +%Y-%m-%d)"
YEAR="$(date -u +%Y)"
MONTH="$(date -u +%m)"
DAY="$(date -u +%d)"
START="$(date -u +%s)"

alert() {
  local message="$1"
  echo "ALERT: ${message}" >&2
  if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    curl -fsS -m 10 -X POST \
      -H "Content-Type: application/json" \
      -d "{\"content\":\"🚨 db-backup [${MODE}] ${DATE}: ${message}\"}" \
      "${BACKUP_ALERT_WEBHOOK}" >/dev/null || true
  fi
}

# Any failure: alert, then exit non-zero so the Cloud Run execution is marked
# failed (visible in Cloud Run job history + Cloud Logging).
trap 'alert "failed (line ${LINENO}, object ${OBJECT:-n/a})"' ERR

publish_event() {
  local payload="$1"
  if [[ -n "${PUBSUB_TOPIC}" ]]; then
    gcloud pubsub topics publish "${PUBSUB_TOPIC}" --message="${payload}" --quiet
  fi
}

object_exists() {
  gcloud storage objects describe "gs://${GCS_BUCKET}/$1" >/dev/null 2>&1
}

run_dump() {
  : "${DATABASE_URL:?DATABASE_URL is required for MODE=dump}"

  OBJECT="${DAILY_PREFIX}/${YEAR}/${MONTH}/${DAY}.dump.zst"
  local tmp="/tmp/backup.dump.zst"

  # Idempotency against the bucket retention policy: retention blocks
  # overwrites, so a retry after a post-upload failure (e.g. a transient
  # pubsub error) must not re-upload. Today's object existing IS success.
  if object_exists "${OBJECT}"; then
    echo "gs://${GCS_BUCKET}/${OBJECT} already exists — dump already succeeded today, skipping"
    return 0
  fi

  echo "Dumping to gs://${GCS_BUCKET}/${OBJECT}"

  # --format=custom is restorable with pg_restore + supports parallel restore.
  # --no-owner / --no-acl keeps the dump portable to other Postgres targets.
  # Streamed into zstd so the uncompressed dump never hits tmpfs.
  pg_dump \
    --dbname="${DATABASE_URL}" \
    --format=custom \
    --no-owner \
    --no-acl |
    zstd -19 -T0 -q -f -o "${tmp}"

  local sha256 size duration
  sha256="$(sha256sum "${tmp}" | awk '{print $1}')"
  size="$(stat -c%s "${tmp}")"

  # CMEK is enforced as the bucket default; a plain upload is encrypted.
  gcloud storage cp "${tmp}" "gs://${GCS_BUCKET}/${OBJECT}" --quiet
  rm -f "${tmp}"

  duration="$(($(date -u +%s) - START))"
  echo "Uploaded ${OBJECT} (${size} bytes, sha256=${sha256}, ${duration}s)"

  # The upload, not the manifest, is the job's success criterion: a transient
  # publish failure must not fail the execution (the retry could not
  # re-upload anyway — see the idempotency guard above).
  publish_event "{\"type\":\"daily\",\"date\":\"${DATE}\",\"object\":\"${OBJECT}\",\"sha256\":\"${sha256}\",\"size\":${size},\"duration_sec\":${duration},\"status\":\"ok\"}" ||
    alert "manifest publish failed after successful upload of ${OBJECT} (backup is safe)"
}

run_promote() {
  local src="${DAILY_PREFIX}/${YEAR}/${MONTH}/${DAY}.dump.zst"
  local monthly="${MONTHLY_PREFIX}/${YEAR}-${MONTH}.dump.zst"
  local promoted=()

  if ! object_exists "${src}"; then
    alert "promotion source gs://${GCS_BUCKET}/${src} does not exist — did the daily dump fail?"
    exit 1
  fi

  if object_exists "${monthly}"; then
    echo "Skipping monthly promotion: gs://${GCS_BUCKET}/${monthly} already exists"
  else
    echo "Promoting ${src} → ${monthly}"
    gcloud storage cp "gs://${GCS_BUCKET}/${src}" "gs://${GCS_BUCKET}/${monthly}" --quiet
    promoted+=("${monthly}")
  fi

  if [[ "${MONTH}" == "01" ]]; then
    local yearly="${YEARLY_PREFIX}/${YEAR}.dump.zst"
    if object_exists "${yearly}"; then
      echo "Skipping yearly promotion: gs://${GCS_BUCKET}/${yearly} already exists"
    else
      echo "Promoting ${src} → ${yearly}"
      gcloud storage cp "gs://${GCS_BUCKET}/${src}" "gs://${GCS_BUCKET}/${yearly}" --quiet
      promoted+=("${yearly}")
    fi
  fi

  local duration objects_json
  duration="$(($(date -u +%s) - START))"
  objects_json="$(printf '"%s",' "${promoted[@]:-}" | sed 's/,$//; s/""//')"
  publish_event "{\"type\":\"promote\",\"date\":\"${DATE}\",\"source\":\"${src}\",\"promoted\":[${objects_json}],\"duration_sec\":${duration},\"status\":\"ok\"}"
}

case "${MODE}" in
dump) run_dump ;;
promote) run_promote ;;
*)
  alert "unknown MODE '${MODE}' (expected dump|promote)"
  exit 1
  ;;
esac
