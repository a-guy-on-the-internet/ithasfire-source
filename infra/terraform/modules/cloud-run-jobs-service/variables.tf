variable "project_id" {
  type        = string
  description = "GCP project id."
}

variable "region" {
  type        = string
  description = "GCP region for the Cloud Run service."
}

variable "environment" {
  type        = string
  description = "Environment name (dev/stage/prod). Used for naming/labels."
}

variable "service_name" {
  type        = string
  description = "Base name for the Cloud Run service (without environment prefix)."
  default     = "jobs"
}

variable "name_prefix" {
  type        = string
  description = "Optional name prefix (e.g. 'th-dev'). If null, defaults to 'th-<environment>'."
  default     = null
}

variable "jobs_image" {
  type        = string
  description = "Container image ref (e.g. gcr.io/<project>/<image>:<tag> or artifact registry)."
}

variable "memory" {
  description = <<-EOT
    Memory limit (e.g. "1Gi"). Null leaves it to Cloud Run's default, which is
    512Mi — and 512Mi is NOT enough to run this container with the Sentry SDK
    loaded. Verified 2026-09-05 in prod: enabling SENTRY_DSN made every startup
    die with "FATAL ERROR: Reached heap limit Allocation failed - JavaScript
    heap out of memory" at ~247MB heap, exit(134), so the revision never passed
    its startup probe. Prod runs 1Gi (see envs/prod/prod.tfvars); the API module
    has been on 1Gi with Sentry for months.
  EOT
  type        = string
  default     = null
}

variable "cpu" {
  description = "CPU limit (e.g. '1'). Null leaves it to Cloud Run's default."
  type        = string
  default     = null
}

variable "port" {
  type        = number
  description = "Container port the service listens on."
  default     = 3002
}

variable "startup_probe_path" {
  description = "HTTP path for the startup probe (e.g. '/health'). Set to null to disable the startup probe."
  type        = string
  # Defaults ON, unlike the generic modules/cloud-run-service (which defaults to
  # null and makes each caller opt in). That module is instantiated for api, web
  # and meilisearch — three services with different health paths — so the path
  # belongs at the call site. THIS module builds exactly one thing, the jobs
  # service, and has exactly one caller (module "jobs_service" in main.tf), whose
  # health path is always /health. Defaulting to null here would mean the probe
  # ships disabled unless someone remembers to opt in — the same "capability
  # exists but is inert" failure that let drifted jobs revisions get promoted in
  # the first place. Set to null to explicitly disable; no caller has to change
  # to GET the probe.
  default = "/health"
}

variable "startup_probe_initial_delay" {
  description = "Seconds to wait before sending the first startup probe."
  type        = number
  # 0, matching api/web. The container does not listen until buildContainer()
  # finishes, so early probes just fail fast against a closed port and cost one
  # attempt out of the budget below — delaying only wastes wall-clock on the
  # happy path.
  default = 0
}

variable "startup_probe_period_seconds" {
  description = "How often (in seconds) to perform the startup probe."
  type        = number
  # Paired with startup_probe_failure_threshold to spend the full 240s Cloud Run
  # allows (5 × 48). Changing this without adjusting the threshold either wastes
  # startup budget or breaches the documented 240s cap — see that variable.
  default = 5
}

variable "startup_probe_failure_threshold" {
  description = "Number of consecutive failures before the container is considered failed."
  type        = number
  # Default budget: 48 × period_seconds (5) = 240s, with a 3s timeout per probe.
  #
  # 48, NOT the 30 that modules/cloud-run-service uses, because adding a probe to
  # this module NARROWS the startup budget unless we compensate. With no probe
  # declared (this module's state until now) Cloud Run applies a DEFAULT TCP
  # startup probe of timeoutSeconds=240, periodSeconds=240, failureThreshold=1 —
  # i.e. jobs already had a single 240s window to open its port. Copying
  # cloud-run-service's 30 would have cut that to 150s AND raised the bar from
  # "accepts a TCP connection" to "returns HTTP 2xx from /health": a ~90s
  # reduction on the cold-image + cold-Neon path, where a failed roll leaves the
  # OLD image serving. 48 × 5 = 240s restores the prior budget exactly.
  #
  # 240s is also the CEILING, not just a choice: Cloud Run documents that
  # failure_threshold × period_seconds "cannot exceed 240 seconds" (see
  # https://cloud.google.com/run/docs/configuring/healthchecks). So with
  # period_seconds = 5 this is the maximum permitted value — raising it further
  # requires lowering the period, and there is no configuration that buys a
  # longer startup budget than what we now have.
  #
  # The budget must cover the WHOLE boot, not just the probe: apps/jobs does not
  # call app.listen() until createApp() → buildContainer() has finished, and that
  # awaits prisma.$connect() (a real Neon connection, which cold-starts from
  # scale-to-zero), constructs the Redis client, and dynamically imports the
  # Stripe / S3 / Meilisearch / SNS adapters, then pre-warms the pg pool
  # (apps/jobs/src/lib/warm-pool.ts: at most two rounds of a 10s connect plus a
  # 5s SELECT 1, ~30s worst case, inside the 240s). Every probe before the port
  # opens burns one of the 48 attempts.
  #
  # PROVENANCE OF THE MARGIN — the "~45s cold boot" figure quoted in
  # modules/cloud-run-service/variables.tf describes the API, not jobs, and that
  # comment records neither the environment nor whether Neon was warm. Treat it
  # as an UNVERIFIED ESTIMATE for sizing purposes: nobody has measured a jobs
  # cold boot against a cold Neon. That uncertainty is the reason to take the
  # documented maximum rather than a tighter "should be plenty" number. If jobs
  # revisions ever fail this probe on timing alone, the fix is NOT to raise this
  # value (it cannot go higher) — it is to cut boot work before app.listen().
  default = 48
}

