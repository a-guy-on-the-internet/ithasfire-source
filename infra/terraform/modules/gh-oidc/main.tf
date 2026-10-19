resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = "GitHub Actions - Ithas Fire"
  description               = "Identity pool for GitHub Actions authentication"
  disabled                  = false

  # The CI service account doesn't have iam.workloadIdentityPools.update,
  # and these fields are pure cosmetics — drift after the Hearthfire →
  # Ithas Fire rename was blocking every apply. Either widen the SA's IAM
  # role or keep this ignore_changes block.
  lifecycle {
    ignore_changes = [display_name, description]
  }
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "GitHub"
  description                        = "OIDC Provider for GitHub Actions"
  disabled                           = false

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.event_name"       = "assertion.event_name"
    "attribute.ref"              = "assertion.ref"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.workflow"         = "assertion.workflow"
  }

  # "schedule" is required by rotate-apple-secret.yml's monthly cron; without it
  # that workflow cannot mint a GCP token. Kept in sync with the live provider.
  attribute_condition = <<EOT
attribute.repository == "${var.repository_name}"
&& (
  attribute.event_name == "pull_request"
  || attribute.event_name == "workflow_dispatch"
  || attribute.event_name == "schedule"
  || (attribute.event_name == "push" && attribute.ref == "refs/heads/main")
)
EOT

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # Same reason as the pool above: the CI service account has no
  # iam.workloadIdentityPoolProviders.update permission, so ANY diff here — even
  # cosmetic whitespace, since GCP normalises the condition it stores — makes
  # `terraform apply` die with a 403 PART WAY THROUGH, leaving the run half
  # applied (observed 2026-09-01). This provider is the credential every
  # workflow authenticates with, so it is deliberately change-by-hand:
  # edit it with `gcloud iam workload-identity-pools providers update-oidc`,
  # then mirror the change in the attribute_condition above.
  lifecycle {
    ignore_changes = [attribute_condition, display_name, description]
  }
}

resource "google_service_account_iam_member" "workload_identity_user" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.service_account_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.repository_name}"
}

output "provider_name" {
  value = google_iam_workload_identity_pool_provider.github.name
}
