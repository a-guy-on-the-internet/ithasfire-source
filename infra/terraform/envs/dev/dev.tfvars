project_id = "hearthfire-491918"
region     = "us-east4"
domain     = "ithasfire.com"

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

# Enable Cloudflare-managed DNS records for this environment.
enable_cloudflare_dns = true

# Edge cache-settings ruleset is a per-zone singleton and dev shares the
# ithasfire.com zone with prod — let prod own it. Dev hosts fall through to
# default cache behavior (host-scoped rules wouldn't match dev anyway).
enable_cloudflare_cache_rules = false

# Required when enable_cloudflare_dns = true (supply via TF_VAR_* env vars or set here).
# Prefer env vars via infra/.env.local:
# - TF_VAR_cloudflare_zone_id
# - TF_VAR_cloudflare_account_id
# - TF_VAR_cloudflare_api_token
cloudflare_zone_id    = "ae9fe4278faf52acd2a4a6cc66b1a1c8"
cloudflare_account_id = "5aa507bafe900581efbf2ca6eaece121"

# Cloud Run services only deploy when images are set.
# For CI/CD deploys, point Terraform at a stable tag and have the deploy pipeline
# push a new image to that same tag.
api_image  = "us-east4-docker.pkg.dev/hearthfire-491918/services/api:dev"
web_image  = "us-east4-docker.pkg.dev/hearthfire-491918/services/web:dev"
jobs_image = "us-east4-docker.pkg.dev/hearthfire-491918/services/jobs:dev"

# Dev stays publicly reachable (default is true; explicit here for symmetry with
# prod.tfvars, which sets these false to keep prod dark). See variables.tf.
api_allow_unauthenticated = true
web_allow_unauthenticated = true

# Bump api memory above default 512Mi — startup hits an OOM during wasm
# instantiation (likely via a Tamagui/Next dependency chain). 1Gi is the
# next sensible step; revisit if startup memory leaks become a problem.
api_memory = "1Gi"


############################################
# Artifact Registry cleanup
############################################

# dev does NOT own the shared `services` Artifact Registry repo — prod owns it
# (manage_shared_artifact_registry = true in prod.tfvars) and dev reads it via a
# data source. So these cleanup settings are INERT for dev (the data source
# can't mutate the repo); prod's copies are authoritative. Kept only for
# symmetry / if dev ever becomes the owner.
manage_shared_artifact_registry   = false
artifact_registry_cleanup_dry_run = false


# Provision Neon so API/Jobs can auto-wire DATABASE_URL.
enable_neon = true
# Upstash Redis is provisioned out-of-band on the free tier (1 DB shared by
# dev + prod); Terraform does NOT manage it — matches prod. The connection URL
# flows through CI as TF_VAR_REDIS_URL_DEV → var.redis_url → Secret Manager.
enable_upstash         = false
neon_org_id            = "org-restless-art-83204534"
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

environment = "dev"


############################################
# Meilisearch (Search)
############################################

# Retired: search runs on Postgres (SEARCH_BACKEND = "postgres"). Nothing depends
# on the Meilisearch-backed SearchQueryPort anymore (getRandomEvent moved to a
# Postgres repo query). Disabling drops MEILISEARCH_* env + the Meili module.
#
# The first 06b30fad apply half-completed (destroyed the meili secret IAM binding
# + service but never rolled the api/jobs revisions, which still mounted the
# now-inaccessible secret → dev API outage) because api/jobs referenced the
# MEILISEARCH_API_KEY secret through the time_sleep IAM chain, which desyncs on
# teardown. Fixed by DECOUPLING: api/jobs no longer reference the Meili secret or
# MEILISEARCH_HOST at all (secrets.tf + main.tf), so this flag can flip false and
# tear down the service/secret/bucket in one clean apply.
enable_meilisearch = false


############################################
# Tileserver (self-hosted map tiles)
############################################

enable_tileserver          = true
tileserver_image           = "us-east4-docker.pkg.dev/hearthfire-491918/services/tileserver:dev"
tileserver_name            = "tiles-dev"
tileserver_allowed_origins = "https://*.ithasfire.com,http://localhost:3000,http://localhost:3001"


############################################
# Monitoring (uptime checks + alerting)
# See monitoring.tf
############################################

# Off in dev: api/web scale to zero, so cold starts would flap the uptime
# probes. The Stripe-webhook-failure log metric + alert policy still exist
# (scoped to hf-dev-api logs) but only notify when alerts_email is set.
enable_uptime_checks = false

# MONITORED, despite the name: noreply@ithasfire.com REDIRECTS to the
# operator's real inbox (confirmed 2026-08-22). Set null to skip the email
# notification channel entirely; alert policies are still created either way.
alerts_email = "noreply@ithasfire.com"


