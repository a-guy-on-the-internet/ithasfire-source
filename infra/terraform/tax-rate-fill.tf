# ═══════════════════════════════════════════════════════════════════════════════
# Cloud Tasks queue for venue sales-tax rate fills
#
# When a listing page meets a venue whose cached sales-tax rate is unknown, it
# enqueues ONE `tax.fill-location-rate` task. The job looks the rate up with
# ZipTax (up to two HTTP calls at a 5s timeout each, so ~10s per attempt) and
# writes it fill-if-unset onto the venue. On a provider error the job THROWS,
# so the non-2xx answer asks this queue for a retry.
#
# WHY ITS OWN QUEUE. The fill first rode the search-drain queue
# (search-reindex.tf), which is pinned to max_concurrent_dispatches = 1
# because two overlapping search DRAINS would read the same marks. Fills have
# no such constraint, and they fail in BURSTS: during a ZipTax rate-limit spell
# every listing page view of an unrated venue queues a fill, each of which
# spends up to ~10s failing and then retries. On the pinned queue those
# hundreds of slow failures would hold the single dispatch slot and delay
# every search-document drain behind them. A separate queue keeps a provider
# outage a tax-rate problem only.
#
# Everything else a task needs is already owned by search-reindex.tf: the
# cloudtasks.googleapis.com enablement, the wait for it to propagate, and the
# OIDC invoker service account (which holds roles/run.invoker on jobs).
# ═══════════════════════════════════════════════════════════════════════════════

locals {
  # Its own flag, with the same condition as local.search_drain_enabled and
  # local.lineup_sweep_queue_enabled. Same condition because the enqueuers are
  # the api and jobs runtimes and the only target is the jobs service, and
  # because the duplicated actAs grant below is only safe while all three
  # conditions match (see the NOTE at oidc_service_account_id, and the longer
  # one in lineup-notice-sweep.tf).
  tax_rate_fill_queue_enabled = var.jobs_image != null
}

module "tax_rate_fill_queue" {
  source = "./modules/cloud-tasks-queue"

  count = local.tax_rate_fill_queue_enabled ? 1 : 0

  project_id = var.project_id
  location   = local.jobs_region
  name       = "${local.jobs_name_prefix}-tax-rate-fill"

  # Five at a time. Fills for different venues are independent and the write
  # is fill-if-unset, so two fills of the SAME venue overlapping is safe too:
  # the second write finds the rate set and does nothing. The search drain's
  # 1-at-a-time pin would be pure head-of-line blocking here.
  #
  # Five rather than the Cloud Tasks default (1000) for two reasons. First,
  # CPU contention, as with the lineup queue: the jobs service runs Cloud
  # Run's default 80 requests per instance on one vCPU, so these dispatches
  # share an instance with cron and Pub/Sub push work rather than scaling out
  # past it. Second, the PROVIDER: ZipTax rate-limits us, and a wide fan-out
  # during a backlog is how we would trip that limit in the first place. Five
  # concurrent fills at ~10s each is about 0.5 lookups/s worst case, which
  # drains a burst of a few hundred unrated venues in minutes.
  max_concurrent_dispatches = 5

  # Attempts of ONE task, the first included. Four attempts with backoff
  # 30s -> 60s -> 120s spans about 3.5 minutes plus the attempts themselves,
  # long enough to outlast a short ZipTax rate-limit window without hammering
  # it: each retry waits at least 30s, doubling, so a spell of failures backs
  # off rather than piling more calls onto an already-limited key.
  #
  # Not more than four because a dropped fill costs little: the venue's rate
  # stays unknown and the next listing page view of it enqueues a fresh fill.
  # Retrying a long outage harder buys nothing that the next page view doesn't.
  max_attempts = 4
  min_backoff  = "30s"
  max_backoff  = "300s"

  enqueuer_service_accounts = merge(
    { jobs = module.jobs_service[0].runtime_service_account_email },
    var.api_image != null ? { api = module.api_service[0].runtime_service_account_email } : {},
  )

  # The task's OIDC identity: the same Cloud Scheduler invoker the search
  # drain and the lineup sweep use, which already holds roles/run.invoker on
  # the jobs service (main.tf).
  #
  # NOTE, read the full NOTE in lineup-notice-sweep.tf before changing any
  # enablement flag. The actAs grant (roles/iam.serviceAccountUser for each
  # enqueuer on that invoker) is the SAME membership the search-drain and
  # lineup-sweep modules already manage; google_service_account_iam_member is
  # additive set-membership, so all three converge on one binding. That is
  # harmless only while local.search_drain_enabled,
  # local.lineup_sweep_queue_enabled and local.tax_rate_fill_queue_enabled
  # share one condition. Making them differ requires FIRST hoisting the grant
  # into a single root-level resource and setting
  # grant_enqueuers_act_as_oidc = false on all three modules, under a reviewed
  # `terraform plan`.
  grant_enqueuers_act_as_oidc = true
  oidc_service_account_id     = google_service_account.jobs_scheduler_invoker.name

  depends_on = [time_sleep.wait_for_cloudtasks_api]
}

locals {
  # Merged into resolved_api_env and resolved_jobs_env (main.tf) ALONGSIDE
  # CLOUD_TASKS_QUEUE and CLOUD_TASKS_LINEUP_SWEEP_QUEUE, never instead of
  # them. Only the queue path is new: the invoker account
  # (CLOUD_TASKS_INVOKER_SA) and the task target (JOBS_SERVICE_URL for the
  # api, SEARCH_DRAIN_TARGET_URL for jobs) are already in both envs.
  #
  # Absent (every revision between the commit that reads this and the apply
  # that creates the queue), the app skips the enqueue: the rate stays unknown
  # until a later page view after the apply. Nothing falls back to the
  # search-drain queue.
  #
  # Same first-apply window as lineup-notice-sweep.tf: these locals depend on
  # the queue, not on its roles/cloudtasks.enqueuer members, so on the apply
  # that first creates the queue a new revision can enqueue before that grant
  # has propagated and get a 403. A fill lost that way is retried by the next
  # page view of the venue, so the window is accepted.
  tax_rate_fill_api_env = local.tax_rate_fill_queue_enabled ? {
    CLOUD_TASKS_TAX_FILL_QUEUE = module.tax_rate_fill_queue[0].id
  } : {}

  tax_rate_fill_jobs_env = local.tax_rate_fill_queue_enabled ? {
    CLOUD_TASKS_TAX_FILL_QUEUE = module.tax_rate_fill_queue[0].id
  } : {}
}
