# Automation health

Append-only status line per scheduled-agent run, written by
`.claude/curation/run.sh`. One place to answer "is anything scheduled actually
running?" without parsing timestamped logs or trusting `launchctl list`.

**Why this file exists:** both curation agents failed every Monday from
2026-08-03 (Claude spend limit, then expired OAuth) and nobody noticed until
2026-08-19 — `docs/curation/` simply stopped at 2026-07-27. `run.sh` used
`set -e`, so a non-zero `claude` exit aborted the script before it could log
"finished", let alone alert. Failures left no trace anywhere a human looks.

A run appends `ok` or `**FAILED (exit N)**` with the fatal reason. Failures also
raise a macOS notification, and POST to `$AGENT_ALERT_WEBHOOK` when that is set.

**Stale is a failure too.** If the newest line for a weekly task is more than
~8 days old, it did not run at all — launchd never fired, or the machine was
asleep. Absence of a FAILED line is not evidence of health.

---
- **stale-event-sweep** — **FAILED (exit 1)** — 2026-08-31 12:25 CDT
  - `Failed to authenticate: OAuth session expired and could not be refreshed`
  - log: `.claude/curation/logs/stale-event-sweep-20260831-122543.log`
- **open-mic-scout** — **FAILED (exit 1)** — 2026-08-31 12:25 CDT
  - `Failed to authenticate: OAuth session expired and could not be refreshed`
  - log: `.claude/curation/logs/open-mic-scout-20260831-122543.log`
- **open-mic-scout** — **FAILED (exit 1)** — 2026-09-07 09:07 CDT
  - `API Error: 400 Claude Code 2.1.236 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.`
  - log: `.claude/curation/logs/open-mic-scout-20260907-090706.log`
- **stale-event-sweep** — **FAILED (exit 1)** — 2026-09-07 09:37 CDT
  - `API Error: 400 Claude Code 2.1.236 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.`
  - log: `.claude/curation/logs/stale-event-sweep-20260907-093706.log`
- **open-mic-scout** — **FAILED (exit 1)** — 2026-09-14 09:23 CDT
  - `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message`
  - log: `.claude/curation/logs/open-mic-scout-20260914-090938.log`
- **stale-event-sweep** — **FAILED (exit 1)** — 2026-09-14 09:54 CDT
  - `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message`
  - log: `.claude/curation/logs/stale-event-sweep-20260914-093925.log`
- **open-mic-scout** — **FAILED (exit 1)** — 2026-09-21 13:17 CDT
  - `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message`
  - log: `.claude/curation/logs/open-mic-scout-20260921-090721.log`
- **stale-event-sweep** — **FAILED (exit 1)** — 2026-09-21 13:17 CDT
  - `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message`
  - log: `.claude/curation/logs/stale-event-sweep-20260921-094636.log`
- **open-mic-scout** — **FAILED (exit 1)** — 2026-09-28 09:11 CDT
  - `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message`
  - log: `.claude/curation/logs/open-mic-scout-20260928-091129.log`
- **stale-event-sweep** — **FAILED (exit 1)** — 2026-09-28 09:37 CDT
  - `You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message`
  - log: `.claude/curation/logs/stale-event-sweep-20260928-093740.log`
- **stale-event-sweep** — ok — 2026-10-05 11:26 CDT
- **open-mic-scout** — ok — 2026-10-05 11:31 CDT
- **open-mic-scout** — **FAILED (exit 3)** — 2026-10-12 09:07 CDT
  - `prod DB secret fetch failed or returned empty (gcloud auth expired or offline); refusing to sweep the local DB`
  - log: `.claude/curation/logs/open-mic-scout-20261012-090700.log`
- **stale-event-sweep** — **FAILED (exit 3)** — 2026-10-12 09:37 CDT
  - `prod DB secret fetch failed or returned empty (gcloud auth expired or offline); refusing to sweep the local DB`
  - log: `.claude/curation/logs/stale-event-sweep-20261012-093703.log`
