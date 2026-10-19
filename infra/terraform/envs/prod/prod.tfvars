project_id = "hearthfire-491918"
region     = "us-east4"

# Image moderation (Azure Content Safety) flag threshold on the four-severity
# scale (0/2/4/6): a hero image with max severity >= this value is held for a
# human. 4 = flag "high"+. Endpoint/key are supplied via TF_VAR_* secrets.
image_moderation_review_threshold = 4

# Per-category moderation thresholds (decided 2026-08-20). SEXUAL/VIOLENCE high
# because gig posters score there honestly; HATE/SELF_HARM low because nothing
# legitimate does. Categories omitted here fall back to the threshold above.
image_moderation_category_thresholds = {
  SEXUAL    = 6
  VIOLENCE  = 6
  HATE      = 2
  SELF_HARM = 2
}

# Prod uses the apex domain in Cloudflare.
domain = "ithasfire.com"

environment = "prod"

# Enable Cloudflare-managed DNS records for this environment.
enable_cloudflare_dns = true

# Cloudflare zone for ithasfire.com (verified via API).
# Account ID is shared across environments.
cloudflare_zone_id    = "ae9fe4278faf52acd2a4a6cc66b1a1c8"
cloudflare_account_id = "5aa507bafe900581efbf2ca6eaece121"

# Edge security (cloudflare_security.tf; prod owns the zone-wide singletons).
# The zone is on the Free plan: 3 sign-up/sign-in requests per 10s per IP,
# then a 10s block (owner 2026-10-14: "ship the free plan rule"). The
# CLOUDFLARE_API_TOKEN GitHub secret needs "Zone WAF: Edit" before this
# applies; without it the apply 403s and blocks deploy_prod. Bot Fight Mode
# stays false: it would challenge Stripe/Resend/SNS webhooks and the native apps.
cloudflare_zone_plan              = "free"
enable_cloudflare_auth_rate_limit = true
enable_cloudflare_bot_fight_mode  = false

# www: proxied CNAME → ghs.googlehosted.com (Cloud Run domain mapping serves
# the web app) + edge 301 → apex for everything except /.well-known/* —
# Apple's AASA fetcher does not follow redirects, and the mobile app declares
# applinks:www.ithasfire.com.
additional_names = ["www"]

redirects = [
  {
    from_host             = "www.ithasfire.com"
    to_url                = "https://ithasfire.com"
    status_code           = 301
    exclude_path_prefixes = ["/.well-known/"]
  }
]

# stamp x-origin-secret at the edge, and reject requests without it (403).
# Turned on 2026-10-07 after prod logs showed no header-less callers besides
# the web startup probe and the deploy check, both fixed in 77152d641.
# Rollback: set enforce_origin_secret = false and run Redeploy prod.
enable_cloudflare_origin_secret_header = true
enforce_origin_secret                  = true

# Cloud Run services only deploy when images are set.
# deploy-prod.yml builds fresh images with prod URLs.
api_image  = "us-east4-docker.pkg.dev/hearthfire-491918/services/api:prod"
web_image  = "us-east4-docker.pkg.dev/hearthfire-491918/services/web:prod"
jobs_image = "us-east4-docker.pkg.dev/hearthfire-491918/services/jobs:prod"

# Scale to zero — accept cold starts (~2-3s) to save ~$137/mo.
# Flip back to 1 when you have consistent traffic.
api_min_instances = 0
web_min_instances = 0

# Cost kill-switch, CODIFIED. Keep prod dark (no public allUsers invoker on
# web/api) while pre-launch — so a terraform apply (e.g. the region cutover)
# does NOT wake prod. Was a manual gcloud override; now real config. Flip BOTH
# to true to launch prod. Tileserver stays public (scales to zero with no site
# traffic). See the "Prod cost kill switch" ops note + region-move runbook.
api_allow_unauthenticated = false
web_allow_unauthenticated = false

