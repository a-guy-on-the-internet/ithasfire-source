variable "project_id" {
  description = "Cloud project identifier used across providers."
  type        = string
}

variable "region" {
  description = "Primary region for compute resources."
  type        = string
}

variable "domain" {
  description = "Root domain managed via Cloudflare."
  type        = string
}

variable "api_name" {
  description = "DNS record name for the API (relative to the zone). Example: 'api.dev', 'api'."
  type        = string
  default     = null
}

variable "web_name" {
  description = "DNS record name for the web app (relative to the zone). Example: 'web.stage', '@' (apex)."
  type        = string
  default     = null
}

variable "tileserver_name" {
  description = "DNS record name for the tileserver (relative to the zone). Example: 'tiles.dev'. When set together with enable_tileserver, Cloudflare DNS + edge caching is configured."
  type        = string
  default     = null
}

variable "additional_names" {
  description = "Additional DNS record names (relative to the zone) that should point at the same ingress target as api/web."
  type        = set(string)
  default     = []
}

variable "redirects" {
  description = "Cloudflare host-based redirects (Rulesets)."
  type = list(object({
    from_host             = string
    to_url                = string
    status_code           = number
    preserve_path_query   = optional(bool, true)
    exclude_path_prefixes = optional(list(string), [])
  }))
  default = []
}

variable "ingress_target_ipv4" {
  description = "Optional override IPv4 address for DNS records when Cloudflare DNS is enabled."
  type        = string
  default     = null
}

variable "environment" {
  description = "Deployment environment (dev/stage/prod)."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "Environment must be one of dev, stage, or prod."
  }
}

variable "google_impersonated_service_account" {
  description = "Optional service account email to impersonate for Google provider access."
  type        = string
  default     = null
}

variable "aws_region" {
  description = "AWS region for SNS SMS (and SES when enable_ses)."
  type        = string
  default     = "us-east-1"
}

variable "aws_assume_role_arn" {
  description = "Optional role ARN that Terraform should assume when authenticating to AWS."
  type        = string
  default     = null
}

variable "aws_access_key_id" {
  description = "Optional AWS access key id used for planning/applying when enable_aws=true (alternative to using an AWS profile)."
  type        = string
  sensitive   = true
  default     = null
}

variable "aws_secret_access_key" {
  description = "Optional AWS secret access key used for planning/applying when enable_aws=true (alternative to using an AWS profile)."
  type        = string
  sensitive   = true
  default     = null
}

variable "enable_aws" {
  description = "AWS for SMS (SNS / End User Messaging): IAM sender user, SMS preferences, inbound STOP topic."
  type        = bool
  default     = false
}

variable "enable_ses" {
  description = "SES email identity + SMTP user + DNS (DKIM, MAIL FROM). Only takes effect with enable_aws. Off because mail goes via Resend."
  type        = bool
  default     = false
}

variable "aws_sms_origination_otp" {
  description = "E.164 number (or phone-number ARN) of a registered US origination number (10DLC or toll-free) in AWS End User Messaging, used for one-time passcodes. The same number in both aws_sms_origination_* variables is the expected setup. Wired into the API/jobs services as AWS_SMS_ORIGINATION_OTP when enable_aws. Set once the number's registration is approved."
  type        = string
  default     = null
}

variable "aws_sms_origination_notifications" {
  description = "E.164 number (or phone-number ARN) of a registered US origination number (10DLC or toll-free) in AWS End User Messaging, used for notifications. The same number in both aws_sms_origination_* variables is the expected setup. Wired into the API/jobs services as AWS_SMS_ORIGINATION_NOTIFICATIONS when enable_aws. Set once the number's registration is approved."
  type        = string
  default     = null
}

variable "aws_manage_sms_preferences" {
  description = "Whether this workspace owns the account-level SMS preferences (SMS type, spend limit). They are per AWS account and region, so if dev and prod share an account set this true in one workspace only, or the two applies overwrite each other."
  type        = bool
  default     = true
}

variable "aws_sms_monthly_spend_limit" {
  description = "Account-level SMS monthly spend limit in USD (SNS SMS preferences). Must not exceed the account's approved SMS spend quota or apply fails; raise after AWS approves the increase."
  type        = number
  default     = 1
}

variable "ses_from_email" {
  description = "The from-address that the SES SMTP user is allowed to send as (e.g. no-reply@ithasfire.com)."
  type        = string
  default     = "no-reply@ithasfire.com"
}

variable "enable_upstash" {
  description = "If true, provision Upstash Redis resources."
  type        = bool
  default     = false
}

variable "upstash_region" {
  description = "Upstash Redis region (or 'global' for multi-zone)."
  type        = string
  default     = "global"
}

variable "upstash_primary_region" {
  description = "Primary region for global Upstash Redis (e.g. us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "upstash_read_regions" {
  description = "Optional read regions for global Upstash Redis."
  type        = set(string)
  default     = []
}

variable "enable_neon" {
  description = "If true, provision Neon database resources."
  type        = bool
  default     = false
}

variable "neon_org_id" {
  description = "Neon Organization ID used when creating Neon projects."
  type        = string
  default     = null
}


# --- Cloud Run: API + Web ---

variable "api_image" {
  description = "Container image reference for the API Cloud Run service."
  type        = string
  default     = null
}

variable "api_region" {
  description = "Region for the API Cloud Run service. Defaults to var.region."
  type        = string
  default     = null
}

