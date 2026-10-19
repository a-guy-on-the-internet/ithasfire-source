# Resource Burn

Living headroom report for metered dependencies. Maintained by
`[skill:resource-burn]` — **regenerated from Sentry every run**, so hand-edits
that disagree with telemetry get corrected on the next pass. Git holds the
history; there is no separate stats store.

Sibling to `error-log.md`: that tracks what is *throwing*, this tracks what is
being *consumed*.

**Last run:** 2026-08-19 · **Window:** 7d · **Env:** `production`
**Next scheduled:** NOT SCHEDULED — see "Scheduling" below. Run it by hand.

---

## Status

| Dependency | Ceiling | Observed (7d) | Projected | Util | Status | Trend | Method |
|---|---|---|---|---|---|---|---|
| Upstash Redis | 500K cmd/month | 24,020 cmd (3,431/day) | ~103K/month | **~21%** | **OK** | → | measured, multiplier ≈1 |
| Neon Postgres | compute-hours, **still unconfirmed** | 555,530 queries (79,361/day) | — | unknown | **WATCH** | ↗ **+31%** | measured count, no ceiling |
| Cloud Run | request + CPU-time | 31,230 txns (4,461/day) | — | unknown | unknown | ↘ | measured count, no ceiling |
| Resend | plan send limit | **no spans** | — | unknown | unverified | — | signature unverified |
| Expo Push | soft / unauthenticated tier | **no spans** | — | unknown | unverified | — | signature unverified |
| ZipTax | per-lookup billing | **no spans** | — | unknown | unverified | — | signature unverified |

### Since the 2026-07-30 baseline

- **Redis fix is holding, now over a 7-day window rather than one hour.** The
  `JobRunTracker` signature (`zadd`/`multi`/`exec`/`zremrangebyrank`/`hget`) is
  still completely absent. Only `redis-eval` (tRPC rate limiter, 23,900) plus
  60 `get` / 60 `set` remain.
- **The cron retune held.** `POST /jobs/:name` is 11,740/7d = **1,677/day**
  against the ~1,635/day the 2026-07-30 override targeted. That match also
  re-confirms the sampling multiplier is still ≈1 — see the known-rate trick in
  the skill.
- **Neon is up 31%** (60,620 → 79,361 queries/day) and queries-per-transaction
  rose from ~11 to **~17.8**. Some of that is this document's own doing (job-run
  history and idempotency moved here off Redis); the rest is new venue-hierarchy
  work. Its ceiling is STILL unestablished, three weeks after being flagged.

The last three returned zero spans. That may mean zero usage at current traffic,
or a wrong span signature, or an un-instrumented client — **it does not mean
OK.** Only one outbound `http.client` span exists in the whole 24h window
(`GET /api/auth/get-session`, count 10), which suggests these clients are not
emitting spans at all rather than merely being idle. Resolve before trusting.

### Transaction mix (7d)

| Transaction | Count | Share |
|---|---|---|
| `GET /trpc/:path` | 18,990 | 61% |
| `POST /jobs/:name` | 11,740 | 38% |
| `GET /api/auth/*` | 250 | <1% |
| everything else | 250 | <1% |

**The mix inverted since 2026-07-30.** Jobs were 61% of production transactions
then and tRPC 38%; it is now the other way round. Both moved: the cron retune
cut job runs, and real tRPC traffic roughly tripled in absolute terms. Cost
questions here are no longer automatically jobs questions.

---

## Scheduling — THIS REPORT IS NOT SCHEDULED

The skill and the original version of this file both said "weekly, Monday, via
the scheduled automation". **No such automation was ever created.** Between
2026-07-30 and 2026-08-19 this report ran zero times; the header simply went
stale while claiming a cadence.

Wiring one is not currently useful either. The two launchd agents that DO exist
(`com.ithasfire.curation.{open-mic-scout,stale-event-sweep}`) have failed every
Monday since 2026-08-03:

| run | outcome |
|---|---|
| Jul 13 / 20 / 27 | exit 0, artifacts written to `docs/curation/` |
| Aug 3 | `You've hit your monthly spend limit` |
| Aug 10 | `401 OAuth access token has expired` |
| Aug 17 | `You've hit your monthly spend limit` |

launchd fires, `run.sh` logs the failure, and nothing reads the log — so the
scheduled ops have been dead for three weeks with no signal anywhere. (Jul 6
failed the same way, so this predates the gap too.) A third agent added to that
mechanism would fail just as quietly.

