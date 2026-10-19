---
name: error-tracker
description: "Refresh docs/ops/error-log.md, the backlog of production error signatures, from Sentry (plus Cloud Logging for crashes Sentry cannot see). Use when asked for production errors, the error log, or what is breaking in prod."
---

# Error Tracker

Keeps `docs/ops/error-log.md` as a grep-able backlog of production error signatures with stable `ERR-NNNN` IDs. The file is a materialised view: every run re-reads the sources, so a hand-edited count is corrected on the next run.

**Nothing runs this on a schedule.** The log was last written 2026-04-23. Run it by hand; scheduling it needs a token-auth path first (like resource-burn's `scripts/sentry-burn.mjs`), because the Sentry MCP's OAuth token expires in headless runs (resource-burn, "Prerequisites").

## Sources

### 1. Sentry (primary)

Sentry sees what Cloud Logging misses: every `reportError` swallow (the deliberate catch-and-fallback branches, CLAUDE.md "Error Reporting Convention"), `logger.error` through the pino integration, and server tRPC 500s via `logAndReport`.

- Org `hearth-fire`, region `https://us.sentry.io`. Projects: `hearth-fire-web` (web **and** the API and jobs servers, which share its DSN), `hearth-fire-mobile`, `hearth-fire-scanner`.
- **Every query carries `environment:production`.** Dev and prod report into the same project; an unfiltered sweep once surfaced 3,442 localhost Redis errors that read as a prod outage.
- Discovery: `mcp__sentry__search_issues` per project, `query: "environment:production is:unresolved"`, `period: "24h"`, `sort: "freq"`, `limit: 100`.
- 7-day refresh: the same with `period: "7d"` for every signature already in Open or Ignored; counts come from `mcp__sentry__search_errors` (`count()` grouped by issue) over `7d`.
- Sentry has already grouped events into issues, so a Sentry signature is its issue short ID (`HEARTH-FIRE-WEB-1A2`). Keep the issue link on the entry.
- Load the Sentry tools with ToolSearch (`select:mcp__sentry__search_issues,mcp__sentry__search_errors,mcp__sentry__get_sentry_resource`).

### 2. Cloud Logging (what never reaches the SDK)

Project `hearthfire-491918`, `gcloud logging read --freshness=24h` (and `7d` for refreshes). Only these classes:

- **Pre-boot crashes**: a container that dies before Node starts (failed secret injection, bad image) never reaches Sentry. `resource.type="cloud_run_revision" severity>=ERROR` with no matching Sentry issue.
- **Platform 5xx**: `httpRequest.status>=500` from Cloud Run itself (timeouts, OOM kills).
- **Jobs that "succeeded" with `{success:false}`**: `apps/jobs` answers 200 unless the handler throws, so a failing job can look green. Search `hf-prod-jobs` for `success:false` in `jsonPayload`.

Signature for a Cloud Logging entry: service + first line of the message (or the URL path), with UUIDs → `<uuid>`, numbers over 4 digits → `<N>`, query strings stripped.

## Run

1. Read the current `docs/ops/error-log.md` and note every entry's `Triage` and `Count (7d)`.
2. Query both sources as above.
3. Apply the update rules below and rewrite the file. Trend compares against the counts you noted in step 1: `new ≥ 2× old` → ↗, `new ≤ 0.5× old` → ↘, else →; no prior entry → no arrow.
4. Report to the user: new signatures, escalations, regressions of `fixed` entries, and anything on a money path (Stripe webhooks, settlement, payouts), which is zero-tolerance. Leave the commit to the user or the orchestrator (temp-index, explicit path).

Done when every Open and Ignored entry has a fresh `Count (7d)` from this run and every production Sentry issue from the last 24h is either an entry or listed in the report as skipped noise with a reason.

## File format

```markdown
# Production error log

Last updated: <ISO timestamp> by error-tracker (manual run).

## Open — <count> signatures, <total> occurrences in last 7 days

### [ERR-NNNN] <one-line summary>
- **Source:** Sentry `<SHORT-ID>` <issue link> | Cloud Logging `<service>`
- **First seen:** YYYY-MM-DD · **Last seen:** YYYY-MM-DD
- **Count (7d):** <n> · **Trend:** ↗ | → | ↘
- **Signature:** `<issue title or normalised message / URL pattern>`
- **Triage:** open | investigating | waiting_on_<thing>
- **Notes:** <optional>

## Ignored

## Recently fixed — dropped after 30 days

### [ERR-NNNN] <summary> — last seen YYYY-MM-DD
- Resolved by: <commit or PR, optional>
```

## Update rules

`Triage` and `Notes` are human-owned; the run reads them and never rewrites them.

- **New signature**: next `ERR-NNNN` (monotonic, never reused), into Open with `Triage: open`.
- **`open` / `investigating` / `waiting_on_*`**: refresh Last seen, Count, Trend; stays in Open, sorted by Count descending.
- **`ignored`**: refresh counts in the Ignored section (sorted by Last seen). A Count ≥ 3× the previous run's adds an `⚠ Escalation:` line.
- **`fixed`**: move to Recently fixed with `Resolved by:` and the date. Firing again in any later run → back to Open with `⚠ Regression:`, which asks the owner to reset Triage; until they do, the entry stays in Open.
- **Silent 14 days** (any state): move to Recently fixed with an auto-resolution note; drop after 30 days.

Worth tracking: user-facing 5xx, unhandled exceptions, `reportError` swallows, Stripe webhook failures, settlement/payout errors. Noise: expected 429s, crawler timeouts (filter by user agent).

Commit and PR titles cite the ID (`fix: ERR-0002 — …`). To close an entry by hand, set `Triage: fixed`; to dismiss noise, set `Triage: ignored` and add a **Reason:** line.
