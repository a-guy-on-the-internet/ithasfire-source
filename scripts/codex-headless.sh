#!/usr/bin/env bash
#
# codex-headless.sh — run Codex (GPT) non-interactively with a hang/crash
# watchdog, for orchestration from Claude Code (or any automation).
#
# WHY THIS EXISTS
#   `codex exec` can hang (network stall, wedged model, a spawned shell that
#   never returns) rather than exit cleanly. macOS ships no `timeout` /
#   `gtimeout`, so we can't just wrap it. This script launches codex in its
#   OWN PROCESS GROUP and a watchdog notices when either:
#     - total runtime exceeds --cap-seconds (hard ceiling), OR
#     - no new output lands for --stall-seconds (possible hang).
#
# INVESTIGATE, DON'T REFLEXIVELY KILL (default).
#   A big reasoning model legitimately goes quiet for minutes mid-reasoning, so
#   a stall is NOT reliably a crash. On hitting the cap/stall the watchdog
#   prints a DIAGNOSIS (process alive? last JSONL event? mid tool-call? child
#   procs?) and — by default — LEAVES THE PROCESS ALIVE and returns exit 125
#   ("inconclusive: still running, here's the state, you decide"). The caller
#   then inspects the printed PID, runs `codex resume`, or kills it by that PID.
#   Pass --kill-on-cap to opt into a hard termination instead. Any kill is by
#   PGID (never `pkill`/`killall` by name — shared machine, concurrent sessions).
#
# USAGE
#   scripts/codex-headless.sh [options] -- "PROMPT"
#   scripts/codex-headless.sh [options] --review-uncommitted   (no prompt: `codex exec review` rejects one)
#   scripts/codex-headless.sh [options] --review-base main     (same)
#   For a review scoped to named paths, use a plain prompt that runs `git diff -- <paths>`.
#
# OPTIONS
#   --cap-seconds N      Hard wall-clock ceiling, total across model fallbacks (default 600 = your 10-min check)
#   --stall-seconds N    Trip the watchdog if no output for N seconds (diagnose; leave alive unless --kill-on-cap; default 180)
#   --sandbox MODE       read-only (default) | workspace-write | danger-full-access
#   --cd DIR             Working root for codex (default: $PWD)
#   --model NAME         Override model; default = top-priority listed model in ~/.codex/models_cache.json
#   --image FILE         Attach an image (repeatable) — feed it a screenshot for UI verification
#   --schema FILE        JSON Schema for a structured final response (codex --output-schema)
#   --review-uncommitted Run `codex exec review --uncommitted` instead of a free prompt
#   --review-base BRANCH Run `codex exec review --base BRANCH`
#   --review-commit SHA  Run `codex exec review --commit SHA`
#   --computer-use       Allow computer-use (drops the sandbox; see COMPUTER USE)
#   --kill-on-cap        Kill at the cap instead of leaving it running
#   --out FILE           Where to write the final message (default: a temp file, printed at end)
#   --log FILE           Where to write the JSONL event stream (default: temp); after a model fallback it
#                        holds every attempt, each later one preceded by a {"type":"wrapper.retry"} line
#
# EXIT CODES
#   0   codex completed and returned a final message
#   125 watchdog tripped (cap/stall) and LEFT IT RUNNING — inconclusive; a
#       diagnosis is printed to stderr and the live PID is reported. Not a verdict.
#   124 watchdog KILLED it (only when --kill-on-cap was passed) — also inconclusive
#   1   codex exited non-zero (real error; see the log)
#   2   usage error
#
# MODEL: never pinned. Without --model, the wrapper picks the entry with
#   visibility "list" and the lowest `priority` number in ~/.codex/models_cache.json
#   (1 = top; file order is not relied on), so the newest GPT is used automatically. If the cache is missing or
#   unreadable, -m is omitted and Codex uses the account default. One stderr line
#   says which was chosen. --model NAME overrides.
#   FALLBACK (auto-picked model only): the cache can be stale and list a model the
#   account cannot use. If codex exits non-zero, an `error` or `turn.failed` JSONL
#   event says a model is "not supported" with a ChatGPT account (case-insensitive), AND the run never
#   started any work (no item events other than codex's own `error` items), the
#   wrapper retries once per remaining listed model in priority order, printing
#   "codex-headless: model X rejected, retrying with Y" to stderr, and stops at the
#   first run that is not a model rejection. Text inside tool output never counts,
#   and a run that did any work is never replayed. An explicit --model is never
#   retried. Watchdog trips (124/125) never retry. --cap-seconds is a TOTAL across
#   all attempts; --stall-seconds restarts with each attempt.
#
# COMPUTER USE: --computer-use works headlessly; it sets
#   --dangerously-bypass-approvals-and-sandbox to get past the interactive MCP
#   elicitation, which also drops the shell sandbox. For UI *verification* that
#   only needs to look, capture the screenshot yourself and pass --image instead.
#
# The final agent message is printed to stdout between the BEGIN/END markers so
# a caller can extract it deterministically regardless of JSONL noise.

