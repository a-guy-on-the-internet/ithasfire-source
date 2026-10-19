#!/usr/bin/env bash
# Start a fresh Claude Code session from a handoff file — it gets straight to work.
#
# The first turn runs headless in the background with full tools: the new
# session reads the handoff and carries out its next steps without waiting for
# the user. When that turn ends, the session opens in a VS Code tab so the user
# can follow up. Prints the new session id and the log path immediately.
#
# Permission mode for the headless turn: $HANDOFF_PERMISSION_MODE, default
# bypassPermissions (the owner's working mode; a headless run cannot answer
# permission prompts, so a prompting mode would stall on its first Bash call).
#
# MCP servers: the headless turn loads only headless-mcp.json (sentry and
# chrome-devtools, the only servers headless builders called across 116 sessions
# in 2 days) via --strict-mcp-config; every other server in .mcp.json costs
# about 210 MB per session. $HANDOFF_FULL_MCP=1 skips both flags. The VS Code tab
# opened afterwards resumes with the user's full MCP set.
#
# Session cap: the headless turn runs through the machine-wide gate
# (scripts/dev/gate/run.mjs --weight session, 4 slots, GATE_SESSION_SLOTS), so at
# most 4 headless sessions run at once; the rest wait in the background and
# the launcher says so. $HANDOFF_NO_QUEUE=1 runs claude directly, ungated.
#
# Usage: launch.sh <handoff-file.md>
set -euo pipefail

file="${1:?usage: launch.sh <handoff-file.md>}"
[ -f "$file" ] || { echo "no such handoff file: $file" >&2; exit 1; }
file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

name="handoff: $(basename "$file" .md)"
mode="${HANDOFF_PERMISSION_MODE:-bypassPermissions}"
# Model for the new session: $HANDOFF_MODEL, default claude-opus-5-5. Pinned by
# full id because the `opus` alias resolves through whichever CLI runs it: on
# 2026-10-02 the Homebrew CLI mapped it to claude-opus-5 while VS Code ran 5.5.
model="${HANDOFF_MODEL:-claude-opus-5-5}"
sid="$(python3 -c 'import uuid; print(uuid.uuid4())')"
log="${TMPDIR:-/tmp}/handoff-$sid.log"
prompt="You are picking up work from a previous session. Read the handoff at $file, then the files its First reads section lists. Post the goal in one line, the current state and your first step, then carry out the handoff's next steps now — the owner has already approved starting; do not stop to wait for a go. Stop only for a decision that is genuinely the owner's, and end your turn with a short report of what you did and what is next. This first turn runs headless: once it ends, nothing acts on a background agent's or command's result, so never end it while one is still running. Run builds, gates and agents in the foreground, or wait for each background one to report before you finish."

# Preflight, synchronous. The turn below runs in the background and swallows
# its own failure, so a CLI too old for $model would open a dead tab. The API's
# 400 names the fix ("version 2.1.280 or newer is required").
check="$(claude -p --strict-mcp-config --model "$model" --no-session-persistence --output-format json \
  "Reply with only the word ok." < /dev/null 2>/dev/null | tail -1 || true)"
if ! printf '%s' "$check" | python3 -c 'import json,sys; sys.exit(1 if json.load(sys.stdin).get("is_error") else 0)' 2>/dev/null; then
  echo "handoff not launched: this claude CLI ($(claude --version 2>/dev/null)) cannot run $model" >&2
  printf '%s' "$check" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))' >&2 2>/dev/null || printf '%s\n' "$check" >&2
  exit 1
fi

# -p terminates background tasks (subagents, background Bash) 600s after the
# turn ends, so a handoff that dispatches its builders and ends its turn lost
# every one of them (2026-10-14: 2FA and editor builds killed, nothing landed).
# 0 = wait for them however long they take.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-0}"

mcp_args=()
mcp_cfg="$PWD/.claude/skills/handoff/headless-mcp.json"
if [ "${HANDOFF_FULL_MCP:-0}" != "1" ]; then
  if [ -f "$mcp_cfg" ]; then
    mcp_args=(--strict-mcp-config --mcp-config "$mcp_cfg")
  else
    echo "warning: $mcp_cfg is missing; the headless turn loads the full MCP set" >&2
  fi
fi

# $HANDOFF_GATE_RUN overrides the gate runner (tests only).
gate_run="${HANDOFF_GATE_RUN:-scripts/dev/gate/run.mjs}"
ready="${TMPDIR:-/tmp}/handoff-$sid.ready"
gate=()
if [ "${HANDOFF_NO_QUEUE:-0}" != "1" ]; then
  gate=(node "$gate_run" --weight session --label "$name" --ready-file "$ready" --)
fi

# One line saying whether this session will start now or wait. Silent when the
# status call fails or reports no session slots.
queue_note() {
  node scripts/dev/gate/status.mjs --json 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    slots = [s for s in d.get("slots", []) if str(s.get("name", "")).startswith("session")]
    if not slots:
        sys.exit(0)
    busy = sum(1 for s in slots if not s.get("free") and not s.get("stale"))
    waiting = sum(1 for w in d.get("waiters", []) if w.get("weight") == "session")
    if busy >= len(slots):
        print("queued: %d of %d headless sessions running, %d waiting; this one starts when a slot frees (pnpm gate:status)" % (busy, len(slots), waiting))
except Exception:
    pass
' 2>/dev/null || true
}

note=""
[ "${#gate[@]}" -gt 0 ] && note="$(queue_note)"

(
  # A GATE_LOCK_HELD inherited from a gated parent would make the ungated paths
  # look gated; run.mjs strips it itself on the gated path.
  unset GATE_LOCK_HELD
  claude_args=(-p ${mcp_args[@]+"${mcp_args[@]}"} --session-id "$sid" --model "$model" --permission-mode "$mode" -n "$name" "$prompt")
  rc=0
  ${gate[@]+"${gate[@]}"} claude ${claude_args[@]+"${claude_args[@]}"} < /dev/null > "$log" 2>&1 || rc=$?
  # The gate itself failed before claude started (64 usage, 70 invalid slot file,
  # 127 command not found): without the ready file claude never ran, so run it
  # ungated rather than open a tab onto a session that does not exist.
  if [ "${#gate[@]}" -gt 0 ] && [ ! -e "$ready" ] && { [ "$rc" = 64 ] || [ "$rc" = 70 ] || [ "$rc" = 127 ]; }; then
    echo "handoff: gate exited $rc before claude started; running claude ungated" >> "$log"
    claude ${claude_args[@]+"${claude_args[@]}"} < /dev/null >> "$log" 2>&1 || true
  fi
  rm -f "$ready"
  open "vscode://anthropic.claude-code/open?session=$sid"
) > /dev/null 2>&1 &
disown || true

echo "$sid"
echo "log: $log"
[ -n "$note" ] && echo "$note"
exit 0
