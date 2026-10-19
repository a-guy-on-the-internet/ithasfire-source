# ═══════════════════════════════════════════════════════════════════════════════
# Jobs Infrastructure — Pub/Sub, Cloud Scheduler, and Push Subscriptions
# ═══════════════════════════════════════════════════════════════════════════════
#
# Reads apps/jobs/jobs.manifest.json as the single source of truth for
# job names, schedules, and Pub/Sub topics. TypeScript code reads the
# same file. A pre-commit hook validates they stay in sync.
# ═══════════════════════════════════════════════════════════════════════════════


# ─────────────────────────────────────────────────────────────────────────────────
# Read the manifest
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  jobs_manifest = jsondecode(file("${path.module}/../../apps/jobs/jobs.manifest.json"))

  # Queue jobs — active handlers + legacy topics
  # Filter out _comment keys from legacy section
  jobs_queue_jobs = merge(
    {
      for name, cfg in local.jobs_manifest.queue : name => {
        topic       = cfg.topic
        description = cfg.description
      }
    },
    {
      for name, cfg in local.jobs_manifest.legacy_queue : name => {
        topic       = cfg.topic
        description = cfg.description
      } if name != "_comment"
    },
  )

  # Scheduled tasks — derive run_path, payload, and enabled from the manifest
  jobs_scheduled_tasks = {
    for name, cfg in local.jobs_manifest.scheduled : name => {
      run_path    = "/jobs/${name}"
      description = cfg.description
      cron        = cfg.cron
      timezone    = cfg.timezone
      enabled     = try(cfg.enabled, true)
      payload     = try(cfg.payload, "{}")
      # Cloud Scheduler's HTTP attempt deadline. Null keeps the provider
      # default (180s); the write-triggered drains set 300s because one run
      # is budgeted to finish inside Cloud Run's 300s request timeout.
      attempt_deadline = try(cfg.attemptDeadline, null)
      # Cloud Scheduler retries a failed tick unless the manifest says
      # `"retry": false` (see retry_config on google_cloud_scheduler_job.jobs).
      retry = try(cfg.retry, true)
    }
  }
}


# ─────────────────────────────────────────────────────────────────────────────────
# Per-environment overrides (set in tfvars)
# ─────────────────────────────────────────────────────────────────────────────────

variable "jobs_scheduler_overrides" {
  description = "Per-task scheduler overrides. Keys are task keys (e.g., 'settlements.run-batch'). Values can override 'enabled', 'cron', 'timezone', 'payload'."
  type = map(object({
    enabled  = optional(bool)
    cron     = optional(string)
    timezone = optional(string)
    payload  = optional(string) # JSON string
  }))
  default = {}
}


# ─────────────────────────────────────────────────────────────────────────────────
# Pub/Sub Topics (one per queue job)
# ─────────────────────────────────────────────────────────────────────────────────

resource "google_pubsub_topic" "jobs" {
  for_each = var.jobs_image == null ? {} : local.jobs_queue_jobs

  name    = "${local.workspace_environment}-${each.value.topic}"
  project = var.project_id

  labels = {
    application = "ithasfire"
    environment = local.workspace_environment
    component   = "jobs"
    job_key     = replace(each.key, ".", "-")
  }
}


# ─────────────────────────────────────────────────────────────────────────────────
# Pub/Sub Push Subscriptions (one per topic)
# ─────────────────────────────────────────────────────────────────────────────────

resource "google_pubsub_subscription" "jobs_push" {
  for_each = var.jobs_image == null ? {} : local.jobs_queue_jobs

  name    = "${local.workspace_environment}-${each.value.topic}-push"
  topic   = google_pubsub_topic.jobs[each.key].id
  project = var.project_id

  ack_deadline_seconds = 30

  push_config {
    push_endpoint = "${module.jobs_service[0].service_url}/pubsub/push"

    oidc_token {
      service_account_email = google_service_account.jobs_pubsub_push_invoker.email
      audience              = module.jobs_service[0].service_url
    }

    attributes = {
      "x-goog-version" = "v1"
    }
  }

  labels = {
    application = "ithasfire"
    environment = local.workspace_environment
    component   = "jobs"
    job_key     = replace(each.key, ".", "-")
  }
}


