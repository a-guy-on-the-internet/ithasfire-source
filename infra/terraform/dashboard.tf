# ─────────────────────────────────────────────────────────────────────────────
# Application overview dashboard — Cloud Monitoring
#
# One `google_monitoring_dashboard` per workspace apply (dev / prod each get
# their own, keyed by the env-prefixed display name below), because dev and
# prod share the hearthfire-491918 GCP project — same pattern as the rest of
# this file's sibling, monitoring.tf, and its `local.monitoring_name_prefix`.
#
# Always provisioned (no enable_* gate): dashboards cost nothing and don't
# flap like uptime probes, so this follows the same "always on" posture as
# monitoring.tf's Stripe-webhook-failure and Neon-compute-quota log metrics
# rather than the `enable_uptime_checks`-gated uptime checks/alerts.
#
# Scope: the three core Cloud Run services that make up "the application" —
# api, web, jobs (module.api_service / module.web_service / module.jobs_service
# in main.tf, all named `hf-{env}-{api,web,jobs}` via name_prefix). Deliberately
# excludes meilisearch/tileserver/valhalla/audio-transcoder (optional, niche,
# or retired) and Neon Postgres (external managed service — Cloud Monitoring
# has no metrics for it; that's what the neon_compute_quota log metric in
# monitoring.tf exists to work around).
#
# Per service, five charts:
#   1. Request count broken out by response-code class (2xx/4xx/5xx stacked),
#      PLUS a dedicated 5xx-only chart — the single most useful "is something
#      broken" signal, per the Stripe/Neon incident playbooks above.
#   2. Request latency p50/p95/p99 (DISTRIBUTION metric, percentile-aligned).
#   3. Container CPU utilization (mean + max).
#   4. Container memory utilization (mean + max).
#   5. Container instance count, broken out by active/idle — this app scales
#      to zero, so instance-count spikes are the fastest way to see load (and
#      cost) shifts before they show up on a bill.
#
# Filter syntax note: Cloud Monitoring's time-series filter/groupBy language
# uses the PLURAL field-path form (`resource.labels.<key>`, `metric.labels.<key>`)
# — this mirrors the underlying MonitoredResource/Metric proto's `labels` map
# field, and matches the alert-policy filters already used above in this file
# (e.g. `metric.labels.check_id`). Do not confuse this with the Cloud LOGGING
# query language (also plural, `resource.labels.X`, but a different DSL used
# by the `google_logging_metric.filter` fields elsewhere in monitoring.tf).
# ─────────────────────────────────────────────────────────────────────────────

