# Jobs (`apps/jobs` on Cloud Run)

Background work runs in one Fastify service, `hf-<env>-jobs` in `us-east4`. Every job, scheduled or not, runs through one route, `POST /jobs/<name>`, whoever calls it: Cloud Scheduler, a Pub/Sub trigger push, a Cloud Tasks task, the staff console, or the jobs service itself.

## Where each fact lives

| Fact | Source of truth |
| --- | --- |
| Job names, crons, timezones, Pub/Sub topics | `apps/jobs/jobs.manifest.json`: `scheduled` (has a cron), `queue` (no cron), `legacy_queue` (topics with no handler) |
| Handlers and input schemas | `defineScheduledTask` / `defineJob` (`apps/jobs/src/lib/define-job.ts`) in `apps/jobs/src/jobs/<module>.ts` |
| Module loading | `JOB_MODULE_LOADERS` in `apps/jobs/src/jobs/modules.ts`; a handler is imported on its first run, not at boot |
| Metadata the service serves without importing handlers | `apps/jobs/src/jobs/registry.generated.ts` (regenerate with `pnpm -C apps/jobs generate:registry`; `registry-drift.test.ts` catches a stale copy) |
| Scheduler jobs, topics, push subscriptions | `infra/terraform/generated-jobs.tf`, which reads the manifest |
| Per-env schedule changes | `jobs_scheduler_overrides` in `infra/terraform/envs/<env>/<env>.tfvars` |
| Cloud Tasks queues | `search-reindex.tf`, `lineup-notice-sweep.tf`, `tax-rate-fill.tf` in `infra/terraform/` |
| What is live, with last runs | `/platform/jobs` (staff), backed by `GET /jobs/status` |

## Adding or changing a job

1. Define it in a job module: `defineScheduledTask` for a cron job, `defineJob` for one that is only called. A new module also needs a `JOB_MODULE_LOADERS` entry.
2. Add the manifest entry: `scheduled` needs `description`, `cron` and `timezone`; `queue` needs `description` and `topic`.
3. Run `pnpm -C apps/jobs generate:registry`, then `pnpm -C apps/jobs validate:manifest`. The validator also runs in the pre-commit hook and as `deploy-prod.yml`'s `manifest_drift_guard`. Its header in `apps/jobs/src/scripts/validate-manifest.ts` lists every check, including the two pinned crons: `settlements.run-batch` (the payout cycle in `@th/core`) and `tickets.release-expired-carts` (the cart capacity window, which no env may override).
4. A manifest change makes the next `deploy-dev` push run Terraform, which creates or changes the scheduler job (`docs/deploy.md`).

To change a schedule in one env, add a `jobs_scheduler_overrides` entry for it and list that env in the manifest entry's `schedulerOverriddenIn`; the validator fails on an undeclared override. To stop a job, set `enabled = false` there (Terraform then removes its scheduler job), or pause it from `/platform/jobs` (a runtime flag held by the run tracker; the scheduler keeps firing and the run route answers `skipped`). Pausing the Cloud Scheduler job in the GCP console is reverted by the next apply.

## Schedules

No job runs more often than `*/30`. On 2026-10-08 (owner ruling, e5bf80173) all fourteen `*/15` crons moved to `*/30` and every daily job moved onto `:00` or `:30`, so jobs share wake-ups and prod Neon compute can sleep between them. The cart reaper's slower tick lengthens how long an abandoned cart holds seats; that window is derived in `@th/core` from the cron, which is why the validator pins it. Keep a new cron on those slots. Overrides today: prod slows `places.recalculate-place-stats`, `storage.drain-pending-deletions` and `push.drain-receipts`, and still overrides `events.address-reveal-notify` with `*/30`, the same cron the manifest now has; dev turns off `stripe-connect.reconcile-capabilities` (see `docs/deploy.md#runtime-config-and-env-vars` for why). Read the tfvars for the values.

Each scheduled entry with `enabled` not `false` becomes a Cloud Scheduler job named `hf-<env>-jobs-<name with dots as dashes>` (for example `hf-prod-jobs-search-full-reindex`). It POSTs the manifest's `payload` (default `{}`) to `/jobs/<name>` with an OIDC token from `hf<env>-jobs-sch@hearthfire-491918.iam.gserviceaccount.com`, and uses the manifest's `attemptDeadline` or the provider's 180s default. To run one now:

```bash
gcloud scheduler jobs run hf-prod-jobs-search-full-reindex --location us-east4 --project hearthfire-491918
```

or use **Run** on `/platform/jobs`, which calls the route with `?force=true` and so also runs a paused job.

