---
name: error-tracker
description: "Query Cloud Logging for production errors, group into signatures, and maintain docs/ops/error-log.md as a living backlog of stuff to fix. Invoke daily via the scheduled automation, or manually to refresh the log."
---

# Error Tracker

Scrapes the last 24 hours of Cloud Logging for `severity >= ERROR` on Ithas Fire's Cloud Run services, groups errors by signature, and keeps `docs/ops/error-log.md` as a grep-able backlog with stable `ERR-NNNN` IDs.

## When to run

- **Daily 06:00 local** — via the scheduled automation (see `CronCreate` setup below)
- **Manually** — when investigating a recent incident or checking the current state

## Prerequisites

- `gcloud` source active and configured with `CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT=sad-mans-computer@hearthfire-491918.iam.gserviceaccount.com`. This is already set in the source config — just activate the source.

## How stats are collected (the mechanism)

**Cloud Logging is the source of truth.** `docs/ops/error-log.md` is a materialised view. Git is the history store. No separate stats database.

Per run, to produce accurate numbers the automation:

1. **Discovery query** — single `--freshness=24h` query over all Cloud Run services to find every error signature with activity in the last day. New signatures get `ERR-NNNN` IDs.
2. **Per-signature 7-day refresh** — for every signature tracked in the Open **or** Ignored section, run a targeted `--freshness=7d` query filtered to that signature's service + pattern. That is the `Count (7d)` value. Cheap; most signatures resolve in < 500ms.
3. **Trend computation** — read yesterday's committed file: `git show HEAD~1:docs/ops/error-log.md`. For each ERR-NNNN that existed in the prior snapshot, compare old `Count (7d)` → new. Thresholds:
   - `new ≥ 2× old` → **↗** (up)
   - `new ≤ 0.5× old` → **↘** (down)
   - else → **→** (steady)
   - No prior entry → no trend arrow (fresh signature)
4. **Write and commit** — if any counts or signatures changed, write the file and commit with `chore(ops): error-tracker daily run YYYY-MM-DD`.

**Why this shape:** re-querying from Cloud Logging every run means the MD file can't silently drift from reality. If someone edits it by hand and lies about a count, the next run corrects it. Git handles versioning and diffs for free. The file is grep-able and PR-referencable; the counts stay honest.

## Queries to run

All queries use project `hearthfire-491918` and default to `--freshness=24h` unless re-seeding.

### 1. Cloud Run 5xx by service

```
resource.type="cloud_run_revision"
severity>=ERROR
```

Fields we need per entry: `resource.labels.service_name`, `httpRequest.status`, `httpRequest.requestUrl`, `jsonPayload.message`, `textPayload`, `timestamp`.

### 2. Unhandled exceptions (focus on `api`, `jobs`)

```
resource.type="cloud_run_revision"
(resource.labels.service_name="hf-prod-api" OR resource.labels.service_name="hf-prod-jobs")
severity>=ERROR
(textPayload=~"Error:" OR jsonPayload.error=~".+")
```

### 3. Stripe webhook failures

```
resource.type="cloud_run_revision"
(textPayload=~"stripe" OR jsonPayload.message=~"stripe")
severity>=ERROR
```

## Signature grouping

Two errors are the "same signature" if they share:

1. **Service** (`hf-prod-web`, `hf-prod-api`, `hf-prod-jobs`, `hf-prod-tileserver`, etc.)
2. **Either** the first line of the error message (trimmed of dynamic values like UUIDs, IDs, timestamps) **or** the request URL pattern (path only, no query string)

Normalise dynamic values before comparing:

- UUIDs → `<uuid>`
- Numbers longer than 4 digits → `<N>`
- `?...` query strings → stripped
- Stack-trace paths with `?cache-buster` suffixes → stripped

## Output: `docs/ops/error-log.md`

```markdown
# Production error log

Last updated: <ISO timestamp> by error-tracker automation.

## Open — <count> signatures, <total_occurrences> occurrences in last 7 days

### [ERR-NNNN] <one-line summary>
- **Service:** `<service_name>`
- **First seen:** YYYY-MM-DD · **Last seen:** YYYY-MM-DD
- **Count (7d):** <n> · **Trend:** ↗ (up 2x) | → (steady) | ↘ (down)
- **Signature:** `<stack top or URL pattern>`
- **Example log:** [Cloud Logging link with time range]
- **Triage:** open | investigating | waiting_on_<thing>
- **Notes:** <free text, optional>

...

## Recently fixed — rolling 14 days

### [ERR-NNNN] <summary> — last seen YYYY-MM-DD
- Service: `<service>`
- Resolved by: <PR link or commit, optional>
```

### Triage states

The `Triage:` field is **human-owned**. The automation reads it to decide how to place an entry; it never writes to it. Allowed values:

