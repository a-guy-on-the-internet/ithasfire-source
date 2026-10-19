#!/usr/bin/env bash
#
# agy-headless.sh — run Google Antigravity (`agy`) headlessly for VISUAL UI
# CRITIQUE of screenshots, with a hang/crash watchdog. Companion to
# scripts/codex-headless.sh; this one is Gemini's lane (see the codex-delegate /
# ui skills for the model-routing split: Gemini judges rendered UI, Claude owns
# design generation + taste decisions, GPT-5.5 does grunt/code review).
#
# WHY A WRAPPER
#   - `agy -p` takes the PROMPT as the value of -p, and Go-style flag parsing
#     means all other flags MUST come before it — otherwise -p swallows the next
#     flag as the prompt (a real footgun that silently produces garbage answers).
#     This script gets the ordering right.
#   - Vision input: agy has no --image flag. It reads image FILES referenced by
#     path in the prompt, from directories added via --add-dir. Point --images-dir
#     at a folder of screenshots; the prompt should reference them by path.
#   - Watchdog INVESTIGATES, doesn't reflexively kill (a reasoning model goes
#     quiet mid-turn): on cap/stall it diagnoses + leaves the run alive (exit
#     125) unless --kill-on-cap. Kills are by PGID, never pattern-kill.
#
# USAGE
#   scripts/agy-headless.sh --images-dir DIR [opts] -- "PROMPT that references the image paths"
#
# OPTIONS
#   --images-dir DIR    Folder of screenshots to make visible to agy (--add-dir). Repeatable.
#   --model NAME        Exact model string from `agy models` (has spaces/parens — quote it).
#                       Default: "Gemini 3.1 Pro (High)" — the strongest Gemini tier
#                       on the free plan. Pass a Flash tier for cheap/fast bulk passes.
#   --cap-seconds N     Hard wall-clock ceiling (default 600).
#   --stall-seconds N   Diagnose if no output for N seconds (default 180).
#   --kill-on-cap       Hard-kill on cap/stall instead of leaving it alive.
#   --cd DIR            Working root (default $PWD).
#
# EXIT CODES: 0 ok · 125 watchdog tripped, left running (inconclusive) ·
#             124 watchdog killed (--kill-on-cap) · 1 agy error · 2 usage.
#
# NOTE: agy auths via the Antigravity account (browser sign-in, `agy` no-args).
# It does NOT use GOOGLE_APPLICATION_CREDENTIALS, so no SA-hijack dance needed.

set -u

declare -a IMG_DIRS=()
# Highest Gemini reasoning tier on the free Antigravity plan (user preference:
# always run critique on the strongest model available). Exact string must
# match `agy models`; if Antigravity renames/retires it, agy errors — re-check
# `agy models` and update. --model still overrides.
MODEL="Gemini 3.1 Pro (High)"
CAP=600
STALL=180
KILL_ON_CAP=0
WORKDIR="$PWD"

err() { printf '%s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --images-dir)    IMG_DIRS+=("$2"); shift 2 ;;
    --model)         MODEL="$2"; shift 2 ;;
    --cap-seconds)   CAP="$2"; shift 2 ;;
    --stall-seconds) STALL="$2"; shift 2 ;;
    --kill-on-cap)   KILL_ON_CAP=1; shift ;;
    --cd)            WORKDIR="$2"; shift 2 ;;
    --)              shift; break ;;
    -h|--help)       sed -n '2,40p' "$0"; exit 0 ;;
    *)               err "unknown option: $1"; exit 2 ;;
  esac
done

PROMPT="${1:-}"
[ -z "$PROMPT" ] && { err "no prompt given"; exit 2; }
command -v agy >/dev/null 2>&1 || { err "agy (Antigravity CLI) not on PATH"; exit 2; }

LOG="$(mktemp)"

# Build argv — ALL flags before -p, prompt is -p's value (see WHY A WRAPPER).
# agy has no --cd; it uses the process cwd, so we cd into WORKDIR at launch.
declare -a ARGS=(--dangerously-skip-permissions)
for d in "${IMG_DIRS[@]}"; do ARGS+=(--add-dir "$d"); done
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
ARGS+=(-p "$PROMPT")

set -m
( cd "$WORKDIR" && exec agy "${ARGS[@]}" ) >"$LOG" 2>&1 &
CX_PID=$!
set +m

diagnose() {
  err "WATCHDOG ($1): investigating agy PID $CX_PID — NOT killing by default"
  err "  alive:       $(kill -0 "$CX_PID" 2>/dev/null && echo yes || echo no)"
  err "  child procs: $(pgrep -P "$CX_PID" 2>/dev/null | tr '\n' ' ')"
  err "  log bytes:   $(wc -c < "$LOG" 2>/dev/null | tr -d ' ')  (file: $LOG)"
  err "  log tail:    $(tail -1 "$LOG" 2>/dev/null)"
}
trip() {
  diagnose "$1"
  if [ "$KILL_ON_CAP" = "1" ]; then
    err "  --kill-on-cap → terminating group $CX_PID"
    kill -TERM -"$CX_PID" 2>/dev/null; sleep 2; kill -KILL -"$CX_PID" 2>/dev/null
    wait "$CX_PID" 2>/dev/null
    echo "---AGY-BEGIN---"; cat "$LOG" 2>/dev/null; echo; echo "---AGY-END---"; exit 124
  fi
  err "  left running. inspect: tail -f $LOG  ·  kill: kill -TERM -$CX_PID"
  echo "---AGY-BEGIN---"; cat "$LOG" 2>/dev/null; echo; echo "---AGY-END---"; exit 125
}

ELAPSED=0; STEP=3; LAST=-1; SACC=0
while kill -0 "$CX_PID" 2>/dev/null; do
  [ "$ELAPSED" -ge "$CAP" ] && trip "hard cap ${CAP}s exceeded"
  CUR=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
  if [ "$CUR" = "$LAST" ]; then
    SACC=$((SACC+STEP)); [ "$SACC" -ge "$STALL" ] && trip "no output for ${STALL}s"
  else SACC=0; LAST="$CUR"; fi
  sleep "$STEP"; ELAPSED=$((ELAPSED+STEP))
done

wait "$CX_PID" 2>/dev/null; RC=$?
echo "---AGY-BEGIN---"; cat "$LOG" 2>/dev/null; echo; echo "---AGY-END---"
[ "$RC" -ne 0 ] && { err "agy exited non-zero ($RC); log: $LOG"; exit 1; }
rm -f "$LOG"
exit 0