set -u

CAP=600
STALL=180
SANDBOX="read-only"
WORKDIR="$PWD"
MODEL=""
AUTO_MODEL=0
REST=""
MODEL_IDX=""
KILL_ON_CAP=0
COMPUTER_USE=0
declare -a IMAGES=()
SCHEMA=""
REVIEW_MODE=""
REVIEW_ARG=""
OUT=""
LOG=""

err() { printf '%s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --cap-seconds)   CAP="$2"; shift 2 ;;
    --stall-seconds) STALL="$2"; shift 2 ;;
    --kill-on-cap)   KILL_ON_CAP=1; shift ;;
    --computer-use)  COMPUTER_USE=1; shift ;;
    --sandbox)       SANDBOX="$2"; shift 2 ;;
    --cd)            WORKDIR="$2"; shift 2 ;;
    --model)         MODEL="$2"; shift 2 ;;
    --image)         IMAGES+=("$2"); shift 2 ;;
    --schema)        SCHEMA="$2"; shift 2 ;;
    --review-uncommitted) REVIEW_MODE="uncommitted"; shift ;;
    --review-base)   REVIEW_MODE="base"; REVIEW_ARG="$2"; shift 2 ;;
    --review-commit) REVIEW_MODE="commit"; REVIEW_ARG="$2"; shift 2 ;;
    --out)           OUT="$2"; shift 2 ;;
    --log)           LOG="$2"; shift 2 ;;
    --)              shift; break ;;
    -h|--help)       awk 'NR>1 && !/^#/{exit} NR>1' "$0"; exit 0 ;;
    *)               err "unknown option: $1"; exit 2 ;;
  esac
done

if [ -n "$MODEL" ]; then
  err "codex-headless: model $MODEL (--model)"
else
  MODELS_CACHE="${CODEX_MODELS_CACHE:-$HOME/.codex/models_cache.json}"
  CANDS="$(python3 -I -c '
import json, re, sys
try:
    with open(sys.argv[1]) as f:
        models = json.load(f).get("models", [])
    listed = [m for m in models if m.get("visibility") == "list"
              and re.fullmatch(r"[A-Za-z0-9._:-]+", str(m.get("slug") or ""))]
    def pri(m):
        p = m.get("priority")
        ok = isinstance(p, (int, float)) and not isinstance(p, bool)
        return p if ok else 1e9   # null / missing / non-numeric sorts last
    for m in sorted(listed, key=pri):
        print(m["slug"])
except Exception:
    pass
' "$MODELS_CACHE" 2>/dev/null)" || CANDS=""
  MODEL="${CANDS%%$'\n'*}"
  case "$CANDS" in
    *$'\n'*) REST="${CANDS#*$'\n'}" ;;
  esac
  if [ -n "$MODEL" ]; then
    AUTO_MODEL=1
    err "codex-headless: model $MODEL (top-priority listed in $MODELS_CACHE)"
  else
    err "codex-headless: model: account default (models cache unreadable)"
  fi
fi

PROMPT="${1:-}"
[ -z "$OUT" ] && OUT="$(mktemp)"
[ -z "$LOG" ] && LOG="$(mktemp)"

# Codex >= 0.16x runs every shell command through a `codex-code-mode-host`
# helper. The Homebrew cask (0.163.0) doesn't ship it, but the ChatGPT desktop
# app's bundled CLI does, so prefer that CLI when the helper isn't on PATH.
APP_CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"
if ! command -v codex-code-mode-host >/dev/null 2>&1 \
  && [ -x "$APP_CODEX_BIN/codex" ] && [ -x "$APP_CODEX_BIN/codex-code-mode-host" ]; then
  PATH="$APP_CODEX_BIN:$PATH"
fi

if ! command -v codex >/dev/null 2>&1; then
  err "codex not found on PATH"; exit 2
fi
err "codex-headless: cli $(command -v codex) ($(codex --version 2>/dev/null | head -1))"