variable "api_port" {
  description = "Container port for the API Cloud Run service."
  type        = number
  default     = 8080
}

variable "api_cpu" {
  description = "CPU limit for the API Cloud Run service (e.g. '1'). Null lets Cloud Run decide."
  type        = string
  default     = "1"
}

variable "api_memory" {
  description = "Memory limit for the API Cloud Run service (e.g. '512Mi'). Null lets Cloud Run decide."
  type        = string
  default     = "512Mi"
}

variable "api_min_instances" {
  description = "Minimum warm instances for the API Cloud Run service. Set to 1 to eliminate cold starts."
  type        = number
  default     = 0
}

variable "api_max_instances" {
  description = "Maximum instances for the API Cloud Run service."
  type        = number
  default     = 10
}

variable "ziptax_api_key" {
  description = "Ziptax API key for US sales-tax rate lookups (injected into API env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "geoapify_api_key" {
  description = "Geoapify API key for geocoding (injected into Web env as NEXT_PUBLIC_GEOAPIFY_API_KEY)."
  type        = string
  sensitive   = true
  default     = null
}

variable "azure_content_safety_endpoint" {
  description = "Azure AI Content Safety endpoint for image moderation (e.g. https://<resource>.cognitiveservices.azure.com). Injected into the Jobs env via Secret Manager. When unset (default) the jobs service falls back to the auto-approving stub moderation adapter."
  type        = string
  sensitive   = true
  default     = null
}

variable "azure_content_safety_key" {
  description = "Azure AI Content Safety subscription key for image moderation. Injected into the Jobs env via Secret Manager (NFR-004 — never committed). When unset (default) the jobs service falls back to the auto-approving stub moderation adapter."
  type        = string
  sensitive   = true
  default     = null
}

variable "image_moderation_review_threshold" {
  description = "FALLBACK Azure severity (0–7) at/above which a moderated image is FLAGGED (held for human review) rather than auto-APPROVED. Applies only to categories with no override in image_moderation_category_thresholds. Injected into the Jobs env as IMAGE_MODERATION_REVIEW_THRESHOLD; when unset the jobs service applies its own default (4)."
  type        = number
  default     = null
}

variable "image_moderation_category_thresholds" {
  description = <<-EOT
    Per-category Azure severity thresholds, injected as
    IMAGE_MODERATION_THRESHOLD_<CATEGORY>. Keys: SEXUAL, VIOLENCE, HATE,
    SELF_HARM. Any key omitted falls back to image_moderation_review_threshold.

    Non-secret plain env, like the fallback above — changing one is a terraform
    apply with no secret-rotation hazard.

    SEXUAL/VIOLENCE sit high (6) because a live-music catalogue produces those
    scores honestly on legitimate art: metal, burlesque, drag, horror-themed DIY
    posters. HATE/SELF_HARM sit low (2) because nothing legitimate scores there
    and that is where the liability is. Setting SEXUAL/VIOLENCE to 6 means a
    severity-4 result in those categories publishes WITHOUT human review — a
    deliberate trade.
  EOT
  type        = map(number)
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.image_moderation_category_thresholds) :
      contains(["SEXUAL", "VIOLENCE", "HATE", "SELF_HARM"], k)
    ])
    error_message = "Keys must be one of: SEXUAL, VIOLENCE, HATE, SELF_HARM. A typo'd key would be silently dropped and that category would quietly fall back to the uniform threshold."
  }
}


# --- Runtime secrets (Stripe, Auth, SES, OAuth, Turnstile) ---

variable "stripe_secret_key" {
  description = "Stripe secret API key (injected into API + Jobs env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook endpoint signing secret (injected into API env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "stripe_connect_webhook_secret" {
  # REQUIRED in prod. The API's env schema now rejects an empty value at boot,
  # but Terraform omits the env var entirely when this is empty (see
  # secrets.tf's `app_secret_keys`), so without the check below a blank CI
  # secret would deploy a container that boots fine and silently drops every
  # connected-account event. `account.updated` is the only writer of
  # `Payee.payoutsEnabled = true`, so that outage reads to an organizer as
  # "cannot publish a paid event" with a green Payments page.
  description = "Stripe Connect webhook endpoint signing secret (injected into API env). Required when environment is prod."
  type        = string
  sensitive   = true
  default     = null
}

variable "stripe_publishable_key" {
  description = "Stripe publishable key (injected into Web env as NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)."
  type        = string
  sensitive   = true
  default     = null
}

variable "better_auth_secret" {
  description = "Better Auth signing secret shared by API and Web."
  type        = string
  sensitive   = true
  default     = null
}

variable "consent_ip_hash_salt" {
  description = "Salt used to one-way-hash client IPs in the GDPR consent audit log. Rotate to invalidate all historical hashes."
  type        = string
  sensitive   = true
  default     = null
}

variable "resend_api_key" {
  description = "Resend API key for transactional email delivery (injected into API and Jobs env as RESEND_API_KEY)."
  type        = string
  sensitive   = true
  default     = null
}

variable "resend_webhook_secret" {
  description = "Svix signing secret from the Resend webhook endpoint (injected into API env as RESEND_WEBHOOK_SECRET; verifies bounce/complaint deliveries at /webhooks/resend)."
  type        = string
  sensitive   = true
  default     = null
}

# --- Sentry (error tracking + performance monitoring) ---

