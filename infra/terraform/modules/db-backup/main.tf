# ─────────────────────────────────────────────────────────────────────────────
# db-backup — daily pg_dump of the Neon Postgres database to GCS
#
# Spec: docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md
#
# Layered retention via per-prefix lifecycle rules:
#   daily/YYYY/MM/DD.dump.zst   — every nightly dump, kept 30 days (Standard)
#   monthly/YYYY-MM.dump.zst    — 1st-of-month dump, kept 12 months (→ Nearline)
#   yearly/YYYY.dump.zst        — Jan-1 dump, kept 7 years (→ Coldline → Archive)
#
# Two Cloud Run Jobs share one image (infra/docker/pg-dump):
#   {prefix}-pg-dump          MODE=dump     nightly logical dump → daily/
#   {prefix}-pg-dump-promote  MODE=promote  monthly copy daily → monthly|yearly
#
# NOTE: GCS does not allow object versioning together with a bucket retention
# policy. The spec asked for both; the retention policy is the actual
# ransomware / accidental-delete defense (objects are date-stamped and never
# overwritten), so versioning is intentionally OFF.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  labels = merge(
    {
      application = "ithasfire"
      environment = var.environment
      component   = "db-backup"
      managed-by  = "terraform"
    },
    var.labels,
  )

  bucket_name = "${var.name_prefix}-db-backups"

  # Cloud Run Jobs + Scheduler triggers only exist once an image is pinned.
  # This lets the storage layer (bucket/CMEK/SA/topic) apply before the first
  # image has been pushed (spec implementation plan: step 1 before step 3).
  jobs = var.image == null ? {} : {
    daily = {
      job_name       = "${var.name_prefix}-pg-dump"
      scheduler_name = "${var.name_prefix}-pg-dump-daily"
      mode           = "dump"
      schedule       = var.dump_schedule
      description    = "Nightly pg_dump of the ${var.environment} Postgres database to GCS (daily tier)."
    }
    promote = {
      job_name       = "${var.name_prefix}-pg-dump-promote"
      scheduler_name = "${var.name_prefix}-pg-dump-promote-monthly"
      mode           = "promote"
      schedule       = var.promote_schedule
      description    = "Promotes the 1st-of-month daily backup into the monthly tier (and yearly on Jan 1)."
    }
  }
}

# ─── CMEK (Cloud KMS) ─────────────────────────────────────────────────────────
# Key rings are immutable + undeletable, so the name carries the environment
# prefix to avoid dev/prod collisions in the shared project.

resource "google_kms_key_ring" "backups" {
  name     = "${var.name_prefix}-backups"
  location = var.region
  project  = var.project_id
}

resource "google_kms_crypto_key" "db_backups" {
  name            = "db-backups"
  key_ring        = google_kms_key_ring.backups.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.kms_rotation_period

  labels = local.labels

  lifecycle {
    # Losing this key = losing every backup encrypted under it.
    prevent_destroy = true
  }
}

# GCS encrypts objects server-side via its project service agent, so THAT
# identity (not the job SA) needs encrypt/decrypt on the CMEK key.
data "google_storage_project_service_account" "gcs" {
  project = var.project_id
}

resource "google_kms_crypto_key_iam_member" "gcs_service_agent" {
  crypto_key_id = google_kms_crypto_key.db_backups.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

# ─── Backup bucket ────────────────────────────────────────────────────────────

resource "google_storage_bucket" "backups" {
  name     = local.bucket_name
  location = var.region
  project  = var.project_id

  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # Immutability window — nobody (including project owners) can delete or
  # overwrite an object younger than this. Lock via var.lock_retention_policy
  # once the pipeline is smoke-tested (locking is irreversible).
  retention_policy {
    retention_period = var.object_retention_seconds
    is_locked        = var.lock_retention_policy
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.db_backups.id
  }

  # Daily tier: Standard for its whole 30-day life, then deleted.
  lifecycle_rule {
    condition {
      age            = var.daily_retention_days
      matches_prefix = ["daily/"]
    }
    action {
      type = "Delete"
    }
  }

  # Monthly + yearly tiers cool down to Nearline after 30 days.
  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["monthly/", "yearly/"]
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age            = var.monthly_retention_days
      matches_prefix = ["monthly/"]
    }
    action {
      type = "Delete"
    }
  }

  # Yearly tier: Nearline 30d → Coldline 90d → Archive 365d → delete at 7y.
  lifecycle_rule {
    condition {
      age            = 90
      matches_prefix = ["yearly/"]
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  lifecycle_rule {
    condition {
      age            = 365
      matches_prefix = ["yearly/"]
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }

  lifecycle_rule {
    condition {
      age            = var.yearly_retention_days
      matches_prefix = ["yearly/"]
    }
    action {
      type = "Delete"
    }
  }

  labels = local.labels

  # The default CMEK is validated at bucket-create time — the GCS service
  # agent must already hold encrypt/decrypt on the key.
  depends_on = [google_kms_crypto_key_iam_member.gcs_service_agent]
}

# ─── Runtime service account + least-privilege IAM ────────────────────────────

resource "google_service_account" "pg_dump" {
  account_id   = "${var.name_prefix}-pg-dump"
  display_name = "${var.name_prefix} pg_dump backup job"
  project      = var.project_id
}

# Write new objects (daily dump upload, monthly/yearly copy destination).
resource "google_storage_bucket_iam_member" "object_creator" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.pg_dump.email}"
}

