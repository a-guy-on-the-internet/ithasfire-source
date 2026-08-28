#!/bin/zsh
# Weekly curation runner, invoked by launchd. Runs a Claude Code slash command headless.
#
#   Usage: run.sh <slash-command-name-without-slash>
#   e.g.:  run.sh open-mic-scout
#
# launchd gives us a bare environment, so we set PATH explicitly. The task is
# read-only + writes only to docs/curation/, and you review the artifact before
# anything is published — so we skip permission prompts (there's no TTY to approve).
set -euo pipefail

TASK="${1:?usage: run.sh <slash-command-without-slash>}"
PROJECT_DIR="/Users/somehuman/Projects/TicketHunter"

export PATH="/opt/homebrew/bin:/Users/somehuman/.nvm/versions/node/v24.8.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$PROJECT_DIR"

# --- Production DB access (READ-ONLY) -------------------------------------
# Fetch the prod connection string at runtime (never written to disk) and
# hand it to the curation commands as CURATION_DB_URL. Two guardrails make
# this safe for a headless, permission-skipping run:
#   1. We use the direct URL but force every session read-only via PGOPTIONS,
#      so even an accidental write errors out at the server.
#   2. The commands only ever SELECT.
# If the secret fetch fails (no gcloud auth, offline), we unset the URL so the
# commands fall back to the local DB rather than silently sweeping nothing.
export PGOPTIONS='-c default_transaction_read_only=on'
if CURATION_DB_URL="$(gcloud secrets versions access latest \
      --secret=hf-prod-direct-database-url \
      --project=hearthfire-491918 2>/dev/null)"; then
  export CURATION_DB_URL
else
  unset CURATION_DB_URL
fi

LOG_DIR="$PROJECT_DIR/.claude/curation/logs"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/${TASK}-${STAMP}.log"

HEALTH="$PROJECT_DIR/docs/ops/automation-health.md"

# Failure has to be LOUD, because nothing reads these logs.
#
# Two bugs made every failed run silent:
#
#   1. `set -e` (line 10) aborts the script the instant `claude` exits
#      non-zero — so the "finished" line below never ran and there was nowhere
#      to hook an alert. Compare a healthy log (ends "finished … (exit 0)")
#      with any run since 2026-08-03: they just stop at the error text.
#   2. `$?` in the old finished-line was clobbered by the `$(date)` expansion
#      that precedes it, so even when it did run it reported date's status.
#
# Result: both curation agents failed EVERY Monday from 2026-08-03 (spend
# limit, then expired OAuth) while `docs/curation/` silently stopped at
# 2026-07-27. `launchctl list` showed exit 1 the whole time; nobody looks at
# `launchctl list`.
#
# `|| rc=$?` keeps `set -e` from aborting so the reporting below always runs.
echo "[$(date)] starting /$TASK" >> "$LOG"
rc=0
claude -p "/$TASK" --dangerously-skip-permissions >> "$LOG" 2>&1 || rc=$?

# Capture the reason BEFORE appending the finished line — `claude -p` puts its
# fatal reason on the last line of output ("You've hit your monthly spend
# limit", "OAuth access token has expired"), and appending first would make
# every alert read back its own footer.
REASON="$(tail -1 "$LOG" 2>/dev/null | cut -c1-200)"

echo "[$(date)] finished /$TASK (exit $rc)" >> "$LOG"

# A committed, greppable health file. Unlike the per-run logs this is ONE place
# with the current state of every task, it shows up in `git status`, and a
# staleness check can read it without parsing timestamped filenames.
mkdir -p "$(dirname "$HEALTH")"
{
  echo "- **$TASK** — $([ "$rc" -eq 0 ] && echo "ok" || echo "**FAILED (exit $rc)**") — $(date '+%Y-%m-%d %H:%M %Z')"
  [ "$rc" -ne 0 ] && echo "  - \`$REASON\`"
  [ "$rc" -ne 0 ] && echo "  - log: \`${LOG#$PROJECT_DIR/}\`"
} >> "$HEALTH"

if [ "$rc" -ne 0 ]; then
  # macOS notification: this runs on the operator's own machine, so the
  # cheapest channel that cannot be ignored is the one on screen. Best-effort —
  # a headless launchd context may have no GUI session, hence `|| true`.
  osascript -e "display notification \"$TASK failed: $REASON\" with title \"Ithas Fire automation FAILED\"" 2>/dev/null || true

  # Optional Discord fan-out. Deliberately env-gated rather than fetched from
  # GCP: `gcloud` itself needs periodic reauth, and an alerting path that
  # depends on the thing most likely to be broken is not an alerting path.
  if [ -n "${AGENT_ALERT_WEBHOOK:-}" ]; then
    curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "{\"content\":\"🔴 **$TASK** failed (exit $rc)\\n\\`$REASON\\`\"}" \
      "$AGENT_ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
fi

# Propagate so `launchctl list` keeps showing a non-zero status too.
exit "$rc"