| State | Meaning | Automation behaviour |
|---|---|---|
| `open` | New or unresolved. Default for new signatures. | Shown in Open section, sorted by `Count (7d)`. |
| `investigating` | Someone is actively on it. | Shown in Open section. |
| `waiting_on_<thing>` | Blocked (e.g. `waiting_on_stripe`, `waiting_on_infra`). | Shown in Open section, visually grouped. |
| `ignored` | Decided this is noise — crawler traffic, third-party flake, accepted trade-off. | Moved to **Ignored** section. Counts still update so you can tell if it escalates, but it doesn't clutter Open. |
| `fixed` | Human marked it fixed before the 14-day silence window. | Moved to **Recently fixed** on the next run regardless of whether it's still firing (trust the human). |

### Rules for updating

- **New signature** — assign next `ERR-NNNN` (monotonic, never reused). Add to Open with `Triage: open`.
- **Known signature, Triage in {`open`, `investigating`, `waiting_on_*`}** — update `Last seen`, `Count (7d)`, `Trend`. Keep in Open. Don't touch `Triage` or `Notes`.
- **Known signature, Triage = `ignored`** — update `Last seen`, `Count (7d)`, `Trend`. Keep in **Ignored** section. If `Count (7d)` jumps ≥ 3× over the previous run's count, add a `⚠ Escalation:` line below the entry — the human can decide whether to re-open. Don't auto-re-open; that overrides human judgment.
- **Known signature, Triage = `fixed`** — move to **Recently fixed** on the next run. Add a `Resolved: YYYY-MM-DD` line. If the signature keeps appearing in logs for 3 consecutive runs after being marked fixed, add a `⚠ Regression?` line — likely the fix didn't actually ship.
- **Silent > 14 days (regardless of triage state)** — move from Open (or Ignored) to Recently fixed with an auto-resolution note. Keep for 30 days, then drop.
- **Ordering** — Open section sorted by `Count (7d)` descending. Ignored section sorted by `Last seen` descending (recent noise first).

## What's a worthwhile signature to track

- ✅ **5xx on user-facing routes** (`hf-prod-web`, `hf-prod-api`) — affects real users
- ✅ **Unhandled exceptions** — stack traces matter, they're bugs
- ✅ **Stripe webhook failures** — payment correctness; any failure is load-bearing
- ✅ **Settlement / payout errors** — money path; zero-tolerance
- ⚠️ **`hf-dev-*` errors** — include but lower priority. Dev-only bugs are still signal but don't block launches.
- ❌ **Rate limit 429s** — expected, noise
- ❌ **Client-IP-address timeout 504s from obvious crawlers** — filter out well-known bot user-agents

## Example output (first run, 2026-04-24)

```markdown
# Production error log

## Open — 4 signatures, 47 occurrences in last 7 days

### [ERR-0001] hf-prod-web homepage timing out
- **Service:** `hf-prod-web`
- **First seen:** 2026-04-21 · **Last seen:** 2026-04-23
- **Count (7d):** 23 · **Trend:** ↗
- **Signature:** `GET ithasfire.com/ → 504`
- **Triage:** open

### [ERR-0002] search.full-reindex job 500s
- **Service:** `hf-prod-jobs`
- **First seen:** 2026-04-22 · **Last seen:** 2026-04-23
- **Count (7d):** 8 · **Trend:** →
- **Signature:** `POST /jobs/search.full-reindex → 500`
- **Triage:** open

### [ERR-0003] Stripe webhook module resolution (dev)
- **Service:** `hf-dev-api`
- **First seen:** 2026-04-22 · **Last seen:** 2026-04-23
- **Count (7d):** 12 · **Trend:** →
- **Signature:** `ERR_MODULE_NOT_FOUND: @th/core/src/use-cases/orders/reconcile-stripe-full-refund`
- **Triage:** open

### [ERR-0004] Tileserver blanket 502s
- **Service:** `hf-prod-tileserver` / `hf-dev-tileserver`
- **First seen:** 2026-04-22 · **Last seen:** 2026-04-23
- **Count (7d):** 4 · **Trend:** →
- **Signature:** `502 on all static asset paths`
- **Triage:** open
```

## Referencing errors in PRs

Commit/PR titles reference the ID:

```
fix: ERR-0002 — index settlement_order_id to unblock search.full-reindex job
```

Two ways to close the loop:

1. **Passive** — let the signature go silent. The automation moves it to Recently fixed after 14 days of no hits.
2. **Active** — edit the entry in `docs/ops/error-log.md`, change `Triage: open` to `Triage: fixed`, commit. The next automation run moves it to Recently fixed immediately and will flag a regression if it keeps firing.

## Dismissing noise

For errors that are real-looking but not worth fixing (third-party 500s from a crawler, rate-limited clients, intentional test failures):

1. Edit the entry, change `Triage: open` to `Triage: ignored`.
2. Add a short **Reason:** line explaining why it's ignored — for the future reader who finds it and wonders.
3. Commit.

The entry moves to the Ignored section on the next run. Counts keep updating silently, so if the signature escalates 3× or more the automation surfaces an `⚠ Escalation:` flag and the human can reconsider.
