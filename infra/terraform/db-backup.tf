# ─────────────────────────────────────────────────────────────────────────────
# Database backups — daily pg_dump of the Neon Postgres database to GCS
#
# Spec: docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md
# Runbook: docs/runbooks/db-backup-restore.md
#
# Gating (cost-conscious — dev is disposable, backups are prod-only):
#   enable_db_backups = true   → bucket + CMEK + SA + Pub/Sub topic
#   db_backup_image   != null  → Cloud Run Jobs + Cloud Scheduler triggers
#
# Requires enable_neon = true: the dump job reads the DIRECT (non-pooler)
# connection string from the existing hf-{env}-direct-database-url secret
# provisioned in secrets.tf. No new secrets are introduced.
# ─────────────────────────────────────────────────────────────────────────────

check "db_backups_require_neon" {
  assert {
    condition     = !var.enable_db_backups || var.enable_neon
    error_message = "enable_db_backups=true requires enable_neon=true — the dump job sources DATABASE_URL from the Terraform-managed hf-{env}-direct-database-url secret."
  }
}

module "db_backup" {
  source = "./modules/db-backup"

  count = var.enable_db_backups && var.enable_neon ? 1 : 0

  project_id  = var.project_id
  region      = var.region
  environment = local.workspace_environment
  name_prefix = "hf-${local.workspace_environment}"

  image = var.db_backup_image

  # DIRECT endpoint secret (pg_dump needs session state; never the pooler).
  database_url_secret_id = google_secret_manager_secret.app["DIRECT_DATABASE_URL"].secret_id

  # Failure alerts ride the existing Discord ops webhook when configured.
  alert_webhook_secret_id = (
    contains(local.app_secret_keys, "DISCORD_ALERTS_WEBHOOK")
    ? google_secret_manager_secret.app["DISCORD_ALERTS_WEBHOOK"].secret_id
    : null
  )

  # Bucket Lock is irreversible — flip only after the first restore drill
  # confirms the pipeline end-to-end (see runbook).
  lock_retention_policy = var.db_backup_lock_retention
}

output "db_backup_bucket_name" {
  description = "GCS bucket holding database backups (null when db backups are disabled)."
  value       = try(module.db_backup[0].bucket_name, null)
}

output "db_backup_job_names" {
  description = "Cloud Run Job names for the backup pipeline (empty until db_backup_image is pinned)."
  value       = try(module.db_backup[0].job_names, {})
}

output "db_backup_events_topic" {
  description = "Pub/Sub topic receiving backup manifest events (null when db backups are disabled)."
  value       = try(module.db_backup[0].backup_events_topic, null)
}