############################################
# Jobs (Cloud Run)
############################################

# Per-task scheduler overrides (optional).
# See generated-jobs.tf for definitions.


############################################
# S3-compatible storage (shared bucket for API + Jobs)
############################################

storage_s3_bucket_name = "hf-dev-storage"
storage_s3_public_read = false
# Public read base URL for public objects (event hero images, etc.). Served by
# the Cloudflare R2 custom domain bound to the hf-dev-storage bucket. See prod
# tfvars for why this is required (adapter throws / API refuses to boot without it).
storage_s3_public_base_url = "https://cdn-dev.ithasfire.com"


############################################
# API + Web + Jobs env vars
############################################

api_env = {
  NODE_ENV                    = "production"
  APP_BASE_URL                = "https://api-dev.ithasfire.com"
  PUBLIC_WEB_URL              = "https://web-dev.ithasfire.com"
  SUPPORT_URL                 = "https://web-dev.ithasfire.com/help"
  BETTER_AUTH_BASE_URL        = "https://api-dev.ithasfire.com"
  BETTER_AUTH_JWKS_URL        = "https://api-dev.ithasfire.com/api/auth/jwks"
  BETTER_AUTH_TRUSTED_ORIGINS = "https://web-dev.ithasfire.com,https://api-dev.ithasfire.com"
  # Cross-subdomain session cookie is ENABLED on dev so the web-dev origin can
  # read the api-dev session (fixes the /admin server-side session check that
  # was bounced to /sign-in under the old host-only cookie). dev + prod both
  # live under the ithasfire.com registrable parent, so a shared Domain= alone
  # would clobber across envs — dev is isolated from prod NOT by domain but by a
  # DISTINCT cookie-name prefix (SESSION_COOKIE_PREFIX below). Prod keeps the
  # default `better-auth` prefix; dev's `better-auth-dev` never collides.
  SESSION_COOKIE_DOMAIN   = ".ithasfire.com"
  SESSION_COOKIE_PREFIX   = "better-auth-dev"
  CORS_ALLOWED_ORIGINS    = "https://web-dev.ithasfire.com"
  STRIPE_API_VERSION      = "2025-08-27.basil"
  PRODUCT_NAME            = "Ithas Fire"
  SEARCH_BACKEND          = "postgres"
  AWS_REGION              = "us-east-1"
  SMTP_HOST               = "email-smtp.us-east-1.amazonaws.com"
  SMTP_PORT               = "587"
  SMTP_SECURE             = "true"
  SMTP_DEFAULT_FROM_EMAIL = "no-reply@ithasfire.com"
  SMTP_APP_HEADER         = "Ithas Fire"

  # site-wide per-IP tRPC budget: shadow logs would-deny without blocking; flip to enforce after reviewing global_rate_limit_would_deny logs/metrics
  TRPC_GLOBAL_RATE_LIMIT_MODE = "shadow"
}

# NOTE: WEB_API_BASE_URL is intentionally NOT set here. It is injected in
# main.tf (resolved_web_env) as a Terraform reference to the api_service
# Cloud Run *.run.app URL so web's SSR tRPC calls stay inside Google's network
# (same region) instead of hairpinning out through Cloudflare. Hardcoding it
# here would (a) shadow that reference (var.web_env merges last) and (b) break
# when compute moves region. Browser calls still use the public
# NEXT_PUBLIC_API_BASE_URL baked in at build (deploy-dev.yml).
web_env = {
  NODE_ENV                    = "production"
  NEXT_PUBLIC_SITE_URL        = "https://web-dev.ithasfire.com"
  NEXT_PUBLIC_BETTER_AUTH_URL = "https://api-dev.ithasfire.com"
}

jobs_env = {
  NODE_ENV       = "production"
  SEARCH_BACKEND = "postgres"
}