# Resource limits — API needs 1Gi to boot Prisma + Sentry + tRPC within probe window.
api_cpu = "1"
# 2Gi stopgap (owner, 2026-10-15): the tsx runtime OOM-killed 1Gi seven times
# in two days. The image runs a prebuilt bundle since 9e9333949, not tsx; back
# to 1Gi is the owner's call once prod runs that image.
api_memory = "2Gi"
web_cpu    = "1"
web_memory = "512Mi"


############################################
# Artifact Registry cleanup
############################################

# PROD OWNS the shared `services` Artifact Registry repo (single physical repo
# used by all envs). Only the owner workspace manages the resource + these
# cleanup policies; dev/other envs read it via a data source. This ends the old
# cross-workspace co-management (last-writer-wins) that broke the region move.
manage_shared_artifact_registry = true

# Enforce the cleanup policy that prunes UNTAGGED image layers older than 30d
# (tagged prod/dev/dev-<sha>/buildcache images are always kept). Without this
# the repo defaults to dry-run (report-only) and grows unbounded — it had hit
# 131 GB. Now that prod owns the repo, these cleanup settings are authoritative
# (dev's copies no longer manage the repo — the data source ignores them).
artifact_registry_cleanup_dry_run = false


############################################
# External services
############################################

# Provision Neon so API/Jobs can auto-wire DATABASE_URL.
enable_neon = true
neon_org_id = "org-restless-art-83204534"

# Upstash Redis — free tier only allows 1 database (dev already provisions one).
# Prod shares the dev Redis instance but uses "ithasfire:prod" namespace prefix.
# TODO: upgrade Upstash to pay-as-you-go to provision a dedicated prod Redis.
enable_upstash         = false
upstash_region         = "global"
upstash_primary_region = "us-east-1"
upstash_read_regions   = []

# AWS: US SMS through AWS End User Messaging (SNS Publish to phone numbers).
# enable_aws creates the IAM sender user (keys land in Secret Manager as
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), the account SMS preferences and
# the inbound STOP/START topic + HTTPS subscription to the API. It does NOT
# bring SES back: SES needs enable_ses too, and mail goes via Resend.
# OFF until AWS approves the 10DLC campaign and production access (SMS
# sandbox exit, spend-limit raise).
# To turn on, the owner sets (plan needs the GitHub secrets
# TF_VAR_AWS_ACCESS_KEY_ID / TF_VAR_AWS_SECRET_ACCESS_KEY, which feed
# TF_VAR_aws_access_key_id / TF_VAR_aws_secret_access_key):
#   enable_aws                        = true
#   enable_ses                        = false
#   aws_sms_origination_otp           = "+1XXXXXXXXXX" # registered US number (10DLC or toll-free)
#   aws_sms_origination_notifications = "+1XXXXXXXXXX" # the same number is the expected setup
#   aws_sms_monthly_spend_limit       = 1 # never above the approved SMS spend quota
#   aws_manage_sms_preferences        = true # false in one env if dev and prod share an AWS account
# The phone number is NOT managed by Terraform (requested and tied to the
# 10DLC campaign in the console). After the first apply with enable_aws, the
# owner links its two-way channel to the inbound topic once, or STOP/START
# replies never reach the API:
#   terraform output aws_sms_inbound_topic_arn
#   aws pinpoint-sms-voice-v2 update-phone-number --phone-number-id <id> \
#     --two-way-enabled --two-way-channel-arn <aws_sms_inbound_topic_arn>
# (No --two-way-channel-role: the topic policy already lets
# sms-voice.amazonaws.com publish for this account.)
# The HTTPS subscription is created only while api_allow_unauthenticated =
# true: STOP/START replies reach the API once it is public, and until then AWS
# still enforces STOP on its own opt-out list.
# The sender user, the phone numbers and the 10DLC registrations must all be
# in the AWS account Terraform's aws provider credentials target.
enable_aws     = false
ses_from_email = "no-reply@ithasfire.com"