variable "sentry_dsn" {
  description = "Sentry DSN (injected into API, Web, and Jobs env as SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN)."
  type        = string
  sensitive   = true
  default     = null
}

variable "sentry_auth_token" {
  description = "Sentry auth token for source map uploads at build time (Web CI only)."
  type        = string
  sensitive   = true
  default     = null
}

variable "sentry_org" {
  description = "Sentry organization slug."
  type        = string
  default     = "hearth-fire"
}

variable "sentry_project" {
  description = "Sentry project slug."
  type        = string
  default     = "hearth-fire-web"
}

variable "google_client_id" {
  description = "Google OAuth client ID for web redirect flow (injected into API env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "google_client_secret" {
  description = "Google OAuth client secret (injected into API env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "spotify_client_id" {
  description = "Spotify API client ID for the optional Spotify integration (injected into API env as plain SPOTIFY_CLIENT_ID; client IDs are public). Leave null to disable — the adapter degrades gracefully when unset."
  type        = string
  default     = null
}

variable "spotify_client_secret" {
  description = "Spotify API client secret for the optional Spotify integration (injected into API env via Secret Manager). Leave null to disable — the adapter degrades gracefully when unset."
  type        = string
  sensitive   = true
  default     = null
}

variable "google_web_client_id" {
  description = "Google OAuth web client ID for ID-token verification (injected into API env)."
  type        = string
  default     = null
}

variable "google_ios_client_id" {
  description = "Google OAuth iOS client ID for ID-token verification (injected into API env)."
  type        = string
  default     = null
}

variable "google_android_client_id" {
  description = "Google OAuth Android client ID for ID-token verification (injected into API env)."
  type        = string
  default     = null
}

variable "apple_client_id" {
  description = "Apple Services ID for web OAuth redirect flow (injected into API env)."
  type        = string
  default     = null
}

variable "apple_client_secret" {
  description = "Apple client secret JWT (injected into API env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "apple_app_bundle_identifier" {
  description = "Apple iOS app bundle identifier for native Sign in with Apple (injected into API env)."
  type        = string
  default     = null
}

variable "turnstile_secret_key" {
  description = "Cloudflare Turnstile secret key for bot protection (injected into API env)."
  type        = string
  sensitive   = true
  default     = null
}

variable "origin_shared_secret" {
  description = "Shared secret used to detect/block direct-to-Cloud-Run requests that bypass Cloudflare. Set as the `x-origin-secret` request header by the Cloudflare Transform Rule (modules/cloudflare, gated on enable_cloudflare_origin_secret_header) and verified by the API + Web Cloud Run services (ORIGIN_SHARED_SECRET env, injected into both via secret_env). Generate via `openssl rand -hex 32`. Interim mitigation until a GCLB + Authenticated Origin Pulls is introduced — see the trustProxy note in apps/api/src/app.ts."
  type        = string
  sensitive   = true
  default     = null
}

variable "enforce_origin_secret" {
  description = "Rollout flag for the origin-secret guard (ENFORCE_ORIGIN_SECRET env on API + Web). Defaults to false so mismatches are only logged (`origin_secret_mismatch`) rather than rejected with 403 — this must stay false until the Cloudflare Transform Rule is confirmed live and the running services have picked up origin_shared_secret, otherwise a bad rollout can 403 all production traffic. Flip to true only after verifying mismatch warnings are quiet in prod logs."
  type        = bool
  default     = false
}

variable "enable_cloudflare_origin_secret_header" {
  description = "If true, create the Cloudflare Transform Rule (modules/cloudflare) that sets the x-origin-secret header on requests to the api/web hostnames. Requires origin_shared_secret to be set; no-ops otherwise. Like enable_cloudflare_cache_rules, the underlying ruleset is a per-zone-per-phase singleton — if dev and prod share a zone, enable on only one env."
  type        = bool
  default     = false
}

variable "unsubscribe_secret" {
  description = "HMAC secret for generating/verifying announcement unsubscribe tokens. Min 32 chars in production."
  type        = string
  sensitive   = true
  default     = null
}

variable "volunteer_scan_token_secret" {
  description = "HMAC secret for signing/verifying volunteer scan QR tokens. Generate via `openssl rand -hex 32`. When unset, volunteer mint/resolve procedures fail with `not_configured`."
  type        = string
  sensitive   = true
  default     = null
}

variable "discord_alerts_webhook" {
  description = "Discord webhook URL used by API and Jobs for operational alert delivery."
  type        = string
  sensitive   = true
  default     = null
}

variable "discord_support_webhook" {
  description = "Optional Discord webhook URL for the support chat widget — new threads + human escalations. Null/empty disables support pings; the widget still works."
  type        = string
  sensitive   = true
  default     = null
}

variable "jobs_api_key" {
  description = "Shared secret used as a Bearer token between the API proxy and the Jobs Cloud Run service. Must be at least 16 characters."
  type        = string
  sensitive   = true
  default     = null
}

# Merged wholesale into local.resolved_api_env and wins on conflicts — with one
# exception: REDIS_NAMESPACE is merged AFTER this map and cannot be overridden
# from here. See local.default_redis_namespace in main.tf for why.
variable "api_env" {
  description = "Additional environment variables to inject into the API Cloud Run service. Wins on conflicts, EXCEPT REDIS_NAMESPACE, which is merged afterwards and ignores any value set here."
  type        = map(string)
  default     = {}
}

variable "web_image" {
  description = "Container image reference for the Web Cloud Run service."
  type        = string
  default     = null
}