# Build the codex argv.
# Computer-use needs the bypass: screen-reading actions fire an interactive MCP
# elicitation that headless `codex exec` can't approve otherwise. The bypass
# also drops the shell sandbox, so keep --computer-use prompts tightly scoped.
declare -a ARGS
if [ "$COMPUTER_USE" = "1" ]; then
  ARGS=(exec --json --dangerously-bypass-approvals-and-sandbox -C "$WORKDIR" -o "$OUT")
else
  ARGS=(exec --json -s "$SANDBOX" -C "$WORKDIR" -o "$OUT")
fi
# Disable "code mode" only when no `codex-code-mode-host` helper can be found.
# Codex 0.144.0 fell back to the classic apply_patch/shell tools with it off;
# from 0.16x, turning it off leaves NO shell at all ("the command execution
# tool is disabled"), so with a helper available it must stay on.
if ! command -v codex-code-mode-host >/dev/null 2>&1; then
  ARGS+=(-c features.code_mode_host=false -c features.code_mode=false)
fi
if [ -n "$MODEL" ]; then
  MODEL_IDX=$(( ${#ARGS[@]} + 1 ))   # slot of the model slug, swapped on a fallback retry
  ARGS+=(-m "$MODEL")
fi
[ -n "$SCHEMA" ] && ARGS+=(--output-schema "$SCHEMA")
# `${A[@]+"${A[@]}"}`: an empty array under `set -u` aborts on bash < 4.4 (macOS /bin/bash is 3.2).
for img in ${IMAGES[@]+"${IMAGES[@]}"}; do ARGS+=(-i "$img"); done

if [ -n "$REVIEW_MODE" ]; then
  ARGS+=(review)
  case "$REVIEW_MODE" in
    uncommitted) ARGS+=(--uncommitted) ;;
    base)        ARGS+=(--base "$REVIEW_ARG") ;;
    commit)      ARGS+=(--commit "$REVIEW_ARG") ;;
  esac
  [ -n "$PROMPT" ] && { err "codex exec review rejects a prompt; for scoped review use a plain prompt running git diff -- <paths>"; exit 2; }
else
  [ -z "$PROMPT" ] && { err "no prompt given (and not a --review-* run)"; exit 2; }
  ARGS+=("$PROMPT")
fi

cleanup_kill() {
  # Kill the process GROUP (negative PID). TERM first, then KILL.
  kill -TERM -"$CX_PID" 2>/dev/null
  sleep 2
  kill -KILL -"$CX_PID" 2>/dev/null
}

# Investigate a wedged/long run: print evidence so a human/orchestrator can
# decide, instead of blindly killing. Never kills here.
diagnose() {
  local reason="$1"
  err "WATCHDOG (${reason}): investigating codex PID $CX_PID — NOT killing by default"
  err "  alive:        $(kill -0 "$CX_PID" 2>/dev/null && echo yes || echo no)"
  err "  last event:   $(grep -o '\"type\":\"[^\"]*\"' "$LOG" 2>/dev/null | tail -1)"
  err "  last tool:    $(grep -o '\"tool\":\"[^\"]*\"[^}]*\"status\":\"[^\"]*\"' "$LOG" 2>/dev/null | tail -1)"
  err "  child procs:  $(pgrep -P "$CX_PID" 2>/dev/null | tr '\n' ' ')"
  err "  log bytes:    $(wc -c < "$LOG" 2>/dev/null | tr -d ' ')  (file: $LOG)"
}

# On cap/stall: kill only if --kill-on-cap; otherwise diagnose, leave alive,
# and return 125 (inconclusive) so the caller decides.
trip() {
  local reason="$1"
  diagnose "$reason"
  if [ "$KILL_ON_CAP" = "1" ]; then
    err "  --kill-on-cap set → terminating process group $CX_PID"
    cleanup_kill; wait "$CX_PID" 2>/dev/null
    echo "---CODEX-BEGIN---"; cat "$OUT" 2>/dev/null; echo; echo "---CODEX-END---"
    exit 124
  fi
  err "  left running. Inspect: tail -f $LOG  ·  resume: codex resume  ·  kill: kill -TERM -$CX_PID"
  echo "---CODEX-BEGIN---"; cat "$OUT" 2>/dev/null; echo; echo "---CODEX-END---"
  exit 125
}