# Read objects (verify upload, copy source for the promote job). No delete —
# lifecycle rules own deletion.
resource "google_storage_bucket_iam_member" "object_viewer" {
  bucket = google_storage_bucket.backups.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.pg_dump.email}"
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  project   = var.project_id
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pg_dump.email}"
}

resource "google_secret_manager_secret_iam_member" "alert_webhook" {
  count = var.alert_webhook_secret_id == null ? 0 : 1

  project   = var.project_id
  secret_id = var.alert_webhook_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pg_dump.email}"
}

# ─── Pub/Sub manifest events ──────────────────────────────────────────────────
# Topic name follows the generated-jobs.tf convention: "${environment}-${topic}".

resource "google_pubsub_topic" "backup_events" {
  name    = "${var.environment}-backup-events"
  project = var.project_id

  labels = local.labels
}

resource "google_pubsub_topic_iam_member" "publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.backup_events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.pg_dump.email}"
}

# ─── Cloud Run Jobs (dump + promote, one image) ───────────────────────────────

resource "google_cloud_run_v2_job" "backup" {
  for_each = local.jobs

  name     = each.value.job_name
  location = var.region
  project  = var.project_id

  labels = local.labels

  template {
    labels = local.labels

    template {
      service_account = google_service_account.pg_dump.email
      timeout         = "${var.timeout_seconds}s"
      max_retries     = var.max_retries

      containers {
        image = var.image

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }

        env {
          name  = "MODE"
          value = each.value.mode
        }

        env {
          name  = "GCS_BUCKET"
          value = google_storage_bucket.backups.name
        }

        env {
          name  = "PUBSUB_TOPIC"
          value = google_pubsub_topic.backup_events.id
        }

        env {
          name  = "DAILY_PREFIX"
          value = "daily"
        }

        env {
          name  = "MONTHLY_PREFIX"
          value = "monthly"
        }

        env {
          name  = "YEARLY_PREFIX"
          value = "yearly"
        }

        # DIRECT endpoint, not the pooler — pg_dump needs session state.
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = var.database_url_secret_id
              version = "latest"
            }
          }
        }

        dynamic "env" {
          for_each = var.alert_webhook_secret_id == null ? [] : [1]
          content {
            name = "BACKUP_ALERT_WEBHOOK"
            value_source {
              secret_key_ref {
                secret  = var.alert_webhook_secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.alert_webhook,
    google_storage_bucket_iam_member.object_creator,
    google_storage_bucket_iam_member.object_viewer,
    google_pubsub_topic_iam_member.publisher,
  ]
}

# ─── Cloud Scheduler triggers ─────────────────────────────────────────────────
# Executes the job via the Cloud Run Admin API (jobs.run). googleapis.com
# targets authenticate with an OAuth access token (OIDC is for custom
# audiences), so the trigger SA carries roles/run.invoker on each job.

resource "google_service_account" "scheduler" {
  account_id   = "${var.name_prefix}-pg-dump-sch"
  display_name = "${var.name_prefix} pg_dump scheduler invoker"
  project      = var.project_id
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  for_each = google_cloud_run_v2_job.backup

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "backup" {
  for_each = local.jobs

  name        = each.value.scheduler_name
  description = each.value.description
  project     = var.project_id
  region      = var.region

  schedule  = each.value.schedule
  time_zone = "Etc/UTC"

  # jobs.run returns a long-running operation immediately; the deadline only
  # covers the API call, not the execution itself.
  attempt_deadline = "320s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.backup[each.key].name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.scheduler_invoker]
}