variable "web_region" {
  description = "Region for the Web Cloud Run service. Defaults to var.region."
  type        = string
  default     = null
}

variable "web_port" {
  description = "Container port for the Web Cloud Run service."
  type        = number
  default     = 8080
}

variable "web_cpu" {
  description = "CPU limit for the Web Cloud Run service (e.g. '1'). Null lets Cloud Run decide."
  type        = string
  default     = "1"
}

variable "jobs_memory" {
  description = <<-EOT
    Memory limit for the Jobs Cloud Run service. Null falls through to Cloud
    Run's 512Mi default, which cannot boot this container with Sentry enabled
    (verified 2026-09-05: heap OOM at ~247MB, exit 134, startup probe never
    passed). Prod sets 1Gi.
  EOT
  type        = string
  default     = null
}

variable "web_memory" {
  description = "Memory limit for the Web Cloud Run service (e.g. '512Mi'). Null lets Cloud Run decide."
  type        = string
  default     = "512Mi"
}

variable "web_min_instances" {
  description = "Minimum warm instances for the Web Cloud Run service. Set to 1 to eliminate cold starts."
  type        = number
  default     = 0
}

variable "web_max_instances" {
  description = "Maximum instances for the Web Cloud Run service."
  type        = number
  default     = 10
}

variable "web_env" {
  description = "Additional environment variables to inject into the Web Cloud Run service."
  type        = map(string)
  default     = {}
}


# --- Artifact Registry (Docker images for Cloud Run) ---

variable "artifact_registry_repository" {
  description = "Artifact Registry repository id (name) for Docker images (e.g. 'services')."
  type        = string
  default     = "services"
}

variable "artifact_registry_keep_last" {
  description = "How many most-recent versions per package (api/web/jobs) to keep in Artifact Registry. Older versions may be deleted by cleanup policies."
  type        = number
  default     = 10
}

variable "artifact_registry_delete_older_than_days" {
  description = "Delete UNTAGGED Artifact Registry versions older than this many days (in addition to keep_last). Only untagged versions are eligible — tagged images (prod/dev/dev-<sha>/buildcache-v2) are always kept. Set to 0 to disable time-based deletions."
  type        = number
  default     = 30
}

variable "artifact_registry_cleanup_dry_run" {
  description = "When true, Artifact Registry evaluates cleanup policies but deletes nothing (staged/report-only). Set to false to enforce deletions and actually reclaim space."
  type        = bool
  default     = true
}

# The `services` Artifact Registry repo is ONE physical resource shared by all
# environments. Exactly one workspace must OWN it (manage the resource + cleanup
# policies); every other workspace READS it via a data source. Set true in
# exactly one env's tfvars (prod), false everywhere else. Default false so a new
# env never accidentally co-manages (or destroys) the shared repo. See the AR
# resource comment in main.tf.
variable "manage_shared_artifact_registry" {
  description = "If true, this workspace OWNS the shared 'services' Artifact Registry repo (manages the resource + cleanup policies). Exactly ONE env sets this true (prod). All others read the repo via a data source. Prevents cross-workspace co-management of a single physical resource."
  type        = bool
  default     = false
}


# --- Jobs (Cloud Run) ---

variable "jobs_region" {
  description = "Region for the Jobs Cloud Run service. Defaults to var.region."
  type        = string
  default     = null
}

variable "jobs_service_name" {
  description = "Base service name for the Jobs Cloud Run service (without environment prefix)."
  type        = string
  default     = "jobs"
}

variable "jobs_image" {
  description = "Container image reference for the Jobs Cloud Run service."
  type        = string
  default     = null
}

# NOTE: Job-specific scheduler variables (cron, enabled) are now managed via:
#   - apps/jobs/src/jobs (defaults)
#   - var.jobs_scheduler_overrides (per-environment overrides in generated-jobs.tf)
#
# Example tfvars override:
#   jobs_scheduler_overrides = {
#     "settlements.process-due-payouts" = { enabled = true }
#   }

# Same override contract as var.api_env: merged wholesale into
# local.resolved_jobs_env and wins on conflicts, EXCEPT REDIS_NAMESPACE.
variable "jobs_env" {
  description = "Additional environment variables to inject into the Jobs Cloud Run service. Wins on conflicts, EXCEPT REDIS_NAMESPACE, which is merged afterwards and ignores any value set here."
  type        = map(string)
  default     = {}
}

