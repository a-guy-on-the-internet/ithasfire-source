# ═══════════════════════════════════════════════════════════════════════════════
# Search reindex triggers
#
#   1. Edit-triggered reindex drain. A write that marks an entity in
#      SearchReindexPending asks Cloud Tasks for ONE delayed run of
#      `search.drain-reindex-pending` per time slot (the task name is the
#      dedupe key). The drain reschedules itself only while rows remain.
#      Adapter: packages/adapters/src/queue/cloud-tasks-scheduler.ts.
#   2. Post-deploy format check. The deploy workflows publish `{}` to the
#      `search.ensure-format` trigger topic (created from the manifest's
#      queue-entry `triggerTopic` in generated-jobs.tf) after jobs rolls.
#
# Everything is off in a workspace without the jobs service.
# ═══════════════════════════════════════════════════════════════════════════════

locals {
  search_drain_enabled = var.jobs_image != null
}


# ─────────────────────────────────────────────────────────────────────────────────
# 1. Cloud Tasks queue for the edit-triggered drain
# ─────────────────────────────────────────────────────────────────────────────────

# Project-level service in a project dev and prod share. Both workspaces
# declare it so whichever applies first enables it; `disable_on_destroy =
# false` means neither can switch it off under the other.
resource "google_project_service" "cloudtasks" {
  count = local.search_drain_enabled ? 1 : 0

  project = var.project_id
  service = "cloudtasks.googleapis.com"

  disable_on_destroy = false
}

# A just-enabled API can still 403 for a minute or so while enablement
# propagates. Runs once, on first create, like time_sleep.wait_for_secret_iam
# (secrets.tf); a no-op wait on later applies.
resource "time_sleep" "wait_for_cloudtasks_api" {
  count = local.search_drain_enabled ? 1 : 0

  depends_on      = [google_project_service.cloudtasks]
  create_duration = "60s"
}

module "search_drain_queue" {
  source = "./modules/cloud-tasks-queue"

  count = local.search_drain_enabled ? 1 : 0

  project_id = var.project_id
  location   = local.jobs_region
  name       = "${local.jobs_name_prefix}-search-drain"

  # One drain at a time: overlapping drains would read the same marks.
  max_concurrent_dispatches = 1
  max_attempts              = 3
  min_backoff               = "60s"
  max_backoff               = "300s"

  enqueuer_service_accounts = merge(
    { jobs = module.jobs_service[0].runtime_service_account_email },
    var.api_image != null ? { api = module.api_service[0].runtime_service_account_email } : {},
  )

  # The task's OIDC identity. Reuses the Cloud Scheduler invoker, which
  # already holds roles/run.invoker on the jobs service (main.tf).
  grant_enqueuers_act_as_oidc = true
  oidc_service_account_id     = google_service_account.jobs_scheduler_invoker.name

  depends_on = [time_sleep.wait_for_cloudtasks_api]
}

# Project number for the jobs service's deterministic URL below.
data "google_project" "current" {
  count = local.search_drain_enabled ? 1 : 0

  project_id = var.project_id
}

locals {
  # Cloud Run's deterministic URL, https://<service>-<project-number>.<region>.run.app.
  # The jobs service cannot read its own module.jobs_service[0].service_url
  # into its env (that is a cycle), and this form is known at plan time. The
  # service name matches modules/cloud-run-jobs-service
  # ("<name_prefix>-<service_name>").
  jobs_deterministic_url = local.search_drain_enabled ? "https://${local.jobs_name_prefix}-${var.jobs_service_name}-${data.google_project.current[0].number}.${local.jobs_region}.run.app" : null

  # Merged into resolved_api_env (main.tf). The API targets JOBS_SERVICE_URL,
  # which main.tf already sets.
  search_drain_api_env = local.search_drain_enabled ? {
    CLOUD_TASKS_QUEUE      = module.search_drain_queue[0].id
    CLOUD_TASKS_INVOKER_SA = google_service_account.jobs_scheduler_invoker.email
  } : {}

  # Merged into resolved_jobs_env (main.tf). Jobs targets its tasks at
  # SEARCH_DRAIN_TARGET_URL (apps/jobs/src/lib/container.ts), which is also
  # the task's OIDC audience.
  #
  # CAUTION: deliberately NOT JOBS_SELF_URL. That one is the base of the jobs
  # container's own `enqueue` (the DLQ rerun path, falling back to
  # http://localhost:$PORT and sending only `Bearer JOBS_API_KEY`); pointing it
  # at the public URL would route reruns through Cloud Run IAM, which rejects
  # them. Leave JOBS_SELF_URL unset here.
  search_drain_jobs_env = local.search_drain_enabled ? {
    CLOUD_TASKS_QUEUE       = module.search_drain_queue[0].id
    CLOUD_TASKS_INVOKER_SA  = google_service_account.jobs_scheduler_invoker.email
    SEARCH_DRAIN_TARGET_URL = local.jobs_deterministic_url
  } : {}
}


# ─────────────────────────────────────────────────────────────────────────────────
# 2. Deployer may publish the post-deploy format check
# ─────────────────────────────────────────────────────────────────────────────────

# Topic-scoped: this is the only trigger topic the workflows publish to.
resource "google_pubsub_topic_iam_member" "search_ensure_format_publisher_deployer" {
  for_each = var.jobs_image == null ? {} : {
    for name, topic in local.jobs_triggered_tasks : name => topic
    if name == "search.ensure-format"
  }

  project = var.project_id
  topic   = google_pubsub_topic.jobs_trigger[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${local.ci_deployer_service_account_email}"
}