############################################
# Meilisearch (Search)
############################################

# Retired: search runs on Postgres (SEARCH_BACKEND = "postgres"); nothing calls
# the Meilisearch-backed SearchQueryPort anymore (getRandomEvent moved to a
# Postgres repo query). An earlier attempt to flip this false failed the apply
# because api/jobs referenced the MEILISEARCH_API_KEY secret through the
# time_sleep IAM chain, which desyncs on teardown (destroys the secret while the
# service still references it). Fixed by DECOUPLING api/jobs from the Meili
# secret + MEILISEARCH_HOST (secrets.tf + main.tf); the meili data bucket is now
# force_destroy=true in all envs. Teardown is a single clean apply.
enable_meilisearch = false


############################################
# Tileserver (self-hosted map tiles)
############################################

enable_tileserver          = true
tileserver_image           = "us-east4-docker.pkg.dev/hearthfire-491918/services/tileserver:prod"
tileserver_name            = "tiles-prod"
tileserver_allowed_origins = "https://ithasfire.com,https://www.ithasfire.com"


############################################
# Database backups (pg_dump → GCS)
# Spec: docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md
# Runbook: docs/runbooks/db-backup-restore.md
############################################

# Storage layer (bucket hf-prod-db-backups, CMEK, SA, Pub/Sub topic).
enable_db_backups = true

# Cloud Run Jobs + Scheduler triggers activate once an image tag is pinned.
# Built + pushed 2026-06-12 via pg-dump-image.yml (tag v1). Pinned tag,
# never :latest — bump the tag to roll the image.
db_backup_image = "us-east4-docker.pkg.dev/hearthfire-491918/services/pg-dump:v1"

# IRREVERSIBLE once true (GCS Bucket Lock). Flip after the first successful
# restore drill confirms the pipeline end-to-end.
db_backup_lock_retention = false


############################################
# Monitoring (uptime checks + alerting)
# See monitoring.tf
############################################

# HTTPS uptime checks for api.ithasfire.com/health + ithasfire.com/ and the
# alert policies on uptime failure + Stripe webhook DLQ writes.
enable_uptime_checks = true

# MONITORED, despite the name: noreply@ithasfire.com REDIRECTS to the
# operator's real inbox (confirmed 2026-08-22). Do NOT "fix" this to another
# address on the assumption that a no-reply@ is a dead end — that would move
# alerting off a channel that works. Cloud Monitoring sends a confirmation
# email to this address when the notification channel is created; it has to
# be clicked once for the channel to go active.
alerts_email = "noreply@ithasfire.com"


############################################
# Jobs (Cloud Run)
############################################

# S3-compatible storage (shared bucket for API + Jobs)
storage_s3_bucket_name = "hf-prod-storage"
storage_s3_public_read = false
# Public read base URL for public objects (event hero images, etc.). Served by
# the Cloudflare R2 custom domain bound to the hf-prod-storage bucket. Required:
# the S3/R2 adapter throws `public_base_url_not_configured` on public uploads
# when unset, and the API now refuses to boot in prod without it.
storage_s3_public_base_url = "https://cdn.ithasfire.com"


############################################
# API + Web + Jobs env vars
############################################