# --- Migration-drift enforcement override (INCIDENT TOOL) ---
#
# NOT A CONFIG OPTION. Leave this null in every checked-in tfvars. It exists for
# one situation: the database is wedged such that `prisma migrate deploy` fails
# every run (e.g. P3009 after a run was cancelled mid-migration), so the schema
# cannot be brought up to date — and the drift guard is therefore, correctly,
# refusing to let any new revision serve. That is the right behaviour, and it is
# also a total deploy freeze: with a startup probe on /health, a drifted revision
# never becomes Ready, so an urgent unrelated hotfix cannot ship either. This is
# the documented way to break that deadlock.
#
# Setting it to "false" turns OFF ENFORCEMENT ONLY. Detection, logging and Sentry
# reporting all continue; on top of that, the guard logs
# `migration_drift_enforcement_disabled` at error level AND reports to Sentry on
# EVERY boot, drift or not, specifically so a flag left behind after an incident
# cannot go unnoticed. See packages/adapters/src/infra/migration-drift.ts.
#
# ONE knob for BOTH api and jobs, deliberately: drift is a property of the shared
# database, so a wedged DB blocks both services at once. A per-service knob would
# be false precision and would double the number of things to remember to revert.
#
# Incident procedure:
#   1. Set migration_drift_enforce = "false" in envs/<env>/<env>.tfvars, apply,
#      ship the hotfix.
#   2. Fix the migration.
#   3. REMOVE the line (do not set it back to "true" — null is the correct
#      resting state) and apply again.
#
# Cheaper partial escape, jobs only: setting `startup_probe_path = null` on the
# jobs module disables that service's probe without touching enforcement
# anywhere. Prefer it when only the jobs roll is blocked.
variable "migration_drift_enforce" {
  description = "INCIDENT TOOL, not a config option. Overrides MIGRATION_DRIFT_ENFORCE on the api + jobs Cloud Run services. null (default) omits the env var entirely so the runtime's automatic gate (K_SERVICE || NODE_ENV=production) applies and enforcement stays ON. Set to \"false\" ONLY to unblock a deploy while the database is wedged, then revert to null. Disables enforcement only — detection, logging and Sentry reporting continue, and the runtime reports the disabled state on every boot."
  type        = string
  default     = null

  validation {
    # The runtime already treats an unrecognised value as "fall through to the
    # automatic gate", so a typo can never silently disable the guard. This
    # catches the typo one step earlier — at plan time, with the valid values
    # named — instead of leaving an operator mid-incident wondering why their
    # revision still won't promote. Defense in depth, not a substitute.
    condition = var.migration_drift_enforce == null || contains(
      ["true", "1", "on", "false", "0", "off"],
      lower(trimspace(coalesce(var.migration_drift_enforce, "null")))
    )
    error_message = "migration_drift_enforce must be null (default, enforcement ON) or one of: true, 1, on, false, 0, off."
  }
}


# --- S3-compatible storage (Cloudflare R2, MinIO, AWS S3, etc.) ---

variable "storage_s3_bucket_name" {
  description = "Shared S3 bucket for the app — API uploads, ticket QRs, audio masters/HLS, job artifacts."
  type        = string
  default     = null
}

variable "storage_s3_endpoint" {
  description = "S3-compatible endpoint for the bucket (e.g. https://<accountid>.r2.cloudflarestorage.com)."
  type        = string
  default     = null
}

variable "storage_s3_access_key_id" {
  description = "S3 access key id for the shared storage bucket (prefer Secret Manager later)."
  type        = string
  sensitive   = true
  default     = null
}

variable "storage_s3_secret_access_key" {
  description = "S3 secret access key for the shared storage bucket (prefer Secret Manager later)."
  type        = string
  sensitive   = true
  default     = null
}

variable "storage_s3_public_base_url" {
  description = "Optional public base URL for reading objects (custom domain)."
  type        = string
  default     = null
}

variable "storage_s3_public_read" {
  description = "Whether storage objects should be treated as publicly readable by default (application-level behavior)."
  type        = bool
  default     = false
}

