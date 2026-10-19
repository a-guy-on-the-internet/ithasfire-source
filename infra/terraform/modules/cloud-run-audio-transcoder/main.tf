locals {
  effective_name_prefix = coalesce(var.name_prefix, "hf-${var.environment}")
  full_service_name     = "${local.effective_name_prefix}-${var.service_name}"

  labels = merge(
    {
      application = "ithasfire"
      environment = var.environment
      component   = "audio-transcoder"
    },
    var.labels
  )

  # Service account IDs (must match GCP naming rules)
  runtime_sa_id     = "${local.effective_name_prefix}-audio-rt"
  pubsub_push_sa_id = "${local.effective_name_prefix}-audio-psh"

  # Runtime SA is normally created at root (see runtime_service_account_email
  # var). The module only creates its own when none is passed in — that path
  # exists for standalone `terraform validate`.
  create_runtime_sa = var.runtime_service_account_email == null
  runtime_sa_email  = coalesce(var.runtime_service_account_email, try(google_service_account.runtime[0].email, null))

  # Container environment variables
  container_env = merge(
    {
      # S3-compatible storage (Cloudflare R2, MinIO, AWS S3, etc.)
      # S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY come in via secret_env (Secret
      # Manager refs) — see comment in cloud-run-jobs-service/main.tf.
      S3_BUCKET          = var.s3.bucket
      S3_ENDPOINT        = var.s3.endpoint
      S3_PUBLIC_BASE_URL = var.s3.public_base_url == null ? "" : var.s3.public_base_url
      S3_PUBLIC_READ     = tostring(coalesce(var.s3.public_read, false))

      # FFmpeg/transcoding
      FFMPEG_PATH           = "ffmpeg"
      TRANSCODE_TEMP_DIR    = "/tmp/transcoder"
      HLS_SEGMENT_DURATION  = "6"
      HLS_AUDIO_BITRATE     = "128000"
      HLS_AUDIO_SAMPLE_RATE = "44100"
      HLS_AUDIO_CHANNELS    = "2"
    },
    var.env
  )
}

# ─────────────────────────────────────────────────────────────────────────────
# Service Accounts
# ─────────────────────────────────────────────────────────────────────────────

# Runtime service account for the Cloud Run service.
# Created here only when the caller does not pass one in (standalone/validate).
# In the root stack the SA is created at root so the secret IAM binding can
# depend on it without cycling through this module.
resource "google_service_account" "runtime" {
  count        = local.create_runtime_sa ? 1 : 0
  account_id   = local.runtime_sa_id
  display_name = "${local.full_service_name} Runtime"
  project      = var.project_id
}

# Service account for Pub/Sub push subscription
resource "google_service_account" "pubsub_push" {
  account_id   = local.pubsub_push_sa_id
  display_name = "${local.full_service_name} Pub/Sub Push"
  project      = var.project_id
}

# ─────────────────────────────────────────────────────────────────────────────
# Cloud Run Service
# ─────────────────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "service" {
  name     = local.full_service_name
  location = var.region
  project  = var.project_id

  # Wait for any external prerequisites (e.g. Secret Manager IAM propagation)
  # before applying the service template, which validates secret_key_ref IAM
  # at update time. Only the service is gated — never the runtime SA.
  depends_on = [var.service_depends_on]

  # Internal only - invoked via Pub/Sub push
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = local.runtime_sa_email

    # Timeout for transcoding operations
    timeout = "${var.timeout_seconds}s"

    # Single concurrent request per instance (transcoding is CPU-intensive)
    max_instance_request_concurrency = var.concurrency

    containers {
      image = var.image

      ports {
        container_port = var.port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle = true # Allow CPU allocation to drop when idle
      }

      dynamic "env" {
        # See cloud-run-jobs-service: var.s3 is sensitive, so the merged
        # container_env map inherits the sensitive marking and terraform
        # refuses to for_each it. nonsensitive() unwraps just for iteration.
        for_each = nonsensitive(local.container_env)
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }

      # Health check
      startup_probe {
        http_get {
          path = "/health"
          port = var.port
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        failure_threshold     = 3
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    labels = local.labels
  }

  labels = local.labels

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].containers[0].image
    ]
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# IAM: Grant invokers roles/run.invoker
# ─────────────────────────────────────────────────────────────────────────────

# Grant Pub/Sub push SA permission to invoke the service
resource "google_cloud_run_v2_service_iam_member" "pubsub_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name

  role   = "roles/run.invoker"
  member = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# Grant any additional invoker service accounts
resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = var.invoker_service_accounts

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name

  role   = "roles/run.invoker"
  member = "serviceAccount:${each.value}"
}

# ─────────────────────────────────────────────────────────────────────────────
# Pub/Sub Topic
# ─────────────────────────────────────────────────────────────────────────────

resource "google_pubsub_topic" "audio_transcode" {
  name    = "${local.full_service_name}-transcode"
  project = var.project_id

  message_retention_duration = var.pubsub_message_retention_duration

  labels = local.labels
}

# Dead letter topic for failed messages
resource "google_pubsub_topic" "audio_transcode_dlq" {
  name    = "${local.full_service_name}-transcode-dlq"
  project = var.project_id

  message_retention_duration = "604800s" # 7 days

  labels = local.labels
}

# ─────────────────────────────────────────────────────────────────────────────
# Pub/Sub Subscription (Push to Cloud Run)
# ─────────────────────────────────────────────────────────────────────────────

resource "google_pubsub_subscription" "audio_transcode_push" {
  name    = "${local.full_service_name}-transcode-push"
  topic   = google_pubsub_topic.audio_transcode.id
  project = var.project_id

  ack_deadline_seconds = var.pubsub_ack_deadline_seconds

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.service.uri}/pubsub/push"

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = google_cloud_run_v2_service.service.uri
    }

    attributes = {
      "x-goog-version" = "v1"
    }
  }

  # Retry policy
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s" # 10 minutes
  }

  # Dead letter policy
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.audio_transcode_dlq.id
    max_delivery_attempts = var.pubsub_dead_letter_max_delivery_attempts
  }

  # Expiration policy - never expire
  expiration_policy {
    ttl = ""
  }

  labels = local.labels
}

# Grant Pub/Sub permission to publish to dead letter topic
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.audio_transcode_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Grant Pub/Sub permission to subscribe (for dead letter redelivery)
resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  project      = var.project_id
  subscription = google_pubsub_subscription.audio_transcode_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# ─────────────────────────────────────────────────────────────────────────────
# Data sources
# ─────────────────────────────────────────────────────────────────────────────

data "google_project" "project" {
  project_id = var.project_id
}
