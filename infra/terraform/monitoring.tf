# ─────────────────────────────────────────────────────────────────────────────
# Production monitoring — uptime checks, alert policies, webhook-failure metric
#
# All resources are env-prefixed (hf-{env}-…) because dev and prod share the
# hearthfire-491918 GCP project; the active Terraform workspace decides which
# environment's monitoring stack is managed.
#
# Gating:
#   enable_uptime_checks = true   → HTTPS uptime checks + uptime alert policies
#                                   (prod on; dev off by default — scale-to-zero
#                                   cold starts can flap the probes)
#   alerts_email != null          → email notification channel; alert policies
#                                   are created regardless but only notify when
#                                   the channel exists.
#
# The Stripe-webhook-failure log metric + alert are always provisioned: the
# metric is free until logs match, and the filter is already env-scoped.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  monitoring_name_prefix = "hf-${local.workspace_environment}"

  # Mirror the DNS names main.tf passes to module.environment so the uptime
  # checks always probe the same hosts Cloudflare routes:
  #   prod: api.ithasfire.com / ithasfire.com (web_name "@" = apex)
  #   dev:  api-dev.ithasfire.com / web-dev.ithasfire.com
  monitoring_api_host   = "${coalesce(var.api_name, local.workspace_environment == "prod" ? "api" : "api-${local.workspace_environment}")}.${var.domain}"
  monitoring_web_record = coalesce(var.web_name, local.workspace_environment == "prod" ? "@" : "web-${local.workspace_environment}")
  monitoring_web_host   = local.monitoring_web_record == "@" ? var.domain : "${local.monitoring_web_record}.${var.domain}"

  monitoring_notification_channels = (
    var.alerts_email == null
    ? []
    : [google_monitoring_notification_channel.alerts_email[0].id]
  )

  # Structured failure events emitted by apps/api/src/routes/stripe/webhook.ts:
  #   - "stripe_webhook_unhandled_error_dlq"  → handler threw; raw event was
  #     captured into the Redis DLQ (apps/api/src/lib/webhook-dlq.ts) for replay.
  #   - "stripe_webhook_dlq_store_failed"     → the DLQ write ITSELF failed; the
  #     event is effectively lost and needs manual replay from Stripe.
  # Pino writes JSON to stdout with the event name in the `msg` key, but we
  # match the bare strings (global restriction) so the filter survives both
  # jsonPayload and textPayload ingestion, message-key renames, and wrapping.
  stripe_webhook_failure_log_filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${local.monitoring_name_prefix}-api\"",
    "(\"stripe_webhook_unhandled_error_dlq\" OR \"stripe_webhook_dlq_store_failed\")",
  ])

  # Neon surfaces compute-hour quota exhaustion as a Postgres error:
  #   "XX000: Your account or project has exceeded the compute time quota"
  # (the root cause of the Jun 19–23 2026 partial outage — homepage search,
  # settlements, analytics, and sitemaps all failed silently while the DB
  # rejected queries). `compute time quota` is the stable fragment of that
  # message; we match it as a bare global restriction (not tied to a field or
  # service) so it survives whichever surface logs it — api, jobs, and web all
  # emit it during an outage — and whether it lands in jsonPayload or
  # textPayload. Env-scoped via the `labels.environment` log label (not a
  # service_name) so the dev and prod workspaces don't cross-match each other.
  neon_compute_quota_log_filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "labels.environment=\"${local.workspace_environment}\"",
    "\"compute time quota\"",
  ])
}

# ── Notification channel ─────────────────────────────────────────────────────

resource "google_monitoring_notification_channel" "alerts_email" {
  count = var.alerts_email == null ? 0 : 1

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-alerts-email"
  type         = "email"

  labels = {
    email_address = var.alerts_email
  }
}

# ── Uptime checks ────────────────────────────────────────────────────────────

resource "google_monitoring_uptime_check_config" "api_health" {
  count = var.enable_uptime_checks ? 1 : 0

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-api-health"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path           = "/health"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  # /health returns {"ok":true} — assert on the body, not just the status,
  # so a Cloudflare-served error page can't masquerade as healthy.
  content_matchers {
    content = "\"ok\":true"
    matcher = "CONTAINS_STRING"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.monitoring_api_host
    }
  }
}

resource "google_monitoring_uptime_check_config" "web_root" {
  count = var.enable_uptime_checks ? 1 : 0

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-web-root"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path           = "/"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.monitoring_web_host
    }
  }
}

# ── Uptime alert policies ────────────────────────────────────────────────────
#
# Standard uptime alerting shape: count `check_passed == false` results across
# all checker regions; more than one failed probe within the alignment window
# sustained for `duration` trips the alert. ALIGN_NEXT_OLDER picks the most
# recent boolean sample per checker before the cross-series count.