variable "sitemap_cdn_url" {
  description = <<-EOT
    Full URL of the sitemap INDEX served from the public storage CDN (e.g.
    https://cdn.ithasfire.com/sitemaps/sitemap.xml). Wired into the Web Cloud Run
    service as SITEMAP_CDN_URL; apps/web/src/app/robots.ts advertises it as the
    canonical Sitemap line in robots.txt so Google accepts the cross-host sitemap.

    Leave null to auto-derive from storage_s3_public_base_url + the known
    '/sitemaps/sitemap.xml' suffix the nightly sitemaps.generate job writes. Set
    explicitly only to point at a different host than the storage public base URL.
  EOT
  type        = string
  default     = null
}


variable "api_s3_bucket_name" {
  description = "S3 bucket name used by the API service for file storage. If null, defaults to storage_s3_bucket_name (when set)."
  type        = string
  default     = null
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with DNS and SSL management rights."
  type        = string
  sensitive   = true
  default     = null

  # NOTE: validation is intentionally soft here. Provider config in providers.tf
  # uses a placeholder token when creds are missing so `terraform plan` works
  # for GCP-only operations. The actual Cloudflare API call will fail at apply
  # time if enable_cloudflare_dns=true and no real token is provided.
}

variable "cloudflare_api_key" {
  description = "Cloudflare global API key (used with cloudflare_email when api_token is not set)."
  type        = string
  sensitive   = true
  default     = null
}

variable "cloudflare_email" {
  description = "Cloudflare account email (used with cloudflare_api_key when api_token is not set)."
  type        = string
  default     = null
}

variable "cloudflare_account_id" {
  description = "Cloudflare account identifier used by certain resources."
  type        = string
  default     = null
}

variable "enable_cloudflare_dns" {
  description = "If true, create/manage Cloudflare DNS records for the environment."
  type        = bool
  default     = false
}

variable "enable_cloudflare_origin_rules" {
  description = "If true, create Cloudflare Origin Rules to rewrite Host headers for Cloud Run. Requires Cloudflare Business plan (HostHeader override is not available on Pro or Free)."
  type        = bool
  default     = false
}

variable "enable_cloudflare_cache_rules" {
  description = "If true, create the Cloudflare cache-settings ruleset for this env. It is a per-zone-per-phase singleton; when dev and prod share a zone, keep it enabled only on prod (set false in dev)."
  type        = bool
  default     = true
}

variable "cloudflare_zone_id" {
  description = "Optional Cloudflare zone id for the domain. If null, the Cloudflare module may create the zone when cloudflare_account_id is set."
  type        = string
  default     = null
}

variable "cloudflare_zone_plan" {
  description = "Cloudflare plan of the zone (free | pro | business). Controls the edge rate-limit rule's period, block duration and whether it may be host-scoped; Free only accepts a 10s period, a 10s block and a path-only expression, and Cloudflare rejects anything more. ithasfire.com is Free as of 2026-09-29. See modules/cloudflare-security."
  type        = string
  default     = "free"
}

variable "enable_cloudflare_auth_rate_limit" {
  description = "If true (prod workspace only), create the zone's http_ratelimit ruleset limiting /api/auth/sign-up* and /api/auth/sign-in* per client IP. Added after the 2026-09-29 scripted sign-up run. Requires the Cloudflare token to have Zone WAF: Edit; without it the prod apply fails with 403. The ruleset is a per-zone-per-phase singleton, which is why only prod owns it."
  type        = bool
  default     = false
}

variable "cloudflare_auth_rate_limit_hosts" {
  description = "Hosts the auth rate limit is scoped to on pro/business plans (ignored on Free, where http.host is not allowed). Null derives [api.<domain>, api-dev.<domain>]."
  type        = list(string)
  default     = null
}

variable "cloudflare_auth_rate_limit_requests_per_period" {
  description = "Override for sign-up/sign-in requests allowed per IP per period before the edge blocks. Null uses the plan default (free: 3 per 10s; pro/business: 5 per 60s)."
  type        = number
  default     = null
}

variable "enable_cloudflare_bot_fight_mode" {
  description = "If true (prod workspace only), turn on Cloudflare Bot Fight Mode zone-wide. Keep false: it cannot be scoped by path or skipped by WAF rules, and it may challenge Stripe/Resend/SNS webhooks and the native scanner/mobile apps calling api.ithasfire.com. See modules/cloudflare-security/variables.tf."
  type        = bool
  default     = false
}

variable "neon_api_key" {
  description = "Neon API key for database provisioning."
  type        = string
  sensitive   = true
  default     = null
}

variable "upstash_api_key" {
  description = "Upstash API key for Redis provisioning."
  type        = string
  sensitive   = true
  default     = null
}

variable "upstash_email" {
  description = "Upstash account email for Terraform provider authentication."
  type        = string
  default     = null
}

variable "redis_url" {
  description = "Pre-provisioned Redis connection URL. Used when enable_upstash=false (e.g. prod, where Upstash was provisioned out-of-band). When set, takes precedence over the upstash module's output and is wired into api/jobs/web secret_env."
  type        = string
  sensitive   = true
  default     = null
}

# ─────────────────────────────────────────────────────────────────────────────────
# Meilisearch (Search)
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_meilisearch" {
  description = "If true, provision Meilisearch Cloud Run service."
  type        = bool
  default     = false
}

variable "meilisearch_secret_id" {
  description = "Secret Manager secret ID for Meilisearch master key."
  type        = string
  default     = "meilisearch-master-key"
}

variable "meilisearch_master_key" {
  description = "Optional explicit Meilisearch master key override. When unset, Terraform reads the key from Secret Manager."
  type        = string
  sensitive   = true
  default     = null
}

variable "meilisearch_image" {
  description = "Meilisearch container image reference."
  type        = string
  default     = "getmeili/meilisearch:v1.11"
}

variable "meilisearch_cpu" {
  description = "CPU allocation for Meilisearch (e.g., '1', '2')."
  type        = string
  default     = "1"
}

variable "meilisearch_memory" {
  description = "Memory allocation for Meilisearch (e.g., '1Gi', '2Gi'). Larger indexes need more RAM."
  type        = string
  default     = "1Gi"
}

variable "meilisearch_min_instances" {
  description = "Minimum instances for Meilisearch. Set to 1 in prod to avoid cold starts."
  type        = number
  default     = 0
}

variable "meilisearch_max_instances" {
  description = "Maximum instances for Meilisearch."
  type        = number
  default     = 2
}


# ─────────────────────────────────────────────────────────────────────────────────
# Tileserver (self-hosted map tiles via TileServer GL)
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_tileserver" {
  description = "If true, provision a TileServer GL Cloud Run service."
  type        = bool
  default     = false
}

variable "tileserver_image" {
  description = "Container image reference for the TileServer GL Cloud Run service."
  type        = string
  default     = null
}

variable "tileserver_allowed_origins" {
  description = "Comma-separated list of origins allowed to fetch tiles (CORS). Supports wildcards like '*.ithasfire.com'. Falls back to '*' when empty."
  type        = string
  default     = ""
}

# --- Public-serving toggles (cost kill-switch, codified) ---
# The `allUsers`/roles/run.invoker binding for web + api used to be a manual
# gcloud override (removed to take prod dark, re-added by any apply). Codifying
# it as a per-service flag means a prod apply keeps prod dark instead of waking
# it — no public window during a cutover. Defaults true (public); prod.tfvars
# sets both false while pre-launch. Flip back to true to launch prod.
# See the "Prod cost kill switch" ops note.
variable "api_allow_unauthenticated" {
  description = "If true, grant allUsers roles/run.invoker on the API Cloud Run service (public). Set false to keep the service dark (no public invoker); prod is false while pre-launch."
  type        = bool
  default     = true
}