variable "startup_probe_timeout_seconds" {
  description = "Number of seconds after which the probe times out."
  type        = number
  # 3s is generous because the probe is O(1): the drift verdict is computed ONCE
  # during boot and remembered, so /health never re-queries the database (see
  # apps/api/src/routes/health.ts, the same contract the jobs guard follows).
  # A slow or cold database therefore lengthens BOOT, which the failure_threshold
  # budget absorbs — it cannot make an individual probe time out and flap.
  #
  # NOTE: Cloud Run requires timeout_seconds <= period_seconds. Raising this
  # above 5 therefore requires raising period_seconds — which in turn requires
  # lowering startup_probe_failure_threshold to stay inside the 240s cap, i.e.
  # it buys probe patience by spending startup budget. Don't trade blind.
  default = 3
}

variable "env" {
  description = "Extra environment variables to pass to the container (non-secret)."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Map of env var name → Secret Manager reference. Rendered as value_source.secret_key_ref on the container."
  type = map(object({
    secret  = string
    version = optional(string, "latest")
  }))
  default = {}
}

variable "s3" {
  description = "Optional S3-compatible storage configuration to inject as env vars (Cloudflare R2, MinIO, AWS S3, etc.). Secrets should come from Secret Manager later."
  type = object({
    bucket            = optional(string)
    endpoint          = optional(string)
    access_key_id     = optional(string)
    secret_access_key = optional(string)
    public_base_url   = optional(string)
    public_read       = optional(bool)
  })
  default   = null
  sensitive = true
}

variable "invoker_service_accounts" {
  description = "Map of stable keys to service account emails that should be granted roles/run.invoker on the service. Using a map keeps planning deterministic when values are computed."
  type        = map(string)
  default     = {}
}

variable "labels" {
  description = "Extra labels to apply to resources (merged with module defaults)."
  type        = map(string)
  default     = {}
}

# Internal: allows `terraform validate` inside this module directory without
# causing recursive module expansion when used as a dependency.
variable "__module_validate" {
  description = "Internal. Only used by validate.tf when validating this module in isolation."
  type        = bool
  default     = false
}

variable "startup_cpu_boost" {
  description = <<-EOT
    Temporarily double CPU during container startup. The extra CPU is billed
    only for the boosted window (startup plus ~10s).

    Defaults to true because this service scales to zero and cold-starts on
    every cron tick, with ~21 jobs landing on one fresh 1-vCPU instance at :00.
    Without the boost, Postgres connects (p95 6.7s vs the API's 683ms on the
    same DB) and Redis commands (500ms timeout) time out in the window right
    after boot. Mirrors modules/cloud-run-service.
  EOT
  type        = bool
  default     = true
}

variable "cpu_idle" {
  description = <<-EOT
    Request-based billing. true = CPU is allocated only while a request is in
    flight, so an alive-but-idle instance costs nothing. false = CPU is
    allocated for the whole instance lifetime and billed at the full rate even
    when the instance is doing nothing.

    MUST stay true unless a job does work AFTER its handler has replied
    (post-response async, in-process timers, background drains) — that work is
    starved of CPU under request-based billing. As of this change every job
    runs inside its request: the POST handler awaits the job and awaits
    tracker.record() before sending a response.

    Defaults to true for the same reason as modules/cloud-run-service, where
    leaving the provider default of false billed hf-prod-api and hf-prod-web a
    full vCPU each around the clock. This service scales to zero
    (min_instance_count = 0), so the exposure is smaller — it is the keep-alive
    window after each scheduled run, which with a busy cron manifest can keep an
    instance alive close to continuously.
  EOT
  type        = bool
  default     = true
}