**Order that actually helps:** fix auth/spend so a scheduled run can complete →
add a failure signal (Discord alert on non-zero exit from `run.sh`) so a dead
agent is visible without reading logs → only then schedule this report.

Until that happens, run it by hand and update the header honestly.

---

## Sampling multiplier — RESOLVED (2026-07-30)

The Upstash post-mortem could not tell whether observed counts were true or 10%
samples, and hedged across a 10× band. Resolved empirically:

`POST /jobs/:name` shows **3,380 transactions/24h**. The pre-retune cron
schedule produces **~3,591 runs/day**, and cron is a hard ceiling — it cannot
physically fire 33,800 times. Observed ≈ actual, so:

> **Multiplier ≈ 1. Treat observed span counts as true counts.**

Do not silently assume this forever — re-verify with the same known-rate trick
(compare `POST /jobs/:name` against the manifest's cron schedule) whenever
`tracesSampleRate` changes or the numbers stop making sense. The reference
schedule is now **~1,635 runs/day** post-retune, not 3,591.

Ratios between spans inside one transaction are exact regardless of sampling and
never need correction.

---

## RB-0001 · Upstash Redis — quota exhausted 2026-07-28 · **RESOLVED**

**Ceiling:** 500,000 commands/month (free tier; prod provisioned out-of-band,
`enable_upstash=false`)

### What happened

Quota hit 500000/500000. User-visible symptom was `events.createEventForHuman`
returning 500 — `RedisIdempotency` **does not fail open**, so the `ReplyError`
propagates through `toTrpcError`. The tRPC rate limiter *does* fail open, which
is why the rest of the API stayed up. 1,210 events in ~8h.

### Attribution (pre-fix, 24h)

| Span | Count | Source |
|---|---|---|
| `multi`+`zadd`+`zremrangebyrank`+`exec` | 8,410 each = 33,640 | `JobRunTracker.record()` |
| `hget` | 7,080 | `JobRunTracker.isEnabled()` |
| `eval` | 4,050 | tRPC rate limiter |
| `get`/`set` | 60 | better-auth RL + idempotency |

**Job-run bookkeeping was 90.6% of all Redis commands** — 5 per run (one `HGET`
plus a 4-command `MULTI/ZADD/ZREMRANGEBYRANK/EXEC`). ~45K commands/day ≈ 1.35M/month
against a 500K ceiling.

The loudest consumer and the *breaking* consumer were different things: `eval`
(rate limiter) was ~9%, and idempotency — the path that actually took prod down —
was ~0.1%. **Attribution mattered more than volume.**

### Fix (`43e1c91c`, prod 2026-07-30)

- `JOB_TRACKER_BACKEND=postgres` → `PostgresJobRunTracker`
- `IDEMPOTENCY_BACKEND=postgres` → `PrismaIdempotencyAdapter` (removes the
  no-fallback failure mode)
- `jobs_scheduler_overrides` — 9 crons retuned, 3,591 → 1,635 runs/day (−54%)

Both Postgres backends already existed behind env flags nothing set. The fix was
configuration, not code.

### Verified post-deploy (1h window)

Every job-tracker span is **gone** — `zadd`/`multi`/`exec`/`zremrangebyrank`/`hget`
all at zero. Only `redis-eval` (rate limiter) remains, at 150/hour →
**~3,600/day → ~108K/month → ~22% of ceiling.**

### Open follow-ups

- [ ] **Expired idempotency rows are never deleted.** Redis expired keys for
      free; Postgres will not. Reads honour `expiresAt` so correctness holds,
      but the table grows unbounded and `resultJson` caches full success
      payloads. Fold a purge into an existing daily job
      (`support.purge-resolved-threads`, `events.purge-dispatched-change-notices`)
      rather than adding a 33rd cron.
- [ ] Confirm Resend / Expo / ZipTax span signatures — currently unverified.
- [ ] Establish the Neon ceiling so RB-0002 can have a real utilisation figure.

---

## RB-0003 · Upstash Redis — public-read generation (PROJECTED, 2026-09-30, not yet measured)

Added by the in-process cache of anonymous home-page reads (`PUBLIC_DISCOVERY_*`,
`PLATFORM_SETTINGS_*` in `apps/api/src/lib/env.ts`), whose cross-instance invalidation is one
Redis counter, `cache:public-reads:generation`. The Upstash database is **shared
by dev and prod** (same 500K/month ceiling), so both count. Every command below
is a single `EVAL` (read-or-seed / seed-or-INCR). Hand-written projection — the
next `[skill:resource-burn]` run should replace it with the measured `eval`
share.

| Source | Rate | Per API instance / day |
|---|---|---|
| Discovery cache generation read | ≤ 1 per `PUBLIC_DISCOVERY_GENERATION_MEMO_S` (30s), only when an anonymous `countryEvents`/`featuredEvents`/`categories.listBrowsable`/`categories.list` is served | uptime check alone (~1 render / 50s, so every render reads): **~1,730**; ceiling **2,880** |
| Settings snapshot generation read | ≤ 1 per `PLATFORM_SETTINGS_GENERATION_MEMO_S` (60s), on any feature-gate read (authed too) | ceiling **1,440** (reached whenever there is ≥1 request/minute, which the uptime check guarantees) |
| INCR — actor mutations | 1 per mutation by a resolved actor (failed ones too), coalesced | ≈ mutation volume: POST `/trpc` is inside "everything else" (~250/7d) in the mix above → **< 100** |
| INCR — search index writes | 1 per committed index write, API post-commit reindex + jobs drains / price flips / nightly full reindex; bursts coalesce to ≤ 2 INCRs per in-flight round-trip | **~100–300** |
| INCR — e2e reset/seed | dev only | varies with CI runs |

**Prod, today (one warm instance, uptime-driven):** ~1,730 + 1,440 + ~400 ≈
**3,600/day ≈ 108K/month**. With the ~103K/month baseline: **~211K/month ≈ 42%**.
**Dev** (no uptime check; reads only while someone browses): typically a few
thousand/month.

**Worst case:** an instance serving anonymous home-page traffic continuously
for a whole month hits both read ceilings: 2,880 + 1,440 = 4,320/day ≈
**130K/month**, plus its INCRs. One such instance plus the baseline is ~233K
(47%); **two (prod scaled to 2, or prod + dev both saturated) is ~363K (73%)**;
three would be ~493K — at the ceiling. Knobs, in order: raise
`PUBLIC_DISCOVERY_GENERATION_MEMO_S` (cross-instance staleness after a write
rises with it), raise `PLATFORM_SETTINGS_GENERATION_MEMO_S`, or give dev its
own Redis. (The default was 10s until the 2026-09-30 review; at 10s the
two-instance worst case was ~710K, over the ceiling.)

**Failure mode if the quota is hit anyway:** generation reads fail → both caches
read fresh and store nothing (reported, throttled to one Sentry event per 15
min per op). That is the pre-cache behaviour: Neon stays awake, nothing breaks.
Note the rate limiter shares the quota and fails open.

---

## RB-0002 · Neon Postgres — WATCH (load shifted here by RB-0001)

**Observed (2026-08-19):** 555,530 `span.op:db` queries over 7d = **79,361/day**,
**~17.8 queries per transaction**.
**Ceiling:** compute-hours, plan STILL not confirmed. **Read it from the Neon
console.** This has been the open question for three weeks.

**Trend since 2026-07-30: +31% on volume (60,620 → 79,361/day) and +62% on
queries-per-transaction (~11 → ~17.8).** The per-transaction rise is the part
worth watching: total traffic growing is expected, each request costing 60% more
database work is a different thing, and some of it is this document's own fix
moving job-run history and idempotency onto Postgres. The rest tracks the
venue-hierarchy work landing over the same window.

Flagged deliberately: **the RB-0001 fix moved load onto this dependency.** Job-run
history and idempotency now write to Postgres instead of Redis. That is the
right trade — Postgres has headroom Redis did not, and idempotency gains a path
that doesn't hard-fail — but it is a trade, not a free win.

Neon is also the dependency that **already caused a 4-day silent outage in June
2026** via compute quota, where caught errors never reached Sentry. Moving more
traffic onto it without establishing its ceiling would repeat the exact mistake
this document exists to prevent.

Until the ceiling is known this row stays **WATCH**, not OK.

---

## How to read this file

- **Util** is projected consumption over the quota window, not consumption so
  far. 80% on day 20 of a monthly window is fine; 80% on day 8 is not.
- **Status** is `OK` < 50%, `WATCH` 50–79%, `ACT` ≥ 80% — escalated one level for
  any dependency with **no degraded path**. A hard-failing dependency at 60%
  outranks a soft-failing one at 85%.
- **Method** records how the number was obtained. A number with no provenance is
  not evidence.
- **`unknown` / `unverified` ≠ `OK`.** An unqueried dependency is an open
  question, and a dependency with no measured ceiling cannot have a utilisation.