variable "web_allow_unauthenticated" {
  description = "If true, grant allUsers roles/run.invoker on the Web Cloud Run service (public). Set false to keep the service dark (no public invoker); prod is false while pre-launch."
  type        = bool
  default     = true
}


# --- Audio Transcoder (Cloud Run) ---

variable "audio_transcoder_image" {
  description = "Container image reference for the Audio Transcoder Cloud Run service."
  type        = string
  default     = null
}

variable "audio_transcoder_region" {
  description = "Region for the Audio Transcoder Cloud Run service. Defaults to var.region."
  type        = string
  default     = null
}

variable "audio_transcoder_cpu" {
  description = "CPU allocation for the Audio Transcoder (e.g., '1', '2'). FFmpeg benefits from more CPU."
  type        = string
  default     = "2"
}

variable "audio_transcoder_memory" {
  description = "Memory allocation for the Audio Transcoder (e.g., '1Gi', '2Gi'). Needed for FFmpeg processing."
  type        = string
  default     = "2Gi"
}

variable "audio_transcoder_max_instances" {
  description = "Maximum instances for the Audio Transcoder."
  type        = number
  default     = 10
}

variable "audio_transcoder_min_instances" {
  description = <<-EOT
    Minimum instances kept warm for the Audio Transcoder.

    0 means the service scales to zero, so the first upload after an idle
    period pays a cold start — pulling an ffmpeg image and booting node before
    it touches any audio, roughly 20-30s.

    Where that time actually shows up: wherever AUDIO_TRANSCODE_TOPIC is set
    (every deployed environment) the dispatcher publishes to Pub/Sub and
    returns in milliseconds, so the 90s abort in events.ts never sees this —
    that budget guards the direct-fetch path used only in local dev. The cold
    start lands on end-to-end latency instead, which the uploader watches
    through resolveAudio's 10s poll loop: two or three extra spinner ticks.

    The API hides most of it: requestAudioUpload publishes a warm message to
    the transcode topic when an upload STARTS (`warmTranscoder` in events.ts),
    so the boot overlaps the browser's PUT of the file. That is why every
    environment, prod included, runs at 0.

    1 keeps one instance alive and removes the cold start outright. The module
    sets cpu_idle = true, so a warm instance bills at throttled-CPU rates
    rather than the always-allocated rate — but at this service's 2 vCPU /
    2 GiB prod measured $25.82 in 30 days for 3 uploads (2026-10-17). Price it
    before enabling it anywhere; the idle cost scales linearly with
    audio_transcoder_cpu.
  EOT
  type        = number
  default     = 0
}

variable "audio_transcoder_env" {
  description = "Additional environment variables for the Audio Transcoder Cloud Run service."
  type        = map(string)
  default     = {}
}

variable "audio_transcoder_s3_bucket_name" {
  description = "S3 bucket name used by the Audio Transcoder for source and HLS outputs."
  type        = string
  default     = null
}

variable "audio_transcoder_s3_endpoint" {
  description = "S3-compatible API endpoint for the Audio Transcoder bucket."
  type        = string
  default     = null
}

variable "audio_transcoder_s3_access_key_id" {
  description = "S3 access key ID for the Audio Transcoder bucket."
  type        = string
  default     = null
  sensitive   = true
}

variable "audio_transcoder_s3_secret_access_key" {
  description = "S3 secret access key for the Audio Transcoder bucket."
  type        = string
  default     = null
  sensitive   = true
}

variable "audio_transcoder_s3_public_base_url" {
  description = "Public base URL for the Audio Transcoder S3 bucket (for HLS playlist URLs)."
  type        = string
  default     = null
}


# ─────────────────────────────────────────────────────────────────────────────────
# Valhalla (self-hosted routing engine for A→B travel time)
#
# When enable_valhalla=true AND valhalla_image is set, Terraform provisions a
# dedicated Cloud Run service and derives VALHALLA_URL automatically.  If the
# feature gate is flipped off the service is destroyed (no idle spend).
#
# For purely local / external setups (no Cloud Run), set valhalla_url directly
# and leave valhalla_image null.
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_valhalla" {
  description = "Master switch for Valhalla. Controls both Cloud Run provisioning (if valhalla_image is set) and API env injection."
  type        = bool
  default     = false
}

variable "valhalla_image" {
  description = "Container image reference for the Valhalla Cloud Run service. When set together with enable_valhalla=true, a Cloud Run service is provisioned and its URL is injected into the API."
  type        = string
  default     = null
}

variable "valhalla_url" {
  description = "Explicit Valhalla URL for external / non-Cloud-Run deployments. Ignored when valhalla_image is set (Cloud Run URL takes precedence)."
  type        = string
  default     = null
}

variable "valhalla_cpu" {
  description = "CPU limit for the Valhalla Cloud Run container. Routing is CPU-bound."
  type        = string
  default     = "1"
}

variable "valhalla_memory" {
  description = "Memory limit for the Valhalla Cloud Run container. The routing graph is loaded into RAM."
  type        = string
  default     = "2Gi"
}

variable "valhalla_max_instances" {
  description = "Maximum Cloud Run instances for Valhalla."
  type        = number
  default     = 1
}

