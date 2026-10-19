# ═══════════════════════════════════════════════════════════════════════════════
# Cloud Tasks queue for lineup-notice sweep continuations
#
# A post-publish lineup-notice sweep that runs out of its 10s request budget
# asks Cloud Tasks for ONE delayed `lineup-notices.continue-sweep` run (the
# task name is the dedupe key). That run sweeps the same event with a 60s
# budget and queues the next attempt while rows remain, up to
# LINEUP_SWEEP_MAX_CONTINUATIONS = 5 hops
# (packages/core/src/use-cases/event-humans/_shared/lineup-sweep-continuation.ts).
# The API enqueues the first hop, the jobs service the rest.
#
# WHY ITS OWN QUEUE. Until this file the continuation rode the search-drain
# queue (search-reindex.tf), which is pinned to max_concurrent_dispatches = 1
# because two overlapping search DRAINS would read the same marks. Lineup
# sweeps have no such constraint — a sweep claims each row in the OWED/SENT
# ledger before sending, so overlapping runs tell nobody twice, except through
# the one duplicate window the feature accepts on purpose (a sender killed
# between the send and `commit(sentKey)` leaves no claim and no record; the
# claim lapses at 300s and a later run tells that person again — see "The one
# duplicate window, accepted" in
# packages/core/src/use-cases/event-humans/notify-lineup-notices.ts). But the
# pin bound them anyway: one continuation can hold the single dispatch slot for
# its whole dispatch deadline (300s), so search-document drains queued behind
# lineup work and lineup work behind drains.
#
# Everything else a task needs is already owned by search-reindex.tf: the
# cloudtasks.googleapis.com enablement, the wait for it to propagate, and the
# OIDC invoker service account (which holds roles/run.invoker on jobs).
# ═══════════════════════════════════════════════════════════════════════════════

locals {
  # Its own flag, with the same condition as local.search_drain_enabled. Same
  # condition because the enqueuers are the api and jobs runtimes and the only
  # target is the jobs service — there is nothing to create in a workspace
  # without a jobs image, and because the duplicated actAs grant below is only
  # safe while the two conditions match. Its own NAME so this queue can be
  # gated differently (or switched off) later without editing the search
  # drain's count, and so neither flag misleads a reader about which subsystem
  # it governs — but read the actAs NOTE before making them differ.
  lineup_sweep_queue_enabled = var.jobs_image != null
}

module "lineup_notice_sweep_queue" {
  source = "./modules/cloud-tasks-queue"

  count = local.lineup_sweep_queue_enabled ? 1 : 0

  project_id = var.project_id
  location   = local.jobs_region
  name       = "${local.jobs_name_prefix}-lineup-notice-sweep"

  # Five at a time. Sweeps of different events are independent, and a sweep
  # claims each row in the ledger before sending, so overlap is safe rather
  # than merely tolerated — the search drain's 1-at-a-time pin would be pure
  # head-of-line blocking here.
  #
  # Five rather than the Cloud Tasks default (1000) to bound CPU CONTENTION,
  # not instance count. The jobs service sets no
  # max_instance_request_concurrency, so Cloud Run's default of 80 requests per
  # instance applies: these dispatches do NOT each occupy an instance — all
  # five can land on ONE, sharing its single vCPU (`cpu` is unset at the
  # module call in main.tf) with whatever cron and Pub/Sub push jobs are
  # running there, under request-based billing (cpu_idle = true). Each
  # continuation can spend up to 60s of wall clock starting sends, so an
  # unbounded burst of large-lineup publishes would be CPU-starving its
  # neighbours on that instance, not scaling out past them. Do NOT read the
  # service's max_instance_count = 10 as a licence for ten dispatches.
  #
  # A chain has at most one live task per (event, attempt), so 5 is already
  # five simultaneous overflowing publishes.
  max_concurrent_dispatches = 5

  # Attempts of ONE task. A different axis from the chain's
  # LINEUP_SWEEP_MAX_CONTINUATIONS = 5 hops, which the queue cannot see at all
  # (each hop is a separate task, bounded by the `attempt` in its payload);
  # the two numbers agreeing is a coincidence, not a constraint.
  #
  # Five here on its own merit: the continuation job deliberately answers
  # non-2xx on `unfinished` — rows left AND the next hop refused by the
  # scheduler (apps/jobs/src/jobs/lineup-notices.ts) — to ask for exactly this
  # retry, which is then the last route the owed rows have to being told. Every
  # rerun is safe (a row already told carries its SENT claim), so an extra
  # attempt costs ledger reads. With the backoff below, 5 attempts ride out
  # roughly 12 minutes of a wedged jobs service.
  #
  # A retry CAN FORK THE CHAIN, accepted. The dedupe key is
  # lineup-sweep-<event>-<attempt>-<slot> quantized to 30s slots, so a
  # dispatch of attempt N that outlives the 300s deadline AFTER it queued
  # N + 1 will, when retried, queue a second N + 1 in a different slot — two
  # chains from one attempt. (Two publishes of one event falling in different
  # slots reach the same shape at attempt 1.) With the pin lifted from 1 to 5
  # the forks now run concurrently rather than serialized. No row is told
  # twice regardless (the SENT claim is atomic, bar the accepted window noted
  # at the top of this file) and each fork is still capped at 5 hops, so the
  # cost is ledger reads. Do NOT "fix" this by shortening the dispatch
  # deadline: that trades "the handler may still be running" for guaranteed
  # concurrent hops of the SAME attempt, which is worse.
  max_attempts = 5
  min_backoff  = "60s"
  max_backoff  = "300s"