resource "google_monitoring_alert_policy" "api_uptime_failure" {
  count = var.enable_uptime_checks ? 1 : 0

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-api-uptime-failure"
  combiner     = "OR"

  conditions {
    display_name = "API uptime check failing (${local.monitoring_api_host}/health)"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"uptime_url\"",
        "metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\"",
        "metric.labels.check_id = \"${google_monitoring_uptime_check_config.api_health[0].uptime_check_id}\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.monitoring_notification_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Uptime check for https://${local.monitoring_api_host}/health is failing in ${local.workspace_environment}. Check Cloud Run service ${local.monitoring_name_prefix}-api logs: gcloud run services logs read ${local.monitoring_name_prefix}-api --project ${var.project_id}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "web_uptime_failure" {
  count = var.enable_uptime_checks ? 1 : 0

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-web-uptime-failure"
  combiner     = "OR"

  conditions {
    display_name = "Web uptime check failing (${local.monitoring_web_host}/)"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"uptime_url\"",
        "metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\"",
        "metric.labels.check_id = \"${google_monitoring_uptime_check_config.web_root[0].uptime_check_id}\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.monitoring_notification_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Uptime check for https://${local.monitoring_web_host}/ is failing in ${local.workspace_environment}. Check Cloud Run service ${local.monitoring_name_prefix}-web logs: gcloud run services logs read ${local.monitoring_name_prefix}-web --project ${var.project_id}"
    mime_type = "text/markdown"
  }
}

# ── Stripe webhook failure metric + alert ────────────────────────────────────

resource "google_logging_metric" "stripe_webhook_failures" {
  project = var.project_id
  name    = "${local.monitoring_name_prefix}-stripe-webhook-failures"
  filter  = local.stripe_webhook_failure_log_filter

  description = "Count of Stripe webhook processing failures (events dead-lettered to the Redis DLQ, or DLQ writes that themselves failed) emitted by the ${local.monitoring_name_prefix}-api Cloud Run service."

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# GCP only makes a newly-created log-based metric queryable by the Monitoring
# alerting API after a propagation delay — creating the alert policy in the same
# apply 404s with "Cannot find metric(s) that match type = ...user/<metric>"
# (the API itself says it can take up to ~10 min). time_sleep runs ONCE, on first
# creation, so this one-time wait only costs time on the very first monitoring
# apply in a fresh workspace (e.g. prod's first apply) — not on steady-state runs.
resource "time_sleep" "wait_stripe_webhook_metric" {
  depends_on      = [google_logging_metric.stripe_webhook_failures]
  create_duration = "180s"
}

resource "google_monitoring_alert_policy" "stripe_webhook_failures" {
  # Implicitly depends on the metric via the .name reference below, but that
  # only orders creation — it doesn't wait for GCP to make the metric queryable.
  depends_on = [time_sleep.wait_stripe_webhook_metric]

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-stripe-webhook-failures"
  combiner     = "OR"

  conditions {
    display_name = "Stripe webhook handler dead-lettered an event"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "metric.type = \"logging.googleapis.com/user/${google_logging_metric.stripe_webhook_failures.name}\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.monitoring_notification_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "A Stripe webhook handler in ${local.workspace_environment} failed and the event was dead-lettered (or the DLQ write itself failed — check for `stripe_webhook_dlq_store_failed`, which means the event was lost and must be replayed from the Stripe dashboard). Inspect the DLQ via the platform admin webhook-dlq page, and the logs: gcloud run services logs read ${local.monitoring_name_prefix}-api --project ${var.project_id}"
    mime_type = "text/markdown"
  }
}

# ── Neon compute-hour quota metric + alert ───────────────────────────────────

resource "google_logging_metric" "neon_compute_quota" {
  project = var.project_id
  name    = "${local.monitoring_name_prefix}-neon-compute-quota"
  filter  = local.neon_compute_quota_log_filter

  description = "Count of Neon `compute time quota` exhaustion errors emitted by any Cloud Run service in ${local.workspace_environment}. Non-zero means the database is throttling queries at the plan's compute-hour ceiling — expect broad, silent downstream failures (homepage search, settlements, analytics, sitemaps). This was the signature of the Jun 19–23 2026 partial outage."

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# GCP only makes a newly-created log-based metric queryable by the Monitoring
# alerting API after a propagation delay — creating the alert policy in the same
# apply 404s with "Cannot find metric(s) that match type = ...user/<metric>"
# (the API itself says it can take up to ~10 min). time_sleep runs ONCE, on first
# creation, so this one-time wait only costs time on the very first monitoring
# apply in a fresh workspace (e.g. prod's first apply) — not on steady-state runs.
resource "time_sleep" "wait_neon_compute_quota_metric" {
  depends_on      = [google_logging_metric.neon_compute_quota]
  create_duration = "180s"
}

resource "google_monitoring_alert_policy" "neon_compute_quota" {
  # Implicitly depends on the metric via the .name reference below, but that
  # only orders creation — it doesn't wait for GCP to make the metric queryable.
  depends_on = [time_sleep.wait_neon_compute_quota_metric]

  project      = var.project_id
  display_name = "${local.monitoring_name_prefix}-neon-compute-quota"
  combiner     = "OR"

  conditions {
    display_name = "Neon compute-hour quota exhausted (DB throttling queries)"

    condition_threshold {
      filter = join(" AND ", [
        "resource.type = \"cloud_run_revision\"",
        "metric.type = \"logging.googleapis.com/user/${google_logging_metric.neon_compute_quota.name}\"",
      ])

      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.monitoring_notification_channels

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Neon returned `XX000: ...exceeded the compute time quota` in ${local.workspace_environment} — the prod database has burned through its plan's compute-hour ceiling and is rejecting queries. Downstream this fails silently and broadly (homepage search, settlements, analytics, sitemaps). Remediate by upgrading the Neon plan / raising the compute quota, waiting for the quota to reset, or reducing load. Confirm the signature in the logs: gcloud run services logs read ${local.monitoring_name_prefix}-jobs --project ${var.project_id}. This was the root cause of the Jun 19–23 2026 partial outage."
    mime_type = "text/markdown"
  }
}