# ─────────────────────────────────────────────────────────────────────────────────
# Write-triggered drains (scheduled entries with a `triggerTopic`)
#
# The API (and jobs) publish a wake-up to this topic after committing an outbox
# row (packages/adapters/src/decorators/with-outbox-drain-triggers.ts). The push
# subscription delivers the message body VERBATIM (`no_wrapper`) to the SAME
# `POST /jobs/<name>` route Cloud Scheduler calls, so the run goes through the
# usual drift guard, enabled check and run history — no separate push handler.
# The job's scheduled cron stays on as the safety net for lost publishes.
#
# The topic suffix must match DRAIN_TRIGGERS in packages/ports/src/job-trigger.ts;
# `pnpm -C apps/jobs validate:manifest` fails when they disagree.
#
# QUEUE entries may carry a `triggerTopic` too (e.g. `search.ensure-format`,
# published once per deploy by the deploy workflows). They get the same topic
# and no_wrapper push subscription, but NOT the api/jobs publisher IAM: those
# processes never publish them (whoever does gets its own grant, e.g.
# search-reindex.tf). They have no Cloud Scheduler job, so no cron safety net
# and no attemptDeadline. Keys are job names, which the manifest gate keeps
# unique across both sections, so adding queue entries never moves an existing
# scheduled trigger's resource address.
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  # Scheduled drains the API and jobs processes wake (DRAIN_TRIGGERS). Feeds
  # the publisher IAM below.
  jobs_drain_triggered_tasks = {
    for name, cfg in local.jobs_manifest.scheduled : name => cfg.triggerTopic
    if try(cfg.triggerTopic, null) != null
  }

  # Every trigger topic: the drains above plus queue entries. Feeds the topic
  # and push subscription.
  jobs_triggered_tasks = merge(
    local.jobs_drain_triggered_tasks,
    {
      for name, cfg in local.jobs_manifest.queue : name => cfg.triggerTopic
      if try(cfg.triggerTopic, null) != null
    },
  )

  # Everything before the topic suffix, handed to the API and jobs processes
  # as JOB_TRIGGER_TOPIC_PREFIX (main.tf). Null when the jobs service (and so
  # the topics) is not deployed in this workspace.
  jobs_trigger_topic_prefix = var.jobs_image == null ? null : "projects/${var.project_id}/topics/${local.workspace_environment}-"
}

resource "google_pubsub_topic" "jobs_trigger" {
  for_each = var.jobs_image == null ? {} : local.jobs_triggered_tasks

  name    = "${local.workspace_environment}-${each.value}"
  project = var.project_id

  # A wake-up is worthless once the safety-net run has passed; keep it no
  # longer than the subscription does.
  message_retention_duration = "600s"

  labels = {
    application = "ithasfire"
    environment = local.workspace_environment
    component   = "jobs"
    job_key     = replace(each.key, ".", "-")
  }
}

resource "google_pubsub_subscription" "jobs_trigger_push" {
  for_each = var.jobs_image == null ? {} : local.jobs_triggered_tasks

  name    = "${local.workspace_environment}-${each.value}-push"
  topic   = google_pubsub_topic.jobs_trigger[each.key].id
  project = var.project_id

  # One request is bounded to ~270s: a drain pass-loop is budgeted at 120s
  # (packages/core/src/lib/drain-loop.ts) and no coalesced follow-up starts
  # after 150s (apps/jobs/src/lib/drain-flights.ts). 300s matches Cloud Run's
  # default request timeout, so Pub/Sub does not redeliver a run still working.
  ack_deadline_seconds = 300

  # Minimum Pub/Sub allows. An undelivered wake-up older than this is moot: the
  # */30 safety-net run drains the row anyway.
  message_retention_duration = "600s"

  push_config {
    push_endpoint = "${module.jobs_service[0].service_url}/jobs/${each.key}"

    oidc_token {
      service_account_email = google_service_account.jobs_pubsub_push_invoker.email
      audience              = module.jobs_service[0].service_url
    }

    # Deliver the message data as the raw request body (the job's input JSON),
    # not wrapped in a Pub/Sub envelope the job's strict input schema rejects.
    no_wrapper {
      write_metadata = false
    }
  }

  # Non-2xx (drift 503, module-load 503, a 500) is retried with backoff until
  # the retention above runs out.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  # Never expire for inactivity (the default deletes a subscription after 31
  # idle days — plausible in dev for image moderation).
  expiration_policy {
    ttl = ""
  }

  labels = {
    application = "ithasfire"
    environment = local.workspace_environment
    component   = "jobs"
    job_key     = replace(each.key, ".", "-")
  }
}

# The API commits most outbox rows (RSVPs, cancels, uploads).
resource "google_pubsub_topic_iam_member" "jobs_trigger_publisher_api" {
  for_each = var.jobs_image == null || var.api_image == null ? {} : local.jobs_drain_triggered_tasks

  project = var.project_id
  topic   = google_pubsub_topic.jobs_trigger[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.api_service[0].runtime_service_account_email}"
}