# Did this attempt fail ONLY because the account rejected the model? Exit 0 = yes.
# Reads the JSONL as events, never as text: the rejection must come from a
# top-level `error` or `turn.failed` event, so a tool's output that happens to
# contain "model ... not supported" (a cat of this script, a Prisma error) never
# counts. Any item activity other than codex's own `error` items (a real
# rejection run carries a "Model metadata ... not found" error item) means the
# run did work, possibly edits, and must not be replayed on another model.
# Only the account wording counts ("... with a ChatGPT account"), so an unrelated
# "reasoning effort X is not supported for model Y" never switches models.
# Only events after the last wrapper.retry marker (the current attempt) are read.
model_rejected() {
  python3 -I -c '
import json, sys
rejected = False
activity = False
with open(sys.argv[1], errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if not isinstance(ev, dict):
            continue
        t = ev.get("type")
        msg = None
        if t == "wrapper.retry":
            # Log is appended across attempts: judge only the current one.
            rejected = False
            activity = False
            continue
        if t == "item.started":
            activity = True
        elif isinstance(t, str) and t.startswith("item."):
            item = ev.get("item")
            if not (isinstance(item, dict) and item.get("type") == "error"):
                activity = True
        elif t == "error":
            msg = ev.get("message")
        elif t == "turn.failed":
            e = ev.get("error")
            msg = e.get("message") if isinstance(e, dict) else None
        if isinstance(msg, str):
            low = msg.lower()
            if "not supported" in low and "model" in low and "chatgpt account" in low:
                rejected = True
sys.exit(0 if rejected and not activity else 1)
' "$LOG" 2>/dev/null
}

# One attempt per candidate model. Only an auto-picked model that codex rejects
# loops again; every other outcome falls out of the loop. The watchdog's exits
# (124/125) happen inside trip(), so they never reach the retry check.
# ELAPSED is carried across attempts so --cap-seconds stays a total ceiling.
ELAPSED=0
STEP=3
ATTEMPT=0
while :; do
  : > "$OUT"   # a rejected attempt must not leave a last message behind
  # Launch in its own process group so the watchdog can kill the whole tree by
  # PGID. `set -m` (job control) makes the backgrounded job its own group whose
  # PGID equals its PID.
  set -m
  ATTEMPT=$((ATTEMPT+1))
  if [ "$ATTEMPT" -eq 1 ]; then
    codex "${ARGS[@]}" >"$LOG" 2>&1 &
  else
    # Keep the whole chain: later attempts append after a marker line.
    printf '{"type":"wrapper.retry","model":"%s"}\n' "$MODEL" >>"$LOG"
    codex "${ARGS[@]}" >>"$LOG" 2>&1 &
  fi
  CX_PID=$!
  set +m

  LAST_SIZE=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
  STALL_ACC=0

  while kill -0 "$CX_PID" 2>/dev/null; do
    [ "$ELAPSED" -ge "$CAP" ] && trip "hard cap ${CAP}s exceeded"
    # Stall detection: watch the log file size; if it hasn't grown for STALL
    # seconds, the run MAY be wedged (or just reasoning) — investigate, don't assume.
    CUR_SIZE=$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')
    if [ "$CUR_SIZE" = "$LAST_SIZE" ]; then
      STALL_ACC=$((STALL_ACC+STEP))
      [ "$STALL_ACC" -ge "$STALL" ] && trip "no output for ${STALL}s (possible stall)"
    else
      STALL_ACC=0
      LAST_SIZE="$CUR_SIZE"
    fi
    sleep "$STEP"
    ELAPSED=$((ELAPSED+STEP))
  done

  wait "$CX_PID" 2>/dev/null
  RC=$?

  # Auto-picked model rejected by the account (stale cache)? Try the next listed one.
  if [ "$RC" -ne 0 ] && [ "$AUTO_MODEL" = "1" ] && [ -n "$REST" ] && model_rejected; then
    if [ "$ELAPSED" -ge "$CAP" ]; then
      err "codex-headless: model $MODEL rejected, but the ${CAP}s cap is spent; not retrying"
      break
    fi
    NEXT="${REST%%$'\n'*}"
    case "$REST" in
      *$'\n'*) REST="${REST#*$'\n'}" ;;
      *)       REST="" ;;
    esac
    err "codex-headless: model $MODEL rejected, retrying with $NEXT"
    MODEL="$NEXT"
    ARGS[$MODEL_IDX]="$MODEL"
    continue
  fi
  break
done

echo "---CODEX-BEGIN---"
cat "$OUT" 2>/dev/null
echo
echo "---CODEX-END---"

if [ "$RC" -ne 0 ]; then
  err "codex exited non-zero ($RC); JSONL log at: $LOG"
  exit 1
fi
exit 0
