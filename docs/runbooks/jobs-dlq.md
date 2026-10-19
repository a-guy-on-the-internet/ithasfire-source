# Jobs DLQ ops

How to inspect, rerun and clear failed runs of `apps/jobs`, and how the separate
Stripe webhook DLQ differs. Both DLQs live in Redis. Neither is a Cloud Tasks
queue.

## How a run reaches the DLQ

When `POST /jobs/:name` fails, `apps/jobs/src/app.ts` pushes one entry onto the
Redis DLQ (`RedisJobDiagnosticsAdapter`,
`packages/adapters/src/job-diagnostics/redis-dlq-adapter.ts`, wired in
`apps/jobs/src/lib/container.ts`):

- The **queue is the job name** from the manifest (for example
  `tickets.release-expired-carts`). Each job has one sorted set,
  `th:jobs:dlq:<job name>`, under the global `REDIS_NAMESPACE` prefix (see
  below), scored by failure time.
- An entry holds `ref: { queue, id }` where `id` is the failed run's `runId`,
  plus `failedAt`, the original request body as `payload`, and the error
  message and code.
- Each queue keeps the newest 500 entries; older ones are pruned on push. There
  is no TTL.
- A failed push is logged as `dlq_push_failed` and reported to Sentry
  (`area: job-dlq`); the run's own failure is still returned.
- A failed **rerun** of an entry does not push a second one. It updates the
  entry it came from (see "Rerun semantics").

Nothing needs configuring: `buildContainer()` always builds the adapter on the
container's Redis client (`REDIS_URL`, boot-required in production; locally it
falls back to a local Redis). The jobs app reads no DLQ env vars. This
adapter is what production runs; there is no other DLQ adapter.

## Operator surface

Use the staff console: **`/platform/jobs`**, expand a job's row, open its DLQ
panel. It calls `platformJobs.peekDlq`, `rerunDlqItem`, `deleteDlqItem` and
`purgeDlq` (`packages/transport/trpc/src/routers/platform-jobs.ts`), which
require a staff role (`ADMIN`, `REVIEWER`, `SUPPORT` or `DEVELOPER`) and proxy
to the jobs service with `X-Jobs-API-Key` plus an OIDC token for Cloud Run IAM.

The jobs service routes behind that proxy (all behind the `JOBS_API_KEY` /
OIDC `onRequest` hook in `app.ts`):

| Route | Does |
| --- | --- |
| `GET /dlq/:queue?max=N` | Newest first; default 25, capped at 500 (the console asks for 50) |
| `GET /dlq/:queue/:jobId` | One entry, 404 if absent. Not exposed in the console. |
| `DELETE /dlq/:queue/:jobId` | Remove one entry |
| `DELETE /dlq/:queue` | Purge the whole queue; returns `{ purged }` |
| `POST /dlq/:queue/:jobId/rerun` | Rerun with the stored payload, or `payloadOverride` from the body (the console never sends one). 200 only when the job ran; 409 when the entry was kept; 404 if the entry is absent. |

All of them return `501 dlq_not_configured` only when the container has no
adapter, which the current wiring never produces.

### Rerun semantics

A rerun is synchronous. The jobs service POSTs the payload to
`${JOBS_SELF_URL ?? http://localhost:$PORT}/jobs/<queue>` with
`Authorization: Bearer $JOBS_API_KEY` and an `X-Dlq-Rerun-Of: <entry id>`
header, and waits for the job to finish (`apps/jobs/src/lib/dlq-rerun.ts`).
Terraform never sets `JOBS_SELF_URL`, so in Cloud Run the rerun runs on the same
instance over loopback, outside Cloud Run IAM. Expect the console call to take
as long as the job.

**The entry is removed only when the run route confirms the job ran.** The run
route answers 200 for work it never did (a paused job, a coalesced wake-up), so
a 2xx alone is not taken as a run. Every other outcome keeps the entry, and the
console shows which one happened in the DLQ panel.