api_env = {
  NODE_ENV                    = "production"
  APP_BASE_URL                = "https://api.ithasfire.com"
  PUBLIC_WEB_URL              = "https://ithasfire.com"
  SUPPORT_URL                 = "https://ithasfire.com/help"
  BETTER_AUTH_BASE_URL        = "https://api.ithasfire.com"
  BETTER_AUTH_JWKS_URL        = "https://api.ithasfire.com/api/auth/jwks"
  BETTER_AUTH_TRUSTED_ORIGINS = "https://ithasfire.com,https://www.ithasfire.com,https://api.ithasfire.com"
  # Explicit cross-subdomain session cookie domain. Prod ONLY: web
  # (ithasfire.com) + api (api.ithasfire.com) share this registrable parent, so
  # the session cookie is scoped to it. Deliberately NOT set on dev — dev + prod
  # both live under ithasfire.com, so a shared Domain= would collide across envs.
  SESSION_COOKIE_DOMAIN = ".ithasfire.com"
  # SESSION_COOKIE_PREFIX is intentionally UNSET on prod: prod keeps Better
  # Auth's default `better-auth` cookie name. Setting it would rename — and thus
  # invalidate — every live prod session cookie (mass sign-out) and re-trigger
  # the ghost host-only-cookie problem. The dev/prod cookie collision on the
  # shared .ithasfire.com domain is solved by prefixing DEV instead (see
  # dev.tfvars SESSION_COOKIE_PREFIX = "better-auth-dev").
  CORS_ALLOWED_ORIGINS    = "https://ithasfire.com,https://www.ithasfire.com"
  STRIPE_API_VERSION      = "2025-08-27.basil"
  PRODUCT_NAME            = "Ithas Fire"
  SEARCH_BACKEND          = "postgres"
  AWS_REGION              = "us-east-1"
  SMTP_HOST               = "email-smtp.us-east-1.amazonaws.com"
  SMTP_PORT               = "587"
  SMTP_SECURE             = "true"
  SMTP_DEFAULT_FROM_EMAIL = "no-reply@ithasfire.com"
  SMTP_APP_HEADER         = "Ithas Fire"

  # Idempotency keys live in Postgres, not Redis. Prod's Upstash is the free
  # tier (500K commands/month — see the REDIS_URL note below), and
  # `RedisIdempotency` does NOT fail open: when the quota is exhausted the
  # ReplyError propagates through `toTrpcError` and 500s every mutation that
  # takes an idempotency key (2026-07-28: `events.createEventForHuman`).
  # `PrismaIdempotencyAdapter` (apps/api/src/lib/dep.ts) has no such cliff.
  # Revisit only when real write volume makes the Postgres round-trip hurt.
  IDEMPOTENCY_BACKEND = "postgres"

  # site-wide per-IP tRPC budget: shadow logs would-deny without blocking; flip to enforce after reviewing global_rate_limit_would_deny logs/metrics
  TRPC_GLOBAL_RATE_LIMIT_MODE = "shadow"

  # Heap cap for the 2Gi instances. The image defaults to
  # --max-old-space-size=700 (sized for 1Gi; apps/api/Dockerfile explains).
  # 1048 is what V8 picks on its own at 2Gi, so prod keeps today's heap until
  # it is measured on the bundled image. Drop this with the 2Gi -> 1Gi revert
  # (api_memory above).
  NODE_OPTIONS = "--max-old-space-size=1048"

  # NOTE: sensitive values (REDIS_URL, UNSUBSCRIBE_SECRET, DB URLs, OAuth
  # client secrets, etc.) live in Secret Manager and are injected via
  # secret_env from secrets.tf. Do NOT add credentials to this api_env map —
  # plain env on Cloud Run is visible to anyone with run.viewer, and a
  # duplicate name between api_env and secret_env causes Cloud Run to reject
  # the service template.
  #
  # REDIS_URL: prod runs with enable_upstash=false (Upstash was provisioned
  # out-of-band on the free tier). The connection URL flows through CI as
  # TF_VAR_REDIS_URL_PROD → var.redis_url → secrets.tf catalog → Secret
  # Manager → api/jobs/web secret_env.
}

# NOTE: WEB_API_BASE_URL is intentionally NOT set here. It is injected in
# main.tf (resolved_web_env) as a Terraform reference to the api_service
# Cloud Run *.run.app URL so web's SSR tRPC calls stay inside Google's network
# (same region) instead of hairpinning out through Cloudflare. Hardcoding it
# here would (a) shadow that reference (var.web_env merges last) and (b) break
# when compute moves region. Browser calls still use the public
# NEXT_PUBLIC_API_BASE_URL baked in at build (deploy-prod.yml).
web_env = {
  NODE_ENV                    = "production"
  NEXT_PUBLIC_SITE_URL        = "https://ithasfire.com"
  NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.ithasfire.com"
}