# ─────────────────────────────────────────────────────────────────────────────────
# Database backups (pg_dump → GCS)
#
# See docs/specs/2026-05-22/completed/pg-dump-to-gcs.spec.md and infra/terraform/db-backup.tf.
# Prod-only by design (dev is disposable). Requires enable_neon = true.
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_db_backups" {
  description = "If true, provision the database backup pipeline (GCS bucket + CMEK + SA + Pub/Sub topic; Cloud Run Jobs + Scheduler once db_backup_image is set). Prod-only by convention — dev is disposable."
  type        = bool
  default     = false
}

variable "db_backup_image" {
  description = "Container image for the pg-dump backup job (built from infra/docker/pg-dump via .github/workflows/pg-dump-image.yml). Pin a versioned tag (e.g. ':v1' or a git SHA) — never ':latest'. Leave null to provision only the storage layer."
  type        = string
  default     = null
}

variable "db_backup_lock_retention" {
  description = "Permanently lock the backup bucket's retention policy (GCS Bucket Lock). IRREVERSIBLE — flip to true only after the first successful restore drill."
  type        = bool
  default     = false
}

# ─────────────────────────────────────────────────────────────────────────────────
# Commerce feature gates
#
# These flags disable core commerce flows at the API level. Useful for keeping
# the site live (browsable) while preventing spam event creation or ticket
# purchases during early-access / soft-launch phases.
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_create_events" {
  description = "When false, event creation mutations are rejected and the 'Create Event' button is hidden."
  type        = bool
  default     = true
}

variable "enable_buy_tickets" {
  description = "When false, checkout / ticket-purchase mutations are rejected and the 'Get Tickets' CTA is hidden."
  type        = bool
  default     = true
}

# ─────────────────────────────────────────────────────────────────────────────────
# Google OAuth (Social Sign-In)
#
# When enable_google_oauth = true, Terraform creates a google_iam_oauth_client
# (google-beta) with configurable redirect URIs and a credential resource that
# yields the client secret.  The resulting client_id / secret are wired into
# resolved_api_env automatically.
#
# iOS and Android client IDs cannot be created by Terraform — create them in the
# GCP console (Application type: iOS / Android) and pass them via:
#   TF_VAR_google_ios_client_id
#   TF_VAR_google_android_client_id
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_google_oauth" {
  description = "When true, Terraform creates the Google OAuth consent screen brand and web client."
  type        = bool
  default     = false
}

variable "oauth_redirect_uris" {
  description = "List of authorized redirect URIs for the Google OAuth web client. Must match exactly what Better Auth sends as the redirect_uri parameter."
  type        = list(string)
  default     = []
}

# ─────────────────────────────────────────────────────────────────────────────────
# Google Wallet (pass generation via IAM Credentials signJwt — no JSON key)
#
# When enable_google_wallet = true, Terraform grants the api-runtime SA
# `roles/iam.serviceAccountTokenCreator` on itself so the runtime can call
# `iamcredentials.signJwt` to sign Wallet JWTs as itself. No service-account
# key material lives in the env; ADC + Cloud Run's metadata server provides
# the credentials.
#
# The Issuer ID comes from the Google Pay & Wallet Console; the api-runtime
# SA email must be manually added there as a Developer/Admin (Wallet ACLs
# aren't manageable via GCP IAM). The SA email is exposed via the
# `google_wallet_signer_sa_email` output.
#
# Apple Wallet credentials (P12 certificate, password, team ID, pass type ID)
# are entirely manual — created in the Apple Developer Portal, base64-encoded,
# and stored in the GSM secrets that are already defined in secret_catalog.
# Pass them via TF_VAR_apple_* or add to *.auto.tfvars.
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_google_wallet" {
  description = "When true, Terraform creates a GCP service account for the Google Wallet API and generates a key for JWT signing."
  type        = bool
  default     = false
}

variable "google_wallet_issuer_id" {
  description = "Google Wallet Issuer ID from the Google Pay & Wallet console. Required when enable_google_wallet = true."
  type        = string
  default     = null
}

variable "apple_pass_certificate_p12_base64" {
  description = "Base64-encoded PKCS#12 bundle containing the Apple Pass Type ID certificate + private key."
  type        = string
  default     = null
  sensitive   = true
}

variable "apple_pass_certificate_password" {
  description = "Password that unlocks the Apple Pass Type ID PKCS#12 bundle."
  type        = string
  default     = null
  sensitive   = true
}

variable "apple_team_id" {
  description = "Apple Developer Team Identifier (e.g. 'ABCD1234EF')."
  type        = string
  default     = null
}

variable "apple_pass_type_identifier" {
  description = "Apple Wallet Pass Type Identifier (e.g. 'pass.community.ithasfire.tickets')."
  type        = string
  default     = null
}


# ─────────────────────────────────────────────────────────────────────────────────
# Monitoring — uptime checks, alert policies, webhook-failure metrics
# See monitoring.tf. Dev and prod share the GCP project, so every monitoring
# resource is env-prefixed (hf-{env}-…).
# ─────────────────────────────────────────────────────────────────────────────────

variable "enable_uptime_checks" {
  description = "If true, provision Cloud Monitoring HTTPS uptime checks (api /health + web /) and their alert policies. Prod-on by convention; dev defaults off because scale-to-zero cold starts can flap the probes."
  type        = bool
  default     = false
}

variable "alerts_email" {
  description = "Email address for the Cloud Monitoring notification channel (uptime failures, Stripe webhook DLQ alerts). Leave null to create alert policies without a notification channel."
  type        = string
  default     = null
}
