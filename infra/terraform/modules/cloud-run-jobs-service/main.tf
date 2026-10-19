locals {
  effective_name_prefix = coalesce(var.name_prefix, "hf-${var.environment}")

  labels = merge(
    {
      application = "ithasfire"
      environment = var.environment
      component   = "jobs"
    },
    var.labels
  )

  runtime_sa_id   = "${local.effective_name_prefix}-${var.service_name}-runtime"
  runtime_sa_name = "${local.effective_name_prefix}-${var.service_name}-runtime"

  # Cloud Run env vars.
  container_env = merge(
    {
      # File storage (S3-compatible: Cloudflare R2, MinIO, AWS S3, etc.)
      # S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY come in via secret_env (Secret
      # Manager refs) — never inline them as plaintext env on the Cloud Run
      # service spec or `gcloud run services describe` exposes them to anyone
      # with roles/run.viewer.
      S3_BUCKET          = try(var.s3.bucket, "")
      S3_ENDPOINT        = try(var.s3.endpoint, "")
      S3_PUBLIC_BASE_URL = try(var.s3.public_base_url, "")
      S3_PUBLIC_READ     = tostring(try(var.s3.public_read, false))

      DB_READ_HOST     = ""
      DB_READ_PORT     = ""
      DB_READ_USER     = ""
      DB_READ_DATABASE = ""
    },
    var.env
  )
}

resource "google_service_account" "runtime" {
  account_id   = local.runtime_sa_id
  display_name = local.runtime_sa_name
  project      = var.project_id
}

resource "google_cloud_run_v2_service" "service" {
  name     = "${local.effective_name_prefix}-${var.service_name}"
  location = var.region
  project  = var.project_id

  # INGRESS_TRAFFIC_ALL is required for Cloud Run v2 service-to-service calls.
  # In Cloud Run v2, same-project Cloud Run traffic is NOT classified as internal
  # unless Direct VPC Egress is configured — so the API's fetch() would be blocked
  # by INGRESS_TRAFFIC_INTERNAL_ONLY. Security is enforced by Cloud Run IAM
  # (roles/run.invoker on specific SAs) + JOBS_API_KEY in the Fastify auth hook.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    containers {
      image = var.jobs_image

      ports {
        container_port = var.port
      }

      # Mirrors the pattern in modules/cloud-run-service. Both limits are
      # omitted entirely when null so this stays a no-op for any caller that
      # does not set them.
      resources {
        limits = merge(
          {},
          var.cpu == null ? {} : { cpu = var.cpu },
          var.memory == null ? {} : { memory = var.memory }
        )

        # Double CPU while the container boots. This service scales to zero
        # and cold-starts on every cron tick, so the boot window is exactly
        # when a burst of jobs opens Postgres and Redis connections; without
        # the boost those connects and Redis commands time out right after
        # boot. See the startup_cpu_boost variable.
        startup_cpu_boost = var.startup_cpu_boost

        # Request-based billing — set explicitly because the provider default
        # is false, which bills CPU for the whole instance lifetime including
        # the keep-alive window after a job returns. This module was the last
        # Cloud Run service still on that default (cloud-run-service and
        # cloud-run-audio-transcoder both set it).
        #
        # Safe here because every job runs INSIDE its request: the POST handler
        # in apps/jobs/src/app.ts awaits the job and awaits tracker.record()
        # before replying, so nothing is left running once CPU is throttled. If
        # a job is ever made fire-and-forget, this must go back to false or the
        # detached work is starved.
        cpu_idle = var.cpu_idle
      }

      dynamic "env" {
        # `var.s3` is sensitive, so the merged container_env map inherits
        # the sensitive marking and terraform refuses to for_each it.
        # Iterate keys non-sensitively; the value is still treated as
        # sensitive when exposed via plan output / state.
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

      # Startup probe — tells Cloud Run when the container is actually ready
      # to serve traffic. Without this, Cloud Run guesses based on the port
      # being open, which can route requests before deps (DB, Redis) are ready.
      #
      # THIS MODULE HAD NO PROBE AT ALL until now, which made the app-side
      # migration-drift guard on /health inert: jobs was the highest-volume
      # victim of the drift outage (~208 of ~220 Sentry events, POST /jobs/:name
      # running cron work against a stale schema), and with no probe Cloud Run
      # promoted a drifted revision regardless of what /health returned. With the
      # probe, a revision whose /health reports confirmed+enforced drift never
      # becomes Ready and never receives traffic.
      dynamic "startup_probe" {
        for_each = var.startup_probe_path != null ? [1] : []
        content {
          http_get {
            path = var.startup_probe_path
            port = var.port
          }
          initial_delay_seconds = var.startup_probe_initial_delay
          period_seconds        = var.startup_probe_period_seconds
          timeout_seconds       = var.startup_probe_timeout_seconds
          failure_threshold     = var.startup_probe_failure_threshold
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 10
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

# IAM: grant invokers roles/run.invoker.
resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = var.invoker_service_accounts

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name

  role   = "roles/run.invoker"
  member = "serviceAccount:${each.value}"
}