jobs_env = {
  NODE_ENV       = "production"
  SEARCH_BACKEND = "postgres"
  # REDIS_URL is inherited from the existing API env so the live secret remains
  # single-sourced while the jobs service still gets the same connection string.

  # Same reasoning as api_env.IDEMPOTENCY_BACKEND above — jobs takes the
  # Prisma adapter too (apps/jobs/src/lib/container.ts).
  IDEMPOTENCY_BACKEND = "postgres"

  # Job-run history goes to Postgres (`PostgresJobRunTracker`, migration
  # 20260513120000_job_run_tracker_postgres) instead of Redis sorted sets.
  #
  # This is the single biggest Redis consumer in the stack: `record()` bills
  # FOUR commands per run (MULTI + ZADD + ZREMRANGEBYRANK + EXEC) on top of
  # one HGET for `isEnabled()`. Measured over 24h on 2026-07-28, job-run
  # bookkeeping was ~91% of ALL Redis commands — enough on its own to exhaust
  # the 500K/month free tier. Two secondary wins: `latestAll()` stops doing a
  # full-keyspace SCAN on every /jobs/status poll (30s from the platform
  # page), and run history survives a Redis flush.
  JOB_TRACKER_BACKEND = "postgres"
}

# ─────────────────────────────────────────────────────────────────────────────
# Scheduler cadence overrides (prod only)
# ─────────────────────────────────────────────────────────────────────────────
#
# jobs.manifest.json crons were first tuned for dev, where fast ticks made
# manual testing bearable. Prod did not need them: at the time these cadences
# were burning ~3,591 Cloud Run invocations/day — each booting a container and
# opening a Neon connection — with six jobs accounting for 84% of that.
# The overrides below take prod to ~1,640/day.
#
# NEON SLEEP (2026-09-30). Production Postgres (Neon) suspends after ~5 min
# idle and bills per awake compute-hour, so what matters is how many DISTINCT
# wake-ups the schedule causes, not how many jobs run. Every sub-hourly job
# sits on :00/:30 and every hourly one on :00, so they share wake-ups.
# The three outbox drains (RSVP confirmations, event-change notices, image
# moderation) are write-triggered through Pub/Sub (`triggerTopic` in the
# manifest); their manifest cron is only the */30 safety net, so they carry no
# override here any more. Nor do the cart/hold reapers: their cadence lives in
# the manifest, because the cart reaper's period is load-bearing for capacity
# accounting (packages/core/src/use-cases/orders/_shared/cart-reaper-cycle.ts)
# and validate-manifest now REFUSES a per-env override of it.
#
# 2026-10-08: every */15 manifest cron moved to */30 so Neon can sleep between
# slots; dev and prod now share that cadence (one manifest, no fast lane).
# An abandoned cart now holds its tickets for up to 80 minutes (was 50).
#
# ⚠️  DO NOT OVERRIDE the volunteer reminders: each window is sized against
# its */30 tick in code (send-volunteer-shift-reminders.ts DEFAULT_BAND_MS).
# Slowing the cron alone silently drops reminders for shifts between ticks.

# Jobs needs 1Gi to boot with the Sentry SDK loaded. At Cloud Run's 512Mi
# default the container heap-OOMs during startup (verified 2026-09-05, exit 134)
# and the revision never passes its probe. Cost is negligible: jobs is
# minScale=0 with request-based billing, ~1,635 runs/day at ~0.1s each — under
# 1% of Cloud Run spend ($0.90/mo of $124 in the 30d to 2026-08-25).
jobs_memory = "1Gi"