## The run route

`POST /jobs/:name` (`apps/jobs/src/app.ts`). Every route except `/health` sits behind an `onRequest` hook that accepts `JOBS_API_KEY` (as `X-Jobs-API-Key` or `Authorization: Bearer`) or any bearer token shaped like a JWT, trusting Cloud Run IAM to have checked it. Terraform grants `roles/run.invoker` only to the scheduler SA, the Pub/Sub push SA (`hf<env>-jobs-psh`) and the API's runtime SA. With `JOBS_API_KEY` unset (local dev), the hook isn't installed and every route is open, so keep a local jobs service on `localhost`.

| Outcome | Status |
| --- | --- |
| Unknown job | 404 `job_not_found` |
| Confirmed, enforced migration drift | 503; nothing runs |
| A drain already in flight | 200 `{ success: true, coalesced: true }` |
| Paused job, no `?force=true` | 200 `{ skipped: true, reason: "disabled" }` |
| Handler returns | 200 `{ success: true, … }` |
| Body fails the job's input schema | 400 `invalid_input` with the issues; logged as `job_invalid_input` at `warn`, not sent to Sentry |
| A `ZodError` thrown by the handler's own work (an output schema, say) | The same 400 and warn line, plus `job_handler_schema_error` at `error` and a Sentry report |
| Job module fails to import (`JOB_MODULE_LOAD_FAILED`) | 503 with `Retry-After: 60`; Sentry once per module per process |
| Handler throws an error carrying a `code` (an `AppError`, and also Prisma's `P…` errors) | 400 with that code; logged as `job_error`, reported to Sentry |
| Handler throws anything else | 500 `internal_error`; logged as `job_failed`, reported to Sentry |

The last five rows are all failed runs, and they share one path (`apps/jobs/src/app.ts`, the run route's `catch`): each records an `error` run in the run history and pushes a jobs DLQ entry (a failed rerun of a DLQ entry updates that entry instead of pushing a second one), and for a job that sets `notify`, Discord gets the "started" alert sent before the try plus a "failed" alert. Cloud Scheduler retries a failed scheduled attempt (any non-2xx, or a missed attempt deadline) twice, 30s then 60s apart, so a tick makes at most 3 attempts before the job waits for its next tick. A retry can start while a timed-out first attempt is still running, so a job that is unsafe to run twice at once opts out with `"retry": false` in `apps/jobs/jobs.manifest.json` and says why in its `_comment`. Each failed attempt records its own `error` run, DLQ entry and alert (a missed attempt deadline counts as failed for Cloud Scheduler even if that run later records a success), so a DLQ entry may already be covered by a later attempt that succeeded: check the job's run history before rerunning it.

**Only a throw is a failure.** A handler that catches an error and returns a result answers 200, so Cloud Scheduler, Cloud Tasks and Pub/Sub all count the attempt as done and never retry it, and the run history shows a success. So a handler whose work failed rethrows after logging. A handler that skips because a dependency is not configured (no search backend, no mailer, no Stripe key) still answers 200 and records a `success` run, and reports the skip to Sentry once per process (`reportNotConfiguredOnce`, `apps/jobs/src/lib/report-not-configured.ts`). Failed runs and the DLQ: `docs/runbooks/jobs-dlq.md`.

The other routes are `GET /health` (no auth), `GET /jobs`, `GET /jobs/status`, `GET /jobs/:name/runs`, `PUT /jobs/:name/enabled`, `GET /moderation/config`, and the `/dlq/*` routes.

## Rules every handler follows

- **Finish inside 300s.** The jobs Cloud Run module sets no request timeout, so Cloud Run's 300s default applies (the drains' 300s `attemptDeadline` matches it). Longer work continues itself in another run: drains re-wake themselves, and the lineup sweep and search drain chain through Cloud Tasks.
- **Be safe to run twice.** Trigger push subscriptions and Cloud Tasks retry any non-2xx, a DLQ rerun repeats a run, and staff can press **Run** at any time.
- **Log through the job logger.** The route gives it `job` and a `runId`, and logs `job_start` / `job_complete`, and on failure `job_invalid_input`, `job_error` or `job_failed` (see the table above); the same `runId` is in the run history and the DLQ entry.

## Pub/Sub topics

`generated-jobs.tf` makes two kinds, both named `<env>-<topic>`, each with a push subscription `<env>-<topic>-push` that authenticates with the push SA:

- **Trigger topics** (`hf-trigger-*`, a `triggerTopic` in the manifest) push the message body verbatim (`no_wrapper`) to `/jobs/<name>`. Three are the write-triggered drains below; `hf-trigger-search-ensure-format` is published once per deploy by the deploy workflows (`docs/deploy.md#after-a-deploy-search-reindex`).
- **Queue topics** (the `topic` of every `queue` and `legacy_queue` entry, for example `prod-hf-index-event`) push to `/pubsub/push`. **The jobs service has no `/pubsub/push` route** (it went with `packages/jobs` in aa0ce64df), and no code publishes to these topics. They are leftovers: publishing to one runs nothing. `settlements.execute-transfer` is a handlerless entry (`noHandler: true`) kept only until its topic is retired.

Unrelated topics in the same project: `<env>-backup-events` (db-backup) and the audio transcode topic, which the audio-transcoder's own `/pubsub/push` serves.

## Cloud Tasks queues

Three queues in `us-east4`, each feeding one job. Tasks POST to `SEARCH_DRAIN_TARGET_URL/jobs/<name>` (the jobs service's public URL, not `JOBS_SELF_URL`) with an OIDC token from `CLOUD_TASKS_INVOKER_SA`. Terraform sets every queue variable; unset means that path is off.

| Queue | Job | Env var | Terraform |
| --- | --- | --- | --- |
| `hf-<env>-search-drain` | `search.drain-reindex-pending` | `CLOUD_TASKS_QUEUE` | `search-reindex.tf` |
| `hf-<env>-lineup-notice-sweep` | `lineup-notices.continue-sweep` | `CLOUD_TASKS_LINEUP_SWEEP_QUEUE` | `lineup-notice-sweep.tf` |
| `hf-<env>-tax-rate-fill` | `tax.fill-location-rate` | `CLOUD_TASKS_TAX_FILL_QUEUE` (no fallback queue) | `tax-rate-fill.tf` |

## Local dev and tests

```bash
pnpm -C apps/jobs dev            # port 3002 (PORT)
curl -X POST http://localhost:3002/jobs/sitemaps.generate \
  -H 'content-type: application/json' -d '{}'   # local only; 400: baseUrl is required
pnpm -C apps/jobs test           # unit + route tests (createApp() with app.inject())
pnpm typecheck:jobs
```

A body the job's schema rejects returns 400 with the issues and the handler never runs, so locally it is a cheap way to learn a job's input. It is still a failed run: it lands in the run history and the local jobs DLQ, and a `notify` job sends its Discord alerts if a webhook is configured. Don't probe a deployed env this way. A valid body runs the job against whatever database and Redis the local service points at.

## Write-triggered drains (2026-09-30)

Three outbox drains run when work is queued instead of polling:
`community.dispatch-rsvp-confirmations`, `events.dispatch-change-notifications`
and `moderation.drain-image-moderations` (`triggerTopic` in
`apps/jobs/jobs.manifest.json`).

- **Publish:** committing an outbox row publishes a wake-up to
  `<env>-<triggerTopic>` after the transaction commits
  (`packages/adapters/src/decorators/with-outbox-drain-triggers.ts`; the topic
  table is `DRAIN_TRIGGERS` in `packages/ports/src/job-trigger.ts`). Enabled by
  `JOB_TRIGGER_TOPIC_PREFIX`, which Terraform sets on the api and jobs services.
  A failed publish is reported to Sentry (`area: job-trigger`) and never fails
  the write.
- **Deliver:** the push subscription (`no_wrapper`, OIDC) POSTs the message
  body verbatim to `POST /jobs/<name>`, the same route Cloud Scheduler calls.
  The jobs app parses a body of any content type as JSON.
- **Safety net:** each drain keeps a `*/30` schedule with body
  `{"origin":"schedule"}` and a 300s attempt deadline (both required by
  `validate:manifest`). It is the only run that retries previously failed
  RSVP / event-change notices (wake-ups send `freshOnly: true`), and it never
  counts as a wake-up.
- **Local dev:** set `JOB_TRIGGER_BACKEND=http` on api (and jobs) to have
  writes POST the local jobs service directly. Unset, nothing wakes a drain.

**Runbook — after a Terraform apply that creates or changes these topics,**
publish one wake-up in dev and confirm the drain ran:

```bash
gcloud pubsub topics publish dev-hf-trigger-rsvp-confirmations \
  --project=hearthfire-491918 --message='{"freshOnly":true}'
```

then check the jobs service logs (Cloud Logging, service `hf-dev-jobs`) for
`job_start` followed by `job_complete` with
`job="community.dispatch-rsvp-confirmations"` within a minute. No `job_start`
means the push is not reaching the service (subscription, OIDC invoker, or a
415/4xx on delivery: see the subscription's delivery metrics).
