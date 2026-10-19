# ═══════════════════════════════════════════════════════════════════════════════
# Cloud Tasks queue for HTTP tasks, with queue-scoped enqueuer IAM.
#
# The caller enables cloudtasks.googleapis.com (a project-level service) and
# grants the OIDC service account roles/run.invoker on the target; this module
# owns only the queue and who may put tasks on it.
#
# IAM is queue-scoped on purpose: dev and prod share one GCP project, so a
# project-level roles/cloudtasks.enqueuer would let each environment's runtime
# enqueue into the other's queue. Setting queue IAM needs
# cloudtasks.queues.setIamPolicy, which roles/editor does not carry; the
# deployer needs roles/cloudtasks.admin (scripts/bootstrap.sh).
# ═══════════════════════════════════════════════════════════════════════════════

resource "google_cloud_tasks_queue" "this" {
  project  = var.project_id
  location = var.location
  name     = var.name

  rate_limits {
    max_concurrent_dispatches = var.max_concurrent_dispatches
    max_dispatches_per_second = var.max_dispatches_per_second
  }

  retry_config {
    max_attempts = var.max_attempts
    min_backoff  = var.min_backoff
    max_backoff  = var.max_backoff
  }
}

resource "google_cloud_tasks_queue_iam_member" "enqueuer" {
  for_each = var.enqueuer_service_accounts

  project  = google_cloud_tasks_queue.this.project
  location = google_cloud_tasks_queue.this.location
  name     = google_cloud_tasks_queue.this.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${each.value}"
}

# Creating a task with an oidcToken for another service account is an actAs on
# that account, checked at enqueue time.
resource "google_service_account_iam_member" "enqueuer_acts_as_oidc" {
  for_each = var.grant_enqueuers_act_as_oidc ? var.enqueuer_service_accounts : {}

  service_account_id = var.oidc_service_account_id
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${each.value}"

  lifecycle {
    precondition {
      condition     = var.oidc_service_account_id != null
      error_message = "grant_enqueuers_act_as_oidc = true needs oidc_service_account_id."
    }
  }
}