| What happened | Rerun route answers | The entry |
| --- | --- | --- |
| The job ran | 200 `{ outcome: "ran", runId, entryDeleted: true }` | Deleted. `runId` is the new run's id; find it in the job's run history. |
| The job ran, but removing the entry failed (Redis error) | 200 `{ outcome: "ran", runId, entryDeleted: false }` | Still listed. Delete it by hand. Rerunning it would run the job a second time. Reported to Sentry (`area: job-dlq`, `phase: rerun-delete`). |
| The job is disabled | 409 `job_paused` (`outcome: "not_run"`, `reason: "disabled"`) | Kept, unchanged. Nothing ran. |
| A rerun of this entry started in the last 330s and has not answered (someone else's, or your own that broke off) | 409 `rerun_in_progress` (`reason: "claimed"`) | Kept, unchanged. Nothing ran. |
| A drain of this job was in flight and took the wake-up into its next pass | 409 `run_in_flight` (`reason: "coalesced"`) | Kept, unchanged. |
| A 2xx the jobs service cannot read as a finished run | 409 `run_unconfirmed` (`reason: "unconfirmed"`) | Kept, unchanged. |
| The run failed (400, 500, or 503 for a module that would not load) | 409 `rerun_failed` with `runId`, `status` and `runError` | Kept and updated: same id, `attempt` + 1, the new error and `failedAt`. `metadata.firstFailedAt` keeps the first failure time and `metadata.lastRunId` names the rerun. |
| The handler returned `{ success: false }` (a computed flag, e.g. the multi-document search jobs) | 409 `rerun_failed` with `status: 200` | Kept, unchanged. The run route answered 200, so the run history shows a success; the handler's message is in `runError`. |
| The handler returned `{ skipped: true }` | 409 `run_unconfirmed` | Kept, unchanged. |
| The run never started (migration drift 503, unknown job 404, 401) | 409 `rerun_failed` with `runId: null` | Kept, unchanged. Reported to Sentry (`phase: rerun-refused`), except the 404 and the drift 503. |
| No entry with that id | 404 `not_found` | Nothing to change. |

- **A rerun never forces a disabled job.** Enable the job on `/platform/jobs`,
  then rerun the entry. **Run** on the job row does send `?force=true`, but it
  runs the job with an empty body, not with the entry's payload, and it leaves
  the entry where it is.
- After `run_in_flight`, wait for the running drain to finish, check its run
  history, then delete the entry or rerun it.
- A failed rerun is still a failed run: it is in the run history and reported
  like any other. It leaves one DLQ entry, the original, now showing the latest
  error and an attempt count above 1. If someone deleted the entry while the
  rerun was running, the failure is pushed as a new entry, so a failed run
  always has one.
- With `payloadOverride`, a failed rerun still keeps the entry's original
  payload; only the error comes from the override run.
- **One rerun of an entry at a time.** The rerun route takes a claim in Redis
  (`th:jobs:dlq-rerun-claim:<queue>:<entry id>`, a random token, 330s expiry:
  longer than Cloud Run's 300s request cap) before it reads the entry. A second
  rerun of the same entry while the claim is held answers `rerun_in_progress`.
  The claim is released when the rerun answers. If the call to the run route
  breaks off (in production the call is loopback and Node gives up on headers
  after 300s), or a gateway answers for it when `JOBS_SELF_URL` points through
  one (a 5xx that is not the jobs app's own JSON, such as Cloud Run's 504), the
  claim is kept, because
  that run may still be going, and the console shows an error. The claim
  expires on its own within 330s; until then the entry answers
  `rerun_in_progress`. The 300s cap ends the request, not the run, so a run
  longer than 330s can outlive its claim.
- The rerun sends its claim token as `X-Dlq-Rerun-Claim`. The run route rewrites
  the entry in place only when that token is the entry's live claim. A request
  that carries `X-Dlq-Rerun-Of` without it is treated as an ordinary failed run
  and pushes its own entry.
- If the console call itself errors (jobs service unreachable, request cut
  off), the entry is untouched and the run may still be in progress. Check the
  job's run history before rerunning.

## Redis key namespace (read before changing `REDIS_NAMESPACE`)

Both Redis-backed DLQs — `th:jobs:dlq:*` here and `webhook_dlq:*` below — are
addressed by logical key names that ioredis rewrites with a global `keyPrefix`.
Since 2026-09-14 that prefix is set from `REDIS_NAMESPACE`, which Terraform
emits as `ithasfire:<env>` for api, jobs and the audio transcoder.

The prefix exists because dev and prod share one out-of-band Upstash database
and every key in the codebase was environment-agnostic, so a dev load test
could consume prod's rate-limit budget.

**The cutover is one-way and silent.** The first revision that runs with
`REDIS_NAMESPACE` set reads `ithasfire:<env>:webhook_dlq:index`, not
`webhook_dlq:index`. Entries written before that revision are still in Redis
but are no longer addressable by the code that owns them — `/platform/webhook-dlq`
and the jobs DLQ tab will both render an empty list. An empty list after the
cutover means "nothing in the new namespace", NOT "nothing to replay".

### Pre-flight before a prefix change

> **Status 2026-09-15: satisfied.** Both prod queues were confirmed empty before
> the namespace change shipped, so nothing was orphaned at cutover and the prod
> deploy is not blocked on this. The steps below are kept because they are what
> you run if the prefix is ever changed again.


Drain both queues to empty, or accept that whatever is left becomes
unreachable:

1. `/platform/webhook-dlq` — replay or remove every entry. These are raw
   unprocessed Stripe events with a 30-day TTL, and replay is the only
   recovery path for them. This is the higher-stakes queue: an unreplayed
   `charge.dispute.created` is a dispute that never gets recorded.
2. The jobs DLQ — peek each queue and rerun or clear it.

If a queue cannot be drained in time, rename its keys rather than losing them:
`webhook_dlq:*` and `th:jobs:dlq:*` → `ithasfire:prod:<same name>`.

Dev's equivalents (`idem:api:*`, `idem:jobs:*`, `th:jobs:runs:*`,
`th:jobs:enabled`) also reset at cutover. That is harmless with one exception:
a missing `th:jobs:enabled` field reads as *enabled*, so any job disabled from
the console in dev silently re-enables.

During the rollout window, old (unprefixed) and new (prefixed) revisions both
serve traffic, so `rl:*` and `bauth:rl:*` counters are split across two
keyspaces and callers get roughly twice the configured cap until the shift
completes. Self-healing, and still an improvement on dev and prod sharing one
counter.

### Symptom: 5xx or crash-looping instances with no new deploy

Since 2026-09-14 `api` and `jobs` refuse to boot in production when `REDIS_URL`
is missing, unparseable, or points at a loopback host. That is deliberate — the
alternative is what happened on 2026-09-01, when dev silently ran eleven days
against `redis://127.0.0.1:6379` with every job failing.

The failure mode to recognise: overwriting the `REDIS_URL` secret does not
deploy a revision, so nothing "fails to deploy". Instances already running keep
serving; only instances that start *after* the write resolve `latest`, throw in
`buildDeps()` / `buildContainer()`, and die. The service therefore degrades on
scale-up rather than at one visible moment.

If api or jobs starts 5xx-ing and no revision was deployed, check the secret
value itself — not just that the env var is wired. The value holds the Upstash
password, so mask it before it reaches a terminal log or a transcript:

```bash
gcloud secrets versions access latest --secret=hf-<env>-redis-url --project hearthfire-491918 \
  | sed -E 's#//[^@]*@#//***@#'
```

The boot exception names the offending host and never includes the password.

Note the same applies to any environment where `var.redis_url` is empty:
`REDIS_URL` is then dropped from `app_secret_keys` entirely, and jobs — which
previously booted fine on Postgres backends — now throws
`REDIS_URL is required in production`.

## Stripe webhook DLQ (a different queue)

Stripe webhook deliveries that fail do **not** go to the jobs DLQ. They go to a
separate Redis DLQ in the API (`apps/api/src/lib/webhook-dlq.ts`: keys
`webhook_dlq:index` and `webhook_dlq:event:<id>`, 30-day TTL) with its own admin
surface at `/platform/webhook-dlq` (`platform.listWebhookDlq` /
`replayWebhookDlqItem` / `removeWebhookDlqItem`). The jobs service's `/dlq/*`
routes and the `/platform/jobs` panel never see it.

Replay re-drives the stored event through the real dispatch, so it cannot drift
from the live path. It removes the row only on success; a failed replay leaves
the row with its new error.

### Known entries

#### `resale_listing_not_sellable` / `resale_listing_commit_mismatch`

**Event type:** `payment_intent.succeeded`.

**What happened.** The event this resale ticket belongs to was cancelled while
the buyer's resale purchase was mid-finalize. `cancelEvent` cancels every OPEN
(`ACTIVE` | `HELD`) resale listing for the event inside its main transaction,
taking the listing row locks first, so `resaleListings.commit` (`HELD` → `SOLD`)
either finds the listing already `CANCELLED` (`resale_listing_not_sellable`) or
flips zero rows at the status-conditional CAS (`resale_listing_commit_mismatch`).
The finalize transaction aborts, the order stays `PENDING`, and the delivery
lands here.

**Do NOT replay.** The listing is `CANCELLED` and there is no path back to
`SOLD`; a replay throws the same error every time. The ticket cannot be minted
for this buyer because the show is not happening.

**Expected automatic resolution.** `cancelEvent` settles these orders in a
follow-up phase after its transaction commits
(`packages/core/src/use-cases/events/_shared/settle-stranded-resale-orders.ts`).
Look the order up on the orders desk:

- **`REFUNDED`** — the buyer had paid, and the charge was refunded in full.
  Nothing to do. Delete the DLQ row.
- **`CANCELLED`** — the PaymentIntent was proven dead, so nobody was charged.
  Nothing to do. Delete the DLQ row.
- **`PENDING`** — the phase did not reach it, or refused it. Act; see below.

**If the order is still `PENDING`.** The buyer may be out of pocket. Causes, in
order of likelihood: the PaymentIntent was still `processing` when the cancel
ran, Stripe was unreachable, the refund itself failed, or the process died
mid-phase. All of them are reported to Sentry — filter
`useCase:cancelEvent` with `step:settleStrandedResaleOrders*` — and counted in
the cancellation's `strandedPendingResaleOrderCount`.

1. Read the PaymentIntent. If it never succeeded, leave it: the expired-cart
   reaper (`tickets.release-expired-carts`) cancels the order and releases its holds on
   its next pass.
2. If it succeeded, refund it in full and mark the order `REFUNDED`. There is no
   ledger entry to unwind — finalize never ran, so no `SETTLEMENT_CREDIT`, no
   split and no transfer exists for this order.
3. Delete the DLQ row once the order is settled.

## Security notes

- Purge and delete are irreversible: there is no undo, and the console's purge
  confirm dialog is the only guard. Peek first and copy out any payload you may
  need.
- Reach the jobs `/dlq/*` routes through the console. Calling them directly
  takes an OIDC token for an identity with `roles/run.invoker` on the jobs
  service; the app's hook lets any JWT-shaped bearer through (`apps/jobs/src/app.ts`,
  "Path 2"), so `JOBS_API_KEY` is an alternative, not a second factor. Any
  identity that can mint that token can purge a DLQ. Terraform grants the role
  only to the scheduler and Pub/Sub push service accounts and the API's runtime
  service account (`invoker_service_accounts` in `infra/terraform/main.tf`).
- Stored payloads are job request bodies and can carry business context; avoid
  logging them.