locals {
  # Ordered (not a bare map) so widget generation below is deterministic and
  # always renders api → web → jobs, top to bottom.
  dashboard_services = [
    { key = "api", label = "API" },
    { key = "web", label = "Web" },
    { key = "jobs", label = "Jobs" },
  ]

  # Actual Cloud Run service names: module.api_service / module.web_service use
  # name_prefix = "hf-${local.workspace_environment}" and module.jobs_service
  # uses local.jobs_name_prefix, which is the identical value — so all three
  # collapse to "${local.monitoring_name_prefix}-{api,web,jobs}".
  dashboard_service_name = {
    for svc in local.dashboard_services : svc.key => "${local.monitoring_name_prefix}-${svc.key}"
  }

  # Common resource scoping shared by every widget's filter: restrict to Cloud
  # Run revision metrics for the one service the widget is about.
  dashboard_base_filter = {
    for svc in local.dashboard_services : svc.key => join(" AND ", [
      "resource.type=\"cloud_run_revision\"",
      "resource.labels.service_name=\"${local.dashboard_service_name[svc.key]}\"",
    ])
  }

  # Flattened widget list, 6 widgets per service, in gridLayout's natural
  # left-to-right/top-to-bottom fill order (columns = 2 below).
  dashboard_widgets = flatten([
    for svc in local.dashboard_services : [
      # 1a. Request count, broken out by response-code class (2xx/4xx/5xx).
      {
        title = "${svc.label} — request count by response code"
        xyChart = {
          dataSets = [{
            timeSeriesQuery = {
              timeSeriesFilter = {
                filter = join(" AND ", [
                  "metric.type=\"run.googleapis.com/request_count\"",
                  local.dashboard_base_filter[svc.key],
                ])
                aggregation = {
                  alignmentPeriod    = "60s"
                  perSeriesAligner   = "ALIGN_RATE"
                  crossSeriesReducer = "REDUCE_SUM"
                  groupByFields      = ["metric.label.response_code_class"]
                }
              }
            }
            plotType = "STACKED_BAR"
          }]
          chartOptions = { mode = "COLOR" }
          yAxis        = { label = "requests/s", scale = "LINEAR" }
        }
      },
      # 1b. 5xx-only — the fastest "is something on fire" signal.
      {
        title = "${svc.label} — 5xx error rate"
        xyChart = {
          dataSets = [{
            timeSeriesQuery = {
              timeSeriesFilter = {
                filter = join(" AND ", [
                  "metric.type=\"run.googleapis.com/request_count\"",
                  local.dashboard_base_filter[svc.key],
                  "metric.labels.response_code_class=\"5xx\"",
                ])
                aggregation = {
                  alignmentPeriod    = "60s"
                  perSeriesAligner   = "ALIGN_RATE"
                  crossSeriesReducer = "REDUCE_SUM"
                }
              }
            }
            plotType = "LINE"
          }]
          chartOptions = { mode = "COLOR" }
          yAxis        = { label = "5xx/s", scale = "LINEAR" }
        }
      },
      # 2. Latency p50/p95/p99. request_latencies is a DISTRIBUTION metric;
      #    ALIGN_PERCENTILE_{50,95,99} reduces each aligned window's histogram
      #    to a scalar at that percentile, then REDUCE_MEAN collapses multiple
      #    concurrently-serving revisions/instances of the same service into
      #    one line per percentile.
      {
        title = "${svc.label} — request latency (p50 / p95 / p99)"
        xyChart = {
          dataSets = [
            for percentile in ["50", "95", "99"] : {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = join(" AND ", [
                    "metric.type=\"run.googleapis.com/request_latencies\"",
                    local.dashboard_base_filter[svc.key],
                  ])
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_PERCENTILE_${percentile}"
                    crossSeriesReducer = "REDUCE_MEAN"
                  }
                }
                unitOverride = "ms"
              }
              plotType       = "LINE"
              legendTemplate = "p${percentile}"
            }
          ]
          chartOptions = { mode = "COLOR" }
          yAxis        = { label = "ms", scale = "LINEAR" }
        }
      },
      # 3. Container CPU utilization — mean + max across instances.
      {
        title = "${svc.label} — container CPU utilization"
        xyChart = {
          dataSets = [
            {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = join(" AND ", [
                    "metric.type=\"run.googleapis.com/container/cpu/utilizations\"",
                    local.dashboard_base_filter[svc.key],
                  ])
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MEAN"
                    crossSeriesReducer = "REDUCE_MEAN"
                  }
                }
              }
              plotType       = "LINE"
              legendTemplate = "mean"
            },
            {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = join(" AND ", [
                    "metric.type=\"run.googleapis.com/container/cpu/utilizations\"",
                    local.dashboard_base_filter[svc.key],
                  ])
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MAX"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                }
              }
              plotType       = "LINE"
              legendTemplate = "max"
            },
          ]
          chartOptions = { mode = "COLOR" }
          yAxis        = { label = "utilization", scale = "LINEAR" }
        }
      },
      # 4. Container memory utilization — mean + max across instances.
      {
        title = "${svc.label} — container memory utilization"
        xyChart = {
          dataSets = [
            {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = join(" AND ", [
                    "metric.type=\"run.googleapis.com/container/memory/utilizations\"",
                    local.dashboard_base_filter[svc.key],
                  ])
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MEAN"
                    crossSeriesReducer = "REDUCE_MEAN"
                  }
                }
              }
              plotType       = "LINE"
              legendTemplate = "mean"
            },
            {
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = join(" AND ", [
                    "metric.type=\"run.googleapis.com/container/memory/utilizations\"",
                    local.dashboard_base_filter[svc.key],
                  ])
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MAX"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                }
              }
              plotType       = "LINE"
              legendTemplate = "max"
            },
          ]
          chartOptions = { mode = "COLOR" }
          yAxis        = { label = "utilization", scale = "LINEAR" }
        }
      },
      # 5. Instance count, broken out by active/idle. Cloud Run scales to zero
      #    here (min_instances = 0 by default), so this is the chart that shows
      #    cold-start/scale-up events and correlates directly with spend.
      {
        title = "${svc.label} — container instance count"
        xyChart = {
          dataSets = [{
            timeSeriesQuery = {
              timeSeriesFilter = {
                filter = join(" AND ", [
                  "metric.type=\"run.googleapis.com/container/instance_count\"",
                  local.dashboard_base_filter[svc.key],
                ])
                aggregation = {
                  alignmentPeriod    = "60s"
                  perSeriesAligner   = "ALIGN_MEAN"
                  crossSeriesReducer = "REDUCE_SUM"
                  groupByFields      = ["metric.label.state"]
                }
              }
            }
            plotType = "STACKED_AREA"
          }]
          chartOptions = { mode = "COLOR" }
          yAxis        = { label = "instances", scale = "LINEAR" }
        }
      },
    ]
  ])
}

resource "google_monitoring_dashboard" "app_overview" {
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "${local.monitoring_name_prefix} application overview"

    gridLayout = {
      columns = "2"
      widgets = local.dashboard_widgets
    }
  })
}