# The nightly Connect reconcile is DISABLED on dev, deliberately.
#
# It re-reads each connected account from LIVE Stripe and writes the truth back.
# Dev's payees are seeded Stripe Custom accounts that never complete onboarding,
# so on dev the truth is "cannot take charges, cannot receive transfers" — the
# sweep would demote every seeded payee to PENDING/false at 22:20 and make every
# seeded paid event unpublishable and unsellable the next morning.
#
# It cannot be neutralised with STRIPE_CONNECT_FORCE_CAPABILITIES either: that
# flag is hard-`false` whenever NODE_ENV=production, which dev sets (above). That
# guarantee is worth keeping — it is what makes it impossible to accidentally
# mark every production account payable — so dev opts out of the job instead.
#
# Prod is the environment that actually needs the backstop, and it runs there.
# Jobs needs 1Gi to boot, same as prod. At Cloud Run's 512Mi default the
# container heap-OOMs during startup and the revision never passes its probe —
# the failure `var.jobs_memory`'s own description has documented since
# 2026-09-05 (exit 134 at ~247MB). Prod was given 1Gi then; dev was not, and
# had been coasting just under the ceiling ever since.
# 007d64e4 pushed it over: measured on revision hf-dev-jobs-00027-f8h,
# `migration_drift_check_ok` then OOM at 30.2s with Mark-Compact pinned at
# 249.3MB, exit(134), startup probe failed, roll red.
# Cost is the same rounding error it is in prod: jobs is minScale=0 on
# request-based billing.
#
# 2026-09-11 — the eager job registry was the root cause of the BOOT half of
# this and has been fixed: `apps/jobs/src/jobs/index.ts` no longer imports all
# 25 job modules, it serves metadata from a generated table and imports a
# handler only when that job is dispatched. Measured (heapUsed after a forced
# GC, so retained graph, not garbage). Two people measured independently on
# different machines; both runs are quoted because the spread is the honest
# error bar on a figure this decision rests on:
#
#   boot module graph (app.ts + registry)   233MB -> 86-94MB
#   after all 49 jobs have been dispatched  233MB -> 224-233MB
#
# Reproduce: import `src/app.ts`, force GC twice, sample `heapUsed`; then walk
# `allJobs` calling `load()` on each and sample again.
#
# 1Gi STAYS. The fix removes the failure that actually happened here — the
# revision now boots at roughly a third of the old-space ceiling instead of
# crashing against it — but it does NOT lower the ceiling. ESM modules cannot
# be unloaded, so once Cloud Scheduler has fired every scheduled job at least
# once (inevitable on any instance that lives more than a day) the process
# converges back to ~224MB, which is what 512Mi could not hold in the first
# place. Reverting to the 512Mi default would trade a LOUD failure — failed
# startup probe, revision never promotes, roll goes red — for a quiet exit 134
# on a warm instance hours later, mid-job. That is a strictly worse trade.
#
# Going back to 512Mi needs the shared floor cut, not the registry: ~86MB is
# paid before a single job runs (Prisma client, adapters, @th/ui-email, Sentry,
# fastify in `src/lib/container.ts`), and settlements (~41MB) and events
# (~43MB) are the two heaviest handler graphs.
jobs_memory = "1Gi"

jobs_scheduler_overrides = {
  "stripe-connect.reconcile-capabilities" = {
    enabled = false
  }
}


############################################
# Audio Transcoder (Cloud Run — MP3 → HLS)
############################################

audio_transcoder_image         = "us-east4-docker.pkg.dev/hearthfire-491918/services/audio-transcoder:dev"
audio_transcoder_cpu           = "2"
audio_transcoder_memory        = "2Gi"
audio_transcoder_max_instances = 5
# Scale to zero. Dev is the environment where the cold start costs least —
# nobody is waiting on a dev upload, and the builder polls every 10s regardless,
# so a ~20-30s cold start is two extra spinner ticks for someone who knows why.
# A warm instance here would be ~$14/month at 2 vCPU / 2 GiB and would make the
# transcoder the only warm service in an otherwise all-cold dev environment.
# Prod carries the warmth instead; see envs/prod/prod.tfvars.
audio_transcoder_min_instances = 0

# Same R2 bucket as API/Jobs — credentials via TF_VAR_* env vars
audio_transcoder_s3_bucket_name = "hf-dev-storage"

audio_transcoder_env = {
  NODE_ENV = "production"
}

# ── Google Wallet ────────────────────────────────────────────────────────────
# Issuer ID is from the Google Pay & Wallet Console (Ithas Fire account, demo
# mode is fine for dev). Enabling wallet grants the api-runtime SA
# `iam.serviceAccountTokenCreator` on itself so it can sign Wallet JWTs via
# IAM signJwt — no service-account key needed. After apply, manually add
# `hf-dev-api-runtime@hearthfire-491918.iam.gserviceaccount.com` as a
# Developer in the Wallet Console → Users tab.
enable_google_wallet    = true
google_wallet_issuer_id = "3388000000023116217"

# ── Apple Wallet ─────────────────────────────────────────────────────────────
# Public identifiers only — the signing cert + its password are secrets and
# arrive via TF_VAR_apple_pass_certificate_p12_base64 / _password.
#
# Team FJG7F43395 is the business account. Do NOT use 5J9DRDR2TB (the burned
# original team): the .pkpass `teamIdentifier` must match the team that issued
# the signing certificate, or iOS rejects the pass with no useful error.
#
# Dev uses its own Pass Type ID so a leaked dev cert can be revoked without
# killing prod — Apple revocation is all-or-nothing per Pass Type ID, and
# there is no sandbox/production split for passes.
apple_team_id              = "FJG7F43395"
apple_pass_type_identifier = "pass.com.ithasfire.ticket.dev"
