# ─────────────────────────────────────────────────────────────────────────────────
# Cloud Translation (v3) for the API
#
# The API calls projects.locations.translateText (location "global") as its
# runtime service account via ADC, the same way the Cloud Tasks adapter
# authenticates (packages/adapters/src/queue/cloud-tasks-scheduler.ts). No key
# is shipped. The project id reaches the API as GCP_PROJECT_ID (main.tf,
# resolved_api_env), the name jobs already uses.
# ─────────────────────────────────────────────────────────────────────────────────

# Project-level service in a project dev and prod share. Both workspaces
# declare it so whichever applies first enables it; `disable_on_destroy =
# false` means neither can switch it off under the other (same rule as
# google_project_service.cloudtasks in search-reindex.tf).
resource "google_project_service" "translate" {
  count = var.api_image == null ? 0 : 1

  project = var.project_id
  service = "translate.googleapis.com"

  disable_on_destroy = false
}

# Translation has no resource-level IAM, so the grant is project-scoped. Each
# workspace grants its own API runtime SA (hf-<env>-api-runtime), so dev and
# prod bindings never collide. The deployer holds
# roles/resourcemanager.projectIamAdmin for this (scripts/bootstrap.sh).
resource "google_project_iam_member" "api_cloudtranslate_user" {
  count = var.api_image == null ? 0 : 1

  project = var.project_id
  role    = "roles/cloudtranslate.user"
  member  = "serviceAccount:${module.api_service[0].runtime_service_account_email}"

  depends_on = [google_project_service.translate]
}
