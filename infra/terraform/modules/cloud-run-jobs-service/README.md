# cloud-run-jobs-service

Terraform module that provisions the **Ithas Fire Jobs** Cloud Run service and its invocation identities.

## What it creates

- Cloud Run v2 service
- Dedicated runtime service account for the service (execution identity)
- IAM bindings granting `roles/run.invoker` to a set of invoker service accounts

**Ingress is `INGRESS_TRAFFIC_ALL`** (see the comment on the resource in `main.tf`): Cloud Run v2 does **not** classify same-project service-to-service traffic as internal unless Direct VPC Egress is configured, so `INGRESS_TRAFFIC_INTERNAL_ONLY` would block the API's `fetch()`. The service is still **not** publicly usable — there is no `allUsers` invoker binding, so access is gated by Cloud Run IAM (`roles/run.invoker` on specific service accounts, OIDC) **plus** `JOBS_API_KEY` in the Fastify auth hook.

## Inputs

- `project_id` (string)
- `region` (string)
- `environment` (string)
- `name_prefix` (string, optional — defaults to `hf-<environment>`)
- `service_name` (string, default `jobs`)
- `jobs_image` (string)
- `port` (number, default `3002` — **the root stack passes `8080`**, matching the container's `EXPOSE`)
- `env` (map(string), optional)
- `secret_env` (map(object({ secret, version })), optional — rendered as `value_source.secret_key_ref`)
- `s3` (object, optional, sensitive — S3/R2 config injected as env vars)
- `invoker_service_accounts` (map(string), optional — stable key → SA email)
- `labels` (map(string), optional)

### Startup probe

The service is probed over HTTP so a revision that reports unhealthy is never promoted — in particular, a revision whose `/health` reports confirmed migration drift never becomes Ready and never serves. Probing defaults to **on**; set `startup_probe_path = null` to disable.

- `startup_probe_path` (string, default `"/health"` — `null` disables the probe)
- `startup_probe_initial_delay` (number, default `0`)
- `startup_probe_period_seconds` (number, default `5`)
- `startup_probe_failure_threshold` (number, default `48`)
- `startup_probe_timeout_seconds` (number, default `3`)

Default budget is `48 × 5 = 240s`, which is both Cloud Run's documented maximum (`failure_threshold × period_seconds` cannot exceed 240s) and an exact match for the 240s the implicit default TCP probe allowed before this module declared a probe. See the comments in `variables.tf` before changing any of these — the three timing values are coupled.

> Note: this module's 240s budget is its own. `modules/cloud-run-service` (api/web) uses `30 × 5 = 150s`. Both are correct for their service; don't conflate the two numbers.

### Breaking a drift deadlock (incident only)

The probe is what makes the drift guard effective — and, when the database is genuinely wedged (`prisma migrate deploy` failing every run), what makes a deploy freeze total: a drifted revision never becomes Ready, so even an unrelated urgent hotfix cannot ship. Two escapes, both **incident tools, not config options**:

- `migration_drift_enforce = "false"` (root variable, `infra/terraform/variables.tf`) — sets `MIGRATION_DRIFT_ENFORCE` on the **api and jobs** services. Disables **enforcement only**: detection, logging and Sentry reporting continue, and the guard reports `migration_drift_enforcement_disabled` on every boot so a leftover flag can't hide. Revert to null (delete the line) once the migration is fixed.
- `startup_probe_path = null` (this module) — drops the jobs probe only, without weakening drift enforcement anywhere. Cheaper and narrower; prefer it when only the jobs roll is blocked.

## Outputs

- `service_url` (string)
- `service_name` (string)
- `runtime_service_account_email` (string)

## Invocation flow

- Cloud Scheduler: mints an OIDC token as a scheduler service account and POSTs to `${service_url}/jobs/<job-name>` (see `run_path` in `generated-jobs.tf`)
- Pub/Sub push subscription: mints an OIDC token as a push service account and POSTs to `${service_url}/pubsub/push`

This module only provisions the Cloud Run service; scheduler + pubsub are wired by the root `infra` stack.