# Jobs commits some too (recurring-date call-offs, the degraded requeue) and
# re-wakes a drain that stopped on its time budget.
resource "google_pubsub_topic_iam_member" "jobs_trigger_publisher_jobs" {
  for_each = var.jobs_image == null ? {} : local.jobs_drain_triggered_tasks

  project = var.project_id
  topic   = google_pubsub_topic.jobs_trigger[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.jobs_service[0].runtime_service_account_email}"
}


# ─────────────────────────────────────────────────────────────────────────────────
# Cloud Scheduler Jobs (one per scheduled task)
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  # Merge default config with per-environment overrides
  jobs_resolved_schedulers = {
    for key, task in local.jobs_scheduled_tasks : key => {
      run_path    = task.run_path
      description = task.description
      cron        = coalesce(try(var.jobs_scheduler_overrides[key].cron, null), task.cron)
      timezone    = coalesce(try(var.jobs_scheduler_overrides[key].timezone, null), task.timezone)
      enabled     = coalesce(try(var.jobs_scheduler_overrides[key].enabled, null), task.enabled)
      payload     = coalesce(try(var.jobs_scheduler_overrides[key].payload, null), task.payload)
      # Manifest only, never a tfvars override: an override could turn retries
      # back on for a job that must not run twice at once.
      retry = task.retry

      attempt_deadline = task.attempt_deadline
    }
  }

  # Filter to only enabled schedulers
  jobs_enabled_schedulers = {
    for key, sched in local.jobs_resolved_schedulers : key => sched
    if sched.enabled && var.jobs_image != null
  }
}

resource "google_cloud_scheduler_job" "jobs" {
  for_each = local.jobs_enabled_schedulers

  name        = "${local.jobs_name_prefix}-${var.jobs_service_name}-${replace(each.key, ".", "-")}"
  description = each.value.description

  project   = var.project_id
  region    = local.jobs_region
  schedule  = each.value.cron
  time_zone = each.value.timezone

  attempt_deadline = each.value.attempt_deadline

  # Without a retry_config a failed tick is lost until the next schedule: an
  # hour for hourly jobs, a day for daily ones. A cold-start burst at :00 once
  # failed every job of a tick together; a retry 30s later lands on a warm
  # instance. At most 3 attempts per tick, the retries 30s then 60s after a
  # failure. retry_count alone sets the limit: max_retry_duration stays unset,
  # because with both set Cloud Scheduler retries until BOTH are reached, which
  # lets a fast-failing job make ~8 attempts in 900s. Worst case at the longest
  # attemptDeadline (300s) ends 300+30+300+60+300s = ~17 min after the tick,
  # before the next tick of the most frequent (*/30) schedule.
  #
  # A retry after an attemptDeadline miss can overlap the first run, which may
  # still be executing on Cloud Run. A job that is unsafe to run twice at once
  # sets `"retry": false` under scheduled.<name> in apps/jobs/jobs.manifest.json.
  # The block is always emitted (retry_count 0 for those jobs), so a later flip
  # to false shows in the plan as 2 -> 0. The provider drops zero fields from
  # the request, so the PATCH replaces retryConfig without retryCount and it
  # falls back to its default of 0. Unverified: after such a flip, check that
  # `gcloud scheduler jobs describe` shows no retryCount.
  retry_config {
    retry_count          = each.value.retry ? 2 : 0
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
    max_doublings        = 2
  }

  http_target {
    http_method = "POST"
    uri         = "${module.jobs_service[0].service_url}${each.value.run_path}"

    headers = {
      "Content-Type" = "application/json"
    }

    body = base64encode(each.value.payload)

    oidc_token {
      service_account_email = google_service_account.jobs_scheduler_invoker.email
      audience              = module.jobs_service[0].service_url
    }
  }
}


# ─────────────────────────────────────────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────────────────────────────────────────

output "jobs_pubsub_topics" {
  description = "Map of job key to Pub/Sub topic name."
  value       = { for key, topic in google_pubsub_topic.jobs : key => topic.name }
}

output "jobs_trigger_topics" {
  description = "Map of write-triggered job key to its wake-up Pub/Sub topic name."
  value       = { for key, topic in google_pubsub_topic.jobs_trigger : key => topic.name }
}

output "jobs_scheduler_jobs" {
  description = "Map of task key to Cloud Scheduler job name."
  value       = { for key, job in google_cloud_scheduler_job.jobs : key => job.name }
}
