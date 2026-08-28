---
name: resource-burn
description: "Query Sentry spans for how fast we are consuming each metered dependency (Upstash, Neon, Resend, Expo, ZipTax), compare against quota, and maintain docs/ops/resource-burn.md as a living headroom report. Invoke weekly via the scheduled automation, or manually when a quota scare is suspected."
---

# Resource Burn

Sibling to `[skill:error-tracker]`. Where that one asks *"what is throwing?"*, this
one asks **"what are we consuming, and how close to a ceiling is it?"**

## Why this exists

Saturation is not an error until it abruptly is. Two multi-day outages came from
resource exhaustion that no error path could have caught early:

- **2026-06, Neon compute quota** — 4-day silent search outage.
- **2026-07-28, Upstash 500K commands/month** — every mutation taking an
  idempotency key started 500ing (`events.createEventForHuman`), because
  `RedisIdempotency` does not fail open.

In both cases the telemetry that would have predicted it was **already in
Sentry, weeks early**. Nobody ran the query until production was down. The
post-mortem query for Upstash took ~30 seconds:

```
dataset: spans
query:   span.op:db.redis OR span.description:*redis*
fields:  ["span.description", "count()"]
sort:    -count()
period:  24h
```

That single query showed job-run bookkeeping was ~91% of all Redis commands.
**This skill exists to run that class of query on a schedule instead of at a
funeral.**

## When to run

- **Weekly, Monday** — via the scheduled automation.
- **Manually** — when a dependency looks hot, before raising a plan tier, or
  after shipping anything that adds per-request calls to a metered service.

## Prerequisites — TWO paths, pick by how you were invoked

### Scheduled / headless → `scripts/sentry-burn.mjs`

```bash
node scripts/sentry-burn.mjs --period 7d            # human-readable
node scripts/sentry-burn.mjs --period 7d --json     # machine-readable
```

Needs `SENTRY_AUTH_TOKEN` (already exported from the operator's `~/.zshrc`;
also lives in Forgejo as `TF_VAR_SENTRY_AUTH_TOKEN`). `SENTRY_ORG` defaults to
`hearth-fire`.

**Do NOT reach for the Sentry MCP on this path.** The MCP authenticates by
interactive OAuth, that token expires, and a headless run cannot refresh it —
an expired OAuth token is exactly what killed the 2026-08-10 scheduled curation
run, silently, for weeks. The script exits non-zero on auth or transport
failure rather than reporting zeroes, so `.claude/curation/run.sh` surfaces it
instead of writing a report that reads like "no usage".

### Interactive → the Sentry MCP is fine

`mcp__sentry__search_events` with `dataset: "spans"` is more flexible for
follow-up questions once a number looks wrong. Same data; the script is just
the queries this report always needs.

### Either way

**Backend spans land in the `hearth-fire-web` project**, not a backend project —
there isn't one. The API and jobs services share a single injected `SENTRY_DSN`.
Filter by `environment:production` to exclude dev/preview.

The script already flags the regression that matters: if the `JobRunTracker`
signature (`zadd`/`multi`/`exec`/`zremrangebyrank`/`hget`) reappears in the
Redis breakdown, that is the exact pattern that exhausted the quota on
2026-07-28 — treat it as a regression, not noise.

## THE SAMPLING RULE (read before trusting any number)

Production sets `tracesSampleRate: 0.1`, overridable per-service via
`SENTRY_TRACES_SAMPLE_RATE` (see `resolveTracesSampleRate` in
`apps/api/src/instrument.ts` and `apps/jobs/src/instrument.ts`). Sampling has
two consequences that pull in opposite directions, and conflating them is how
the original post-mortem got muddy:

- **Ratios are EXACT.** Every span inside one transaction shares that
  transaction's sampling decision. So "job bookkeeping is 91% of Redis traffic"
  needs no correction and carries no sampling error. Share-of-traffic numbers
  are trustworthy.
- **Absolute counts are ESTIMATES.** True volume is
  `observed / client_sample_rate`. Sentry records the effective rate on each
  trace as `client_sample_rate`; read it from a sample event rather than
  assuming 0.1, because the value is env-overridable.

**As measured 2026-07-30, the effective multiplier is ≈1 — observed counts are
true counts, despite the configured 0.1.** Do not assume that forever. Re-verify
with the known-rate trick below whenever `tracesSampleRate` changes, the SDK is
upgraded, or the numbers stop making sense.

### The known-rate trick (how to re-verify)

Pick a signal whose true rate is knowable independently of Sentry, and compare.
`POST /jobs/:name` is ideal: Cloud Scheduler fires it on a fixed cron, so
`apps/jobs/jobs.manifest.json` is a hard ceiling on how often it *can* occur.

