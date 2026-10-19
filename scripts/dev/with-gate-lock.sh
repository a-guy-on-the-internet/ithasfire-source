#!/usr/bin/env bash
# Run a command under the machine-wide gate's HEAVY slot, so heavy gates (tsc)
# queue instead of stampeding. ~20 sessions share this checkout; on 2026-10-06
# ten tsc processes ran at once, load hit 42 and one apps/web tsc took 79 minutes.
#
# Usage: scripts/dev/with-gate-lock.sh <command> [args...]
#
# Kept as the entry point the `typecheck*` scripts in package.json (and
# .claude/shared/builder-rules.md) already use. Since 2026-10-14 it delegates to
# the Node gate (scripts/dev/gate/run.mjs; design notes in gate.mjs), which
# replaced the single /tmp/tickethunter-gate.lock with 1 heavy + 3 light slots
# in /tmp/tickethunter-gate/. Same contract as before: a "gate: queued (heavy)
# behind PID ..." line at once and every ~30 s, stale takeover, exit code passed
# through, CI=true/1 or GATE_LOCK=0 bypass, re-entrant through GATE_LOCK_HELD.
# `pnpm gate:status` shows holders and waiters.

if [ $# -eq 0 ]; then
  echo "usage: with-gate-lock.sh <command> [args...]" >&2
  exit 64
fi

exec node "$(dirname "${BASH_SOURCE[0]}")/gate/run.mjs" --weight heavy -- "$@"
