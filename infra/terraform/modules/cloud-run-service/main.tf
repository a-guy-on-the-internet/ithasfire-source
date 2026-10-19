locals {
  effective_name_prefix = coalesce(var.name_prefix, "hf-${var.environment}")

  labels = merge(
    {
      application = "ithasfire"
      environment = var.environment
      component   = var.service_name
    },
    var.labels
  )

  runtime_sa_id   = "${local.effective_name_prefix}-${var.service_name}-runtime"
  runtime_sa_name = local.runtime_sa_id

  container_env = merge(
    {},
    var.env
  )
}

resource "google_service_account" "runtime" {
  account_id   = local.runtime_sa_id
  display_name = local.runtime_sa_name
  project      = var.project_id
}

# Grant storage access if GCS volume is configured.
#
# BUCKET-scoped (not project-scoped): the runtime SA only needs access to the
# one bucket it mounts, and bucket IAM is managed with
# storage.buckets.setIamPolicy — covered by the deploy SA's roles/storage.admin.
# The previous project-level google_project_iam_member required
# resourcemanager.projects.setIamPolicy, which the CI deploy SA (roles/editor)
# lacks, so any create/teardown of this binding 403'd (e.g. retiring a service).
# Bucket scope both fixes that and least-privileges the grant.
resource "google_storage_bucket_iam_member" "gcs_storage_access" {
  count  = var.gcs_volume != null ? 1 : 0
  bucket = var.gcs_volume.bucket_name
  role   = var.gcs_volume.read_only ? "roles/storage.objectViewer" : "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_cloud_run_v2_service" "service" {
  name     = "${local.effective_name_prefix}-${var.service_name}"
  location = var.region
  project  = var.project_id

  ingress = var.ingress

  template {
    service_account = google_service_account.runtime.email

    # Gen2 required for GCS FUSE volumes; otherwise let Cloud Run decide (null omits the field)
    execution_environment = var.execution_environment != null ? var.execution_environment : (var.gcs_volume != null ? "EXECUTION_ENVIRONMENT_GEN2" : null)

    containers {
      image = var.image

      ports {
        container_port = var.port
      }

      dynamic "env" {
        for_each = local.container_env
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

      resources {
        limits = merge(
          {},
          var.cpu == null ? {} : { cpu = var.cpu },
          var.memory == null ? {} : { memory = var.memory }
        )
        # Temporarily double CPU allocation during container startup to reduce
        # cold-start latency. This is free — Cloud Run only bills for actual
        # usage during the boosted window.
        startup_cpu_boost = var.startup_cpu_boost

        # Request-based billing — see the cpu_idle variable for why this is
        # set explicitly rather than left to the provider default (it is false).
        cpu_idle = var.cpu_idle
      }

      # Startup probe — tells Cloud Run when the container is actually ready
      # to serve traffic. Without this, Cloud Run guesses based on the port
      # being open, which can route requests before deps (DB, Redis) are ready.
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

      # GCS FUSE volume mount
      dynamic "volume_mounts" {
        for_each = var.gcs_volume != null ? [var.gcs_volume] : []
        content {
          name       = "gcs-data"
          mount_path = volume_mounts.value.mount_path
        }
      }
    }

    # GCS FUSE volume definition
    dynamic "volumes" {
      for_each = var.gcs_volume != null ? [var.gcs_volume] : []
      content {
        name = "gcs-data"
        gcs {
          bucket    = volumes.value.bucket_name
          read_only = volumes.value.read_only
        }
      }
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    labels = local.labels
  }

  # Always serve 100% of traffic from the newest Ready revision.
  #
  # WHY THIS IS EXPLICIT: with no `traffic` block at all, the provider only
  # sets latest=100% on the FIRST apply and never reconciles it afterwards.
  # `gcloud run deploy` (CI) creates a new revision, and a subsequent Terraform
  # apply that bumps the image creates yet another — and the service could drift
  # to a PINNED named revision (`latestRevision: false`) that Terraform then
  # never repairs, because it isn't managing the traffic field. That's exactly
  # how hf-dev-tileserver got stuck serving an ancient revision (00002-jkh) at
  # 100% while dozens of newer Ready revisions received 0% — green pipelines,
  # stale runtime. Declaring TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST makes
  # Terraform authoritative: every apply asserts "latest serves 100%", so any
  # pinned-revision drift is corrected on the next apply. This also stays in
  # lock-step with `gcloud run deploy` (which promotes the new revision to
  # latest by default) — both target "latest", so they never fight.
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  labels = local.labels

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      # NOTE: we intentionally do NOT ignore template[0].containers[0].image.
      # CI pushes new images via `gcloud run deploy` which updates the image tag;
      # Terraform then manages env vars, scaling, and traffic on the same revision.
      # Ignoring the image caused traffic to stay pinned to stale revisions.
      #
      # `traffic` is likewise NOT ignored — it must stay reconciled to
      # latest=100% (see the `traffic` block above) so a stale pin can't survive.
    ]
  }
}


resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = var.invoker_service_accounts

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name

  role   = "roles/run.invoker"
  member = "serviceAccount:${each.value}"
}

resource "google_cloud_run_v2_service_iam_member" "allow_unauthenticated" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name

  role   = "roles/run.invoker"
  member = "allUsers"
}