- Sum the manifest's `scheduled` crons into runs/day (**~1,635/day** as of the
  2026-07-30 retune; it was 3,591 before).
- Query `transaction:"POST /jobs/:name" AND is_transaction:true` over 24h.
- `multiplier ≈ manifest_runs_per_day / observed`.

If observed ever *exceeds* what cron can produce, the excess is queue-job
traffic, not sampling — check `queue` jobs in the manifest before concluding.

If an absolute count is load-bearing and the trick is inconclusive, set
`SENTRY_TRACES_SAMPLE_RATE=1.0` on the relevant service for a bounded window and
measure directly, then dial it back.

**Record which method was used** in the Method column — a number whose
provenance is unknown is not evidence. State a range rather than a point
estimate whenever the multiplier is genuinely uncertain: writing "~336K/day"
when the honest answer is "34K–336K/day depending on sampling" is the exact
failure mode this section exists to prevent.

## Metered dependencies to track

| Dependency | Ceiling | Span signature |
|---|---|---|
| Upstash Redis | 500K commands/month (free tier) | `span.op:db.redis OR span.description:*redis*` |
| Neon Postgres | compute-hours (plan-dependent) | `span.op:db OR span.op:db.sql.prisma` |
| Resend | plan send limit | `span.description:*resend*` + `notify` use-case logs |
| Expo Push | unauthenticated tier, soft | `span.description:*expo*` |
| ZipTax | per-lookup billing | `span.description:*ziptax*` |
| Meilisearch / Cloud Run | request + CPU-time | `span.op:http.server` grouped by `transaction` |

Ceilings drift — **re-read them from the provider console, do not trust this
table blindly.** If a ceiling cannot be confirmed this run, mark it `unknown`
rather than carrying a stale figure forward; a confidently wrong ceiling is
worse than an absent one.

## Per-run procedure

1. **Per-dependency volume** — for each row above, run `search_events` over
   `period: 7d`, `environment:production`, grouped by `span.description` with
   `count()`. Note the top consumer per dependency.
2. **Attribute the top consumer** — re-run the hottest signature grouped by
   `transaction`. This is the step that turns "Redis is busy" into
   "`POST /jobs/:name` is 91% of Redis". Without it the report is not
   actionable.
3. **Project against ceiling** — normalise to per-day, multiply to the quota
   window, divide by the ceiling. Apply the sampling rule above.
4. **Trend** — read last run's committed file via
   `git show HEAD~1:docs/ops/resource-burn.md` and compare per-dependency
   projected utilisation:
   - `new ≥ 1.5× old` → **↗**
   - `new ≤ 0.67× old` → **↘**
   - else → **→**
   - no prior entry → no arrow
5. **Status thresholds** — projected utilisation of the quota window:
   - `< 50%` → **OK**
   - `50–79%` → **WATCH**
   - `≥ 80%` → **ACT** (this is the actionable line; 80% of a monthly quota on
     day 20 is fine, 80% on day 8 is not — weight by position in the window)
6. **Write and commit** — if anything changed, update the doc and commit as
   `chore(ops): resource-burn weekly run YYYY-MM-DD`.

## Reporting rules

- **Never report a bare number without its denominator.** "40K Redis commands
  per day" is not information; "40K/day against a 500K/month ceiling = 240% of
  budget" is.
- **Name the top consumer, always.** The fix is almost never "use less"; it is
  "stop *this specific call site* from being 91% of it".
- **Flag anything with no fallback.** Upstash took prod down because
  `RedisIdempotency` throws while the rate limiter fails open. A dependency at
  60% utilisation with no degraded path is more urgent than one at 85% that
  fails soft. Note the failure mode, not just the number.
- **Do not silently drop a dependency** because its query returned nothing.
  Zero spans might mean zero usage, or a wrong span signature, or an
  un-instrumented client. Write `no spans — signature unverified` and say so.

## Known blind spots

- **Pre-boot crashes never reach the SDK** — a container that dies before
  `Sentry.init` is invisible here. Only an external uptime probe catches that.
- **The OTel `TelemetryPort`** (`packages/ports/src/telemetry.ts`) exists with
  `startSpan`/`setAttribute` but is wired nowhere outside its own adapter and
  tests, and `initOpenTelemetry` no-ops without `OTEL_EXPORTER_OTLP_ENDPOINT`.
  So spans carry no `th.subsystem` attribute and attribution (step 2) is done
  by inferring from `transaction` names plus reading code. Wiring that port
  would make step 2 a direct group-by instead of detective work.
- **Non-span costs are not covered** — object storage bytes, Artifact Registry
  size, Cloud Run instance-hours. Those need billing-side queries, not Sentry.