  enqueuer_service_accounts = merge(
    { jobs = module.jobs_service[0].runtime_service_account_email },
    var.api_image != null ? { api = module.api_service[0].runtime_service_account_email } : {},
  )

  # The task's OIDC identity — the same Cloud Scheduler invoker the search
  # drain uses, which already holds roles/run.invoker on the jobs service
  # (main.tf). A second identity would buy nothing: both queues target the
  # same service and the same /jobs/<name> handler shape.
  #
  # NOTE, read this before changing either enablement flag. The actAs grant
  # this flag creates (roles/iam.serviceAccountUser for each enqueuer on that
  # invoker) is the SAME membership the search-drain queue's module manages.
  # google_service_account_iam_member is additive set-membership, so both
  # resources converge on one binding and the second create is a no-op.
  #
  # That duplicate is HARMLESS TODAY and only today, because
  # local.search_drain_enabled and local.lineup_sweep_queue_enabled are the
  # same condition (var.jobs_image != null): the two modules enable and
  # disable together, so neither can be destroyed while the other still
  # believes it owns the membership. Give the flags different conditions — the
  # very divergence the separate name below invites — and the apply that
  # disables one drops a binding the other's state says exists. The surviving
  # queue's enqueues then fail actAs with PERMISSION_DENIED, which the adapter
  # surfaces as `cloud_tasks_create_failed: 403` -> "failed" -> `outcome:
  # "unfinished"`, so the job 500s through all 5 attempts and the leftover
  # rows stay OWED until the next apply restores the binding.
  #
  # Whoever makes the flags differ must FIRST hoist this grant into a single
  # root-level resource and set grant_enqueuers_act_as_oidc = false on both
  # modules. That is a destroy+create of the same IAM membership, so it needs
  # a reviewed `terraform plan` — it is not a blind edit.
  grant_enqueuers_act_as_oidc = true
  oidc_service_account_id     = google_service_account.jobs_scheduler_invoker.name

  depends_on = [time_sleep.wait_for_cloudtasks_api]
}

locals {
  # Merged into resolved_api_env and resolved_jobs_env (main.tf) ALONGSIDE
  # CLOUD_TASKS_QUEUE, never instead of it: that one is still the search
  # drain's, for both services.
  #
  # Only the queue path is new — the invoker account (CLOUD_TASKS_INVOKER_SA)
  # and the task target (JOBS_SERVICE_URL for the api, SEARCH_DRAIN_TARGET_URL
  # for jobs) are already in both envs.
  #
  # Absent — every revision between the commit that reads this and the apply
  # that creates the queue — the continuation falls back to the search-drain
  # scheduler, i.e. the behaviour it already had, not a dropped continuation.
  # See createLineupSweepContinuation
  # (packages/adapters/src/queue/cloud-tasks-scheduler.ts).
  #
  # ACCEPTED FIRST-APPLY WINDOW (orchestrator ruling, 2026-10-02; do not
  # restructure for it). These locals depend on the queue, NOT on its
  # roles/cloudtasks.enqueuer members, so on the apply that FIRST creates the
  # queue a new revision can start enqueuing before that grant has
  # propagated. A publish that overflows in that window gets a 403 ->
  # `failed` -> reported (sweep_continuation_schedule_failed +
  # sweep_budget_exhausted), and its leftover rows stay OWED for a later
  # publish of the event; a continuation run hit by it throws, so the queue
  # that delivered that run retries it per its own retry config. Later applies change
  # nothing here, so it is a first-apply-only window. Do not expect the
  # fallback to cover it: createLineupSweepContinuation falls back to the
  # search-drain scheduler only when the env var is MISSING, never on a 403.
  lineup_sweep_api_env = local.lineup_sweep_queue_enabled ? {
    CLOUD_TASKS_LINEUP_SWEEP_QUEUE = module.lineup_notice_sweep_queue[0].id
  } : {}

  lineup_sweep_jobs_env = local.lineup_sweep_queue_enabled ? {
    CLOUD_TASKS_LINEUP_SWEEP_QUEUE = module.lineup_notice_sweep_queue[0].id
  } : {}
}