jobs_scheduler_overrides = {
  # Materialized stats — no latency contract at all.
  "places.recalculate-place-stats" = { cron = "0 */2 * * *" }

  # Deletion outbox has exponential backoff + dead-lettering; nothing
  # user-visible waits on it.
  "storage.drain-pending-deletions" = { cron = "0 * * * *" }

  # Expo only publishes receipts ~15min after the send ticket and retains
  # them 24h, so a 15min poll was always racing its own source of truth.
  "push.drain-receipts" = { cron = "0 * * * *" }

  # Idempotent via the per-event addressRevealNotifiedAt cursor, so a wider
  # tick costs reveal-notification latency and nothing else.
  "events.address-reveal-notify" = { cron = "*/30 * * * *" }
}


############################################
# Audio Transcoder (Cloud Run — MP3 → HLS)
############################################

audio_transcoder_image         = "us-east4-docker.pkg.dev/hearthfire-491918/services/audio-transcoder:prod"
audio_transcoder_cpu           = "2"
audio_transcoder_memory        = "2Gi"
audio_transcoder_max_instances = 5
# Scale to zero (owner, 2026-10-17). The warm instance this used to hold cost
# $25.82 in 30 days for 3 uploads, 88% of prod's Cloud Run bill.
#
# The cold start (~20-30s: Cloud Run pulls an ffmpeg image and boots node) is
# hidden instead of paid for: when an organiser STARTS an upload, the API
# publishes a warm message to the transcode topic (`warmTranscoder`,
# packages/transport/trpc/src/routers/events.ts) and /pubsub/push acks it
# without work. The instance boots while the browser PUTs the file, so it is up
# by the time finalize dispatches the transcode.
#
# Back to 1 only if uploads stop overlapping the boot (a cold transcode showing
# up as extra resolveAudio spinner ticks) and the bill is worth it.
audio_transcoder_min_instances = 0

# Same R2 bucket as API/Jobs — credentials via TF_VAR_* env vars.
# Endpoint/keys/public-base-url fall through to the storage_s3_* values above.
audio_transcoder_s3_bucket_name = "hf-prod-storage"

audio_transcoder_env = {
  NODE_ENV = "production"
}

# ── Apple Wallet ─────────────────────────────────────────────────────────────
# Public identifiers only — the signing cert + its password are secrets and
# arrive via TF_VAR_apple_pass_certificate_p12_base64 / _password.
#
# Team FJG7F43395 is the business account. Do NOT use 5J9DRDR2TB (the burned
# original team): the .pkpass `teamIdentifier` must match the team that issued
# the signing certificate, or iOS rejects the pass with no useful error.
apple_team_id              = "FJG7F43395"
apple_pass_type_identifier = "pass.com.ithasfire.ticket"

# ── Google Wallet ────────────────────────────────────────────────────────────
# DELIBERATELY THE SAME ISSUER AS DEV. Google's publishing approval is granted
# per issuer, so a separate prod issuer would mean a second review with its own
# wait — prod would stay in demo mode (passes only save for allowlisted test
# accounts) even after dev's approval landed.
#
# Sharing is safe here because class IDs are derived per event as
# `{issuerId}.ithasfire_event_{eventId}` (see google-wallet-adapter.ts), and
# dev and prod have separate databases, so event IDs never collide.
#
# The tradeoff, accepted knowingly: dev test passes and real customer passes
# live under one issuer, so a suspension would take out both. If that ever
# matters more than the approval wait, register a second issuer, add
# `hf-prod-api-runtime@...` to its Users tab (console-only — the `permissions`
# API 403s unless the caller is already an authorized user), and point this
# at it.
#
# `hf-prod-api-runtime@hearthfire-491918.iam.gserviceaccount.com` is already a
# writer on this issuer. Enabling this also makes prod the owner of the
# `walletobjects` API enablement (project-level singleton shared with dev) —
# see main.tf.
enable_google_wallet    = true
google_wallet_issuer_id = "3388000000023116217"
