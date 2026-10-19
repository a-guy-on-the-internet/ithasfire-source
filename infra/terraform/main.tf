terraform {
  backend "gcs" {
    # Remote state currently lives in Google Cloud Storage while we wait for Terraform Cloud access.
    # Hardcoded so `terraform init` works without needing to pass -backend-config.
    # Terraform will still automatically isolate environments via CLI workspaces.
    bucket = "hf-terraform-hearthfire-491918"
    prefix = "hearthfire/infra"
  }
}

# Fetch Meilisearch master key from Secret Manager when no explicit override is supplied.
data "google_secret_manager_secret_version" "meilisearch_master_key" {
  count   = var.enable_meilisearch && (var.meilisearch_master_key == null || trimspace(var.meilisearch_master_key) == "") ? 1 : 0
  project = var.project_id
  secret  = var.meilisearch_secret_id
}

locals {
  workspace_environment           = terraform.workspace == "default" ? var.environment : terraform.workspace
  allowed_environments            = toset(["dev", "stage", "prod"])
  meilisearch_master_key_override = var.meilisearch_master_key != null ? trimspace(var.meilisearch_master_key) : null
  meilisearch_master_key = !var.enable_meilisearch ? null : (
    local.meilisearch_master_key_override != null && local.meilisearch_master_key_override != ""
    ? local.meilisearch_master_key_override
    : data.google_secret_manager_secret_version.meilisearch_master_key[0].secret_data
  )

  # API DNS record name (api / api-dev); also builds the inbound SMS webhook URL.
  api_name = coalesce(var.api_name, local.workspace_environment == "prod" ? "api" : "api-${local.workspace_environment}")

  secret_catalog = {
    "wallet.apple.pass.certificate" = {
      description = "PKCS#12 bundle containing Apple's Pass Type ID certificate for signing .pkpass payloads."
    }
    "wallet.apple.pass.certificatePassword" = {
      description = "Password that unlocks the PKCS#12 certificate bundle for Apple Wallet passes."
    }
    "wallet.apple.teamIdentifier" = {
      description = "Apple Developer Team Identifier associated with the pass type certificate."
    }
    "wallet.apple.passTypeIdentifier" = {
      description = "Apple Wallet Pass Type Identifier registered for Ithas Fire wallets."
    }
    "wallet.google.walletServiceAccount" = {
      description = "Google Wallet service account JSON used to mint class and object definitions."
    }
    "wallet.jwt.primaryPrivateKey" = {
      description = "Primary private key (PEM) for signing Ithas Fire wallet ticket JWT payloads."
    }
    "wallet.jwt.primaryKeyId" = {
      description = "Key identifier (kid) corresponding to the primary JWT signing key."
    }
    "wallet.jwt.secondaryPrivateKey" = {
      description = "Optional secondary private key (PEM) for smooth key rotation of wallet JWTs."
      optional    = true
    }
    "wallet.jwt.secondaryKeyId" = {
      description = "Optional key identifier (kid) for the secondary JWT signing key when rotating secrets."
      optional    = true
    }
  }

  include_optional_secrets = {
    dev   = true
    stage = true
    prod  = true
  }

  secret_iam_bindings = {
    dev   = {}
    stage = {}
    prod  = {}
  }
}

check "workspace_environment_is_allowed" {
  assert {
    condition     = contains(local.allowed_environments, local.workspace_environment)
    error_message = "Select terraform workspace 'dev', 'stage', or 'prod', or provide -var=environment to match."
  }
}


module "environment" {
  source = "./stack"

  # IMPORTANT:
  # Terraform validates provider configuration blocks even when providers are
  # only used inside conditional modules (count = 0). Passing a provider alias
  # into a child module can force Terraform to validate that provider.
  #
  # To keep `terraform plan` usable for GCP-only work (no Cloudflare/Upstash/
  # Neon/AWS creds), we do NOT pass optional providers here. Submodules that need
  # them must rely on their own provider configuration when enabled.

  project_id  = var.project_id
  region      = var.region
  domain      = var.domain
  environment = local.workspace_environment

  # Single source of truth for API/web DNS record names.
  # Use hyphens (api-dev) instead of dots (api.dev) so the resulting FQDN
  # stays a first-level subdomain (api-dev.ithasfire.com) and is
  # covered by Cloudflare Universal SSL (*.ithasfire.com).  Two-level
  # subdomains (api.dev.ithasfire.com) require Advanced Certificate
  # Manager which is a paid add-on.
  api_name = local.api_name
  web_name = coalesce(var.web_name, local.workspace_environment == "prod" ? "@" : "web-${local.workspace_environment}")

  # Tileserver DNS name (e.g. tiles-dev.ithasfire.com).
  tileserver_name = var.enable_tileserver ? coalesce(var.tileserver_name, "tiles-${local.workspace_environment}") : null

  additional_names = var.additional_names
  redirects        = var.redirects

  enable_cloudflare_dns = var.enable_cloudflare_dns
  cloudflare_zone_id    = var.cloudflare_zone_id
  cloudflare_account_id = var.cloudflare_account_id

  ingress_target_ipv4 = var.ingress_target_ipv4

  # When Cloud Run services exist, use their assigned URLs as Cloudflare CNAME targets.
  # We pass only hostnames (no scheme) to keep the Cloudflare module interface clean.
  # Origin Host rewrite rules require Cloudflare Business plan — gate via enable_cloudflare_origin_rules.
  api_origin_hostname        = try(trimsuffix(trimprefix(module.api_service[0].service_url, "https://"), "/"), null)
  web_origin_hostname        = try(trimsuffix(trimprefix(module.web_service[0].service_url, "https://"), "/"), null)
  tileserver_origin_hostname = try(trimsuffix(trimprefix(module.tileserver[0].service_url, "https://"), "/"), null)

  # Plan-known "service deployed" flags that gate the cloudflare-cache origin
  # ruleset's cardinality. These MUST be static: the *_origin_hostname values
  # above are derived from module.*.service_url, which becomes "known after
  # apply" whenever a Cloud Run service is replaced (a region change forces
  # replacement because `location` is part of the resource identity). Feeding an
  # unknown value into a count/for_each makes Terraform reject the plan
  # ("Invalid count argument"). These booleans mirror the module count guards
  # (var.api_image == null ? 0 : 1, etc.) so the origin rule is created for
  # exactly the services that exist — identical to the old
  # "*_origin_hostname != null" test, but resolved at plan time.
  api_enabled        = var.api_image != null
  web_enabled        = var.web_image != null
  tileserver_enabled = var.enable_tileserver && var.tileserver_image != null

  enable_origin_rules = var.enable_cloudflare_origin_rules
  enable_cache_rules  = var.enable_cloudflare_cache_rules

  # Origin-secret guard — Cloudflare Transform Rule that stamps x-origin-secret
  # onto requests forwarded to the api/web hostnames (modules/cloudflare).
  # See apps/api/src/plugins/origin-guard.ts + apps/web/middleware.ts.
  origin_shared_secret        = var.origin_shared_secret
  enable_origin_secret_header = var.enable_cloudflare_origin_secret_header

  secret_catalog           = local.secret_catalog
  include_optional_secrets = lookup(local.include_optional_secrets, local.workspace_environment, true)
  secret_iam_bindings      = lookup(local.secret_iam_bindings, local.workspace_environment, {})

  enable_aws                  = var.enable_aws
  enable_ses                  = var.enable_ses
  aws_region                  = var.aws_region
  ses_from_email              = var.ses_from_email
  aws_manage_sms_preferences  = var.aws_manage_sms_preferences
  aws_sms_monthly_spend_limit = var.aws_sms_monthly_spend_limit
  # Inbound SMS (STOP/START) push target: the public API host, through
  # Cloudflare. Subscribed only where the API service exists and is public:
  # the subscription waits for the API to confirm it, and a dark API
  # (api_allow_unauthenticated = false, prod pre-launch) never receives the
  # SubscriptionConfirmation, so the apply would fail. The topic, its policy
  # and AWS_SNS_SMS_INBOUND_TOPIC_ARN are created either way; the next apply
  # after the API goes public adds the subscription.
  sms_inbound_subscribe = var.enable_aws && var.api_image != null && var.api_allow_unauthenticated
  sms_inbound_endpoint  = "https://${local.api_name}.${var.domain}/webhooks/aws/sms-inbound"
  # Ordering only: the subscription waits for the API revision that carries
  # AWS_SNS_SMS_INBOUND_TOPIC_ARN to be live, so the API can answer the
  # SubscriptionConfirmation (it returns 503 while the ARN is unset).
  sms_inbound_after = try(module.api_service[0].service_url, null)

  enable_upstash         = var.enable_upstash
  enable_neon            = var.enable_neon
  neon_org_id            = var.neon_org_id
  upstash_region         = var.upstash_region
  upstash_primary_region = var.upstash_primary_region
  upstash_read_regions   = var.upstash_read_regions
}

locals {
  # Global Redis key prefix. Injected as REDIS_NAMESPACE into the api, jobs and
  # audio-transcoder services, which hand it to ioredis as a global `keyPrefix`.
  #
  # Deliberately NOT gated on `var.enable_upstash`. That gate (removed
  # 2026-09-12) was exactly backwards: dev and prod BOTH run
  # `enable_upstash = false` because the Upstash free-tier database was
  # provisioned OUT OF BAND and is SHARED by both environments — the connection
  # URL arrives via TF_VAR_REDIS_URL_{DEV,PROD} (see envs/dev/dev.tfvars and
  # envs/prod/prod.tfvars). So the flag was false in precisely the situation
  # that makes the prefix mandatory, and REDIS_NAMESPACE was never emitted
  # anywhere.
  #
  # It is mandatory because every application key name is environment-agnostic:
  # `th:jobs:dlq:` (packages/adapters/src/job-diagnostics/redis-dlq-adapter.ts),
  # `th:jobs:runs:` + `th:jobs:enabled` (apps/jobs/src/lib/job-run-tracker.ts),
  # `webhook_dlq:*` (apps/api/src/lib/webhook-dlq.ts), `bauth:rl:`
  # (apps/api/src/auth/rate-limit-storage.ts) and `rl:`
  # (packages/adapters/src/rate-limit/redis-rate-limit-adapter.ts), plus
  # `idem:api:`/`idem:jobs:`/`idem:audio-transcoder:`
  # (packages/adapters/src/idempotency/redis-adapter.ts). Nothing in
  # the key names carries an environment marker, so this prefix is the ONLY
  # isolation between dev and prod on the shared database — without it a dev
  # load test burns real production users' rate-limit budget.
  #
  # Value shape: no trailing colon. The runtime trims and appends exactly one,
  # so "ithasfire:dev" is the correct form — do not "fix" it here.
  #
  # NOT OVERRIDABLE, by construction. Both env locals merge REDIS_NAMESPACE
  # AFTER `var.api_env` / `var.jobs_env`, inverting this file's usual
  # "tfvars merges last and wins" contract: a REDIS_NAMESPACE key written into
  # an <env>.tfvars env map is deliberately ignored, not honoured. The
  # convention holds for values where a per-environment override is meaningful;
  # an override here never is. This is not a tunable — it is the isolation
  # boundary itself, and a tfvars entry that quietly dissolved it would
  # reproduce the exact failure that motivated this code: a bad Redis config
  # value propagating silently end to end because nothing along the way
  # refused it. Deleting the environment separation must not be something a
  # config file can do by accident.
  #
  # Do NOT re-gate this on enable_upstash.
  default_redis_namespace = "ithasfire:${local.workspace_environment}"

  # Sentry environment tag. Maps the Terraform workspace/environment to the
  # value the SDKs tag events with. Without injecting this, every deployment
  # falls through to NODE_ENV=production (both dev and prod Cloud Run run
  # NODE_ENV=production), so dev and prod events collide indistinguishably in
  # Sentry. Kept as "production" (not "prod") so existing prod event history
  # isn't orphaned; mobile uses these same strings via getAppEnv().
  sentry_environment = local.workspace_environment == "prod" ? "production" : (
    local.workspace_environment == "stage" ? "staging" : "development"
  )

  # Sitemap index URL advertised in robots.txt.
  #
  # The nightly `sitemaps.generate` job (apps/jobs/src/jobs/sitemaps.ts) writes
  # the index to `<public base>/sitemaps/sitemap.xml` in the public storage
  # bucket. The public base is the Cloudflare R2 custom domain bound to the
  # bucket (e.g. https://cdn.ithasfire.com), wired via storage_s3_public_base_url.
  #
  # Google only honours a sitemap hosted on a different host than the URLs it
  # lists (cdn.ithasfire.com vs ithasfire.com/events/...) when that sitemap is
  # referenced from the target site's robots.txt. Setting SITEMAP_CDN_URL on the
  # web service makes apps/web/src/app/robots.ts emit the Sitemap line on
  # https://ithasfire.com/robots.txt, which satisfies that cross-host rule.
  #
  # Prefer an explicit override; otherwise derive from the storage public base.
  sitemap_cdn_url = coalesce(
    var.sitemap_cdn_url,
    var.storage_s3_public_base_url != null
    ? "${trimsuffix(var.storage_s3_public_base_url, "/")}/sitemaps/sitemap.xml"
    : null,
    "",
  )

  # Tileserver public URL.
  # With Cloudflare Pro, the tileserver CNAME is proxied and origin-rules
  # rewrite the Host header to the Cloud Run *.run.app hostname. Use the
  # Cloudflare-fronted custom domain so server-side fetches also benefit
  # from the 30-day edge cache. Fall back to the raw Cloud Run URL if
  # Cloudflare DNS or the tileserver is disabled.
  # Note: tileserver_name already includes the environment (e.g. "tiles-prod").
  tileserver_cdn_url = (
    var.enable_tileserver && var.enable_cloudflare_dns && var.tileserver_name != null
    ? "https://${var.tileserver_name}.${var.domain}"
    : try(module.tileserver[0].service_url, null)
  )

  # Google OAuth — prefer Terraform-managed IAM OAuth client over manually supplied vars.
  # When enable_google_oauth=true and the IAM client exists, its client_name (used as
  # client_id) and credential secret are authoritative.  Manually supplied vars act as
  # fallbacks (useful before Terraform has run).
  resolved_google_client_id = (
    var.enable_google_oauth && length(google_iam_oauth_client.hearthfire_web) > 0
    ? google_iam_oauth_client.hearthfire_web[0].name
    : var.google_client_id
  )
  resolved_google_client_secret = (
    var.enable_google_oauth && length(google_iam_oauth_client_credential.hearthfire_web) > 0
    ? google_iam_oauth_client_credential.hearthfire_web[0].client_secret
    : var.google_client_secret
  )
  # GOOGLE_WEB_CLIENT_ID mirrors the web client ID (used for ID-token verification).
  resolved_google_web_client_id = (
    var.enable_google_oauth && length(google_iam_oauth_client.hearthfire_web) > 0
    ? google_iam_oauth_client.hearthfire_web[0].name
    : var.google_web_client_id
  )

  # Non-secret env vars only. Sensitive values (DB URLs, API keys, signing
  # secrets, OAuth client secrets) are wired via secret_env in secrets.tf,
  # which materializes them as Secret Manager references on the container.
  #
  # AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY were previously removed when
  # SES was swapped for Resend — but they're still needed for SnsSmsAdapter
  # (2FA OTP delivery). Re-added via secret_env in secrets.tf, gated on
  # enable_aws. The non-secret AWS_REGION, origination numbers and inbound
  # STOP/START topic ARN live in this block.
  # Origination numbers (AWS End User Messaging): a registered US number
  # (10DLC or toll-free), used by the API (OTP) and jobs (notifications); the
  # same number in both variables is the expected setup. Each is set only once
  # its number exists.
  aws_sms_origination_env = merge(
    var.enable_aws && var.aws_sms_origination_otp != null
    ? { AWS_SMS_ORIGINATION_OTP = var.aws_sms_origination_otp }
    : {},
    var.enable_aws && var.aws_sms_origination_notifications != null
    ? { AWS_SMS_ORIGINATION_NOTIFICATIONS = var.aws_sms_origination_notifications }
    : {},
  )

  resolved_api_env = merge(
    var.enable_aws ? { AWS_REGION = var.aws_region } : {},
    local.aws_sms_origination_env,
    var.enable_aws ? { AWS_SNS_SMS_INBOUND_TOPIC_ARN = module.environment.aws_sms_inbound_topic_arn } : {},
    var.enable_tileserver && local.tileserver_cdn_url != null
    ? { TILESERVER_URL = local.tileserver_cdn_url }
    : {},
    # Google OAuth (public client IDs only; client secret is in secret_env)
    local.resolved_google_client_id != null
    ? { GOOGLE_CLIENT_ID = local.resolved_google_client_id }
    : {},
    local.resolved_google_web_client_id != null
    ? { GOOGLE_WEB_CLIENT_ID = local.resolved_google_web_client_id }
    : {},
    var.google_ios_client_id != null
    ? { GOOGLE_IOS_CLIENT_ID = var.google_ios_client_id }
    : {},
    var.google_android_client_id != null
    ? { GOOGLE_ANDROID_CLIENT_ID = var.google_android_client_id }
    : {},
    # Spotify integration (public client ID only; client secret is in secret_env)
    var.spotify_client_id != null ? { SPOTIFY_CLIENT_ID = var.spotify_client_id } : {},
    # Apple OAuth (public client ID + app bundle ID only; client secret is in secret_env)
    var.apple_client_id != null
    ? { APPLE_CLIENT_ID = var.apple_client_id }
    : {},
    var.apple_app_bundle_identifier != null
    ? { APPLE_APP_BUNDLE_IDENTIFIER = var.apple_app_bundle_identifier }
    : {},
    # Jobs service: URL only (JOBS_API_KEY is in secret_env)
    var.jobs_image != null && length(module.jobs_service) > 0
    ? { JOBS_SERVICE_URL = module.jobs_service[0].service_url }
    : {},
    # Outbox drain wake-ups (generated-jobs.tf, "Write-triggered drains").
    local.jobs_trigger_topic_prefix != null
    ? { JOB_TRIGGER_TOPIC_PREFIX = local.jobs_trigger_topic_prefix }
    : {},
    # Edit-triggered search reindex drain (search-reindex.tf).
    local.search_drain_api_env,
    # Lineup-notice sweep continuations get their OWN Cloud Tasks queue
    # (lineup-notice-sweep.tf). Additive to CLOUD_TASKS_QUEUE above, which
    # stays the search drain's.
    local.lineup_sweep_api_env,
    # Venue sales-tax rate fills get their OWN Cloud Tasks queue
    # (tax-rate-fill.tf). The API enqueues a fill when a listing page meets an
    # unknown rate; unset, it skips the enqueue.
    local.tax_rate_fill_api_env,
    # GCP project id for the Cloud Translation adapter's
    # projects/<id>/locations/global path (translation.tf). Same name and
    # value as resolved_jobs_env; unconditional, known at plan time.
    { GCP_PROJECT_ID = var.project_id },
    # Audio Transcoder. The API publishes transcode requests to the Pub/Sub
    # topic (AUDIO_TRANSCODE_TOPIC, full projects/.../topics/... path used
    # verbatim in the Pub/Sub REST URL). AUDIO_TRANSCODER_URL is kept as a
    # local-dev fallback (direct call); harmless in deployed env where the
    # transcoder is internal-only and reached via the push subscription.
    length(module.audio_transcoder) > 0
    ? {
      AUDIO_TRANSCODER_URL  = module.audio_transcoder[0].service_url
      AUDIO_TRANSCODE_TOPIC = module.audio_transcoder[0].topic_id
    }
    : {},
    # Valhalla routing engine (A→B travel time)
    var.enable_valhalla && (length(module.valhalla) > 0 || var.valhalla_url != null)
    ? {
      VALHALLA_URL       = length(module.valhalla) > 0 ? module.valhalla[0].service_url : var.valhalla_url
      ENABLE_TRAVEL_TIME = "true"
    }
    : {},
    # Google Wallet — adapter signs as the api-runtime SA via ADC + IAM
    # signJwt; only the issuer ID needs to ride in the env.
    var.google_wallet_issuer_id != null
    ? { GOOGLE_WALLET_ISSUER_ID = var.google_wallet_issuer_id }
    : {},
    # Apple Wallet public IDs (pass cert + password are in secret_env)
    var.apple_team_id != null
    ? { APPLE_TEAM_ID = var.apple_team_id }
    : {},
    var.apple_pass_type_identifier != null
    ? { APPLE_PASS_TYPE_IDENTIFIER = var.apple_pass_type_identifier }
    : {},
    # Commerce feature gates
    { ENABLE_CREATE_EVENTS = var.enable_create_events ? "true" : "false" },
    { ENABLE_BUY_TICKETS = var.enable_buy_tickets ? "true" : "false" },
    # Origin-secret guard rollout flag — see apps/api/src/plugins/origin-guard.ts.
    # Non-secret: it's just a "log-only vs enforce" toggle, not the secret itself
    # (ORIGIN_SHARED_SECRET rides in secret_env below).
    { ENFORCE_ORIGIN_SECRET = var.enforce_origin_secret ? "true" : "false" },
    # Sentry DSN — apps/api/src/instrument.ts reads process.env.SENTRY_DSN
    # at boot. Without this Sentry.init() no-ops and captureException calls
    # silently drop on the floor (Discord alerts still fire, since they go
    # through a separate webhook). Plain env is fine — the DSN only grants
    # event ingest, not read access.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_DSN = var.sentry_dsn }
    : {},
    # Sentry environment tag — apps/api/src/instrument.ts resolves environment as
    # SENTRY_ENVIRONMENT ?? NODE_ENV ?? "development". Without this, dev + prod
    # (both NODE_ENV=production) tag "production" and collide in Sentry. Gated on
    # the DSN existing — no point tagging env when Sentry is disabled.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_ENVIRONMENT = local.sentry_environment }
    : {},
    # R2 / S3-compatible storage — non-secret bucket/endpoint/public config.
    # Credentials (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY) ride in secret_env
    # (see api_secrets in secrets.tf). Mirrors the s3 block wired into the
    # jobs + audio-transcoder modules. Without S3_BUCKET + S3_ENDPOINT present,
    # the API's dep.ts falls back to NoopFileStorage and every presign upload
    # throws file_storage_not_configured.
    try(coalesce(try(module.storage_r2[0].bucket_name, null), var.storage_s3_bucket_name), null) != null
    ? {
      S3_BUCKET          = try(module.storage_r2[0].bucket_name, var.storage_s3_bucket_name)
      S3_ENDPOINT        = coalesce(var.storage_s3_endpoint, local.r2_endpoint)
      S3_PUBLIC_BASE_URL = var.storage_s3_public_base_url == null ? "" : var.storage_s3_public_base_url
      S3_PUBLIC_READ     = tostring(coalesce(var.storage_s3_public_read, false))
    }
    : {},
    # Migration-drift enforcement override — INCIDENT TOOL, see the variable.
    # Omitted entirely when null (the default) so the runtime falls through to
    # its own automatic gate (K_SERVICE || NODE_ENV == "production") and keeps
    # enforcing. Only ever set to disable enforcement during a wedged-DB
    # incident, then reverted.
    var.migration_drift_enforce != null
    ? { MIGRATION_DRIFT_ENFORCE = var.migration_drift_enforce }
    : {},
    # `var.api_env` is merged wholesale (and wins on conflicts), so every plain
    # key set in <env>.tfvars `api_env` — including the cross-subdomain session
    # cookie keys SESSION_COOKIE_DOMAIN (`.ithasfire.com` on both prod and dev)
    # and SESSION_COOKIE_PREFIX (dev-only, keeps dev's cookie name distinct from
    # prod's on the shared domain; see apps/api/src/auth/cookie-domain.ts) —
    # flows to the API container here without needing a per-key lookup.
    #
    # The ONE exception is REDIS_NAMESPACE, merged after it below.
    var.api_env,
    # Global Redis key prefix — see local.default_redis_namespace above.
    #
    # Merged LAST, deliberately: this is the only key in this local that
    # `var.api_env` cannot override. Same spirit as WEB_API_BASE_URL in
    # resolved_web_env, which the tfvars comments mark as "intentionally NOT
    # set here" — except that one relies on nobody writing the key, and this
    # one enforces it. A REDIS_NAMESPACE entry in <env>.tfvars `api_env` is
    # silently ignored; if you need a different value, change
    # local.default_redis_namespace, where the reasoning lives.
    #
    # The API carries the LARGER half of the dev/prod collision surface — the
    # Better Auth rate-limit counters (`bauth:rl:`), the per-procedure tRPC rate
    # limits (`rl:`) and the durable Stripe webhook DLQ (`webhook_dlq:*`) all
    # live on the same shared Upstash database as prod's.
    #
    # Unconditional, and safe against the "duplicate name between api_env and
    # secret_env makes Cloud Run reject the service template" trap documented
    # in the tfvars: REDIS_NAMESPACE is not a secret and does not appear in
    # secrets.tf — only REDIS_URL does. Overriding `var.api_env` here cannot
    # produce a duplicate either; `merge` collapses the key, it does not
    # emit it twice.
    { REDIS_NAMESPACE = local.default_redis_namespace },
  )

  # Non-secret web env. BETTER_AUTH_SECRET moved to secret_env in secrets.tf.
  resolved_web_env = merge(
    var.enable_tileserver && local.tileserver_cdn_url != null
    ? { NEXT_PUBLIC_TILESERVER_URL = local.tileserver_cdn_url }
    : {},
    var.geoapify_api_key != null
    ? { NEXT_PUBLIC_GEOAPIFY_API_KEY = var.geoapify_api_key }
    : {},
    # Stripe publishable key is public — Next.js exposes it to the client.
    var.stripe_publishable_key != null
    ? { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = var.stripe_publishable_key }
    : {},
    # Sentry DSN — Next.js SSR side reads SENTRY_DSN at runtime. The client
    # bundle gets NEXT_PUBLIC_SENTRY_DSN baked in at build time (Docker build
    # args, see deploy-{env}.yml). So both have to exist for full coverage.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_DSN = var.sentry_dsn }
    : {},
    # Sentry environment tag for the Next SSR/edge runtime. sentry.server.config.ts
    # and sentry.edge.config.ts read SENTRY_ENVIRONMENT (NOT the NEXT_PUBLIC one),
    # falling through to NODE_ENV=production otherwise — so dev + prod SSR events
    # collide without this. The client bundle's NEXT_PUBLIC_SENTRY_ENVIRONMENT is
    # baked in at build time separately (Docker build args, see deploy-{env}.yml).
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_ENVIRONMENT = local.sentry_environment }
    : {},
    # CDN-hosted sitemap index. robots.ts (server-side, runtime — NOT a
    # NEXT_PUBLIC build-time var) reads SITEMAP_CDN_URL and advertises it as the
    # canonical Sitemap line. Because it's read at runtime, an env redeploy is
    # sufficient; no web image rebuild is required.
    local.sitemap_cdn_url != ""
    ? { SITEMAP_CDN_URL = local.sitemap_cdn_url }
    : {},
    # Origin-secret guard rollout flag — see apps/web/middleware.ts. Mirrors
    # the API's ENFORCE_ORIGIN_SECRET so both services flip enforcement
    # together (ORIGIN_SHARED_SECRET itself rides in secret_env below).
    { ENFORCE_ORIGIN_SECRET = var.enforce_origin_secret ? "true" : "false" },
    # Server-to-server (SSR) API base URL. Points web's SSR tRPC data path at
    # the API's Cloud Run *.run.app origin so those calls stay inside Google's
    # network (same region) instead of hairpinning out through Cloudflare and
    # back into Cloud Run. MUST be a reference to the api_service module's URL
    # (NOT a hardcoded hostname): compute is moving region (us-central1 →
    # us-east4) and the *.run.app URL changes with it — a hardcoded string
    # would silently break. Browser/client calls still use the public
    # NEXT_PUBLIC_API_BASE_URL (api.ithasfire.com); only this SSR path changes.
    # The API keeps INGRESS_TRAFFIC_ALL + allow_unauthenticated, so the origin
    # is reachable without an ID token; the web SSR client injects the
    # x-origin-secret header (ORIGIN_SHARED_SECRET, already in web secret_env)
    # so these internal calls still satisfy the origin-guard when
    # enforce_origin_secret is flipped on. Guarded so it is only set when the
    # api service actually exists in this workspace.
    var.api_image == null
    ? {}
    : { WEB_API_BASE_URL = module.api_service[0].service_url },
    var.web_env
  )

  # Non-secret jobs env. Sensitive values (DATABASE_URL, REDIS_URL,
  # STRIPE_SECRET_KEY, RESEND_API_KEY, DISCORD_ALERTS_WEBHOOK, JOBS_API_KEY,
  # UNSUBSCRIBE_SECRET) live in secret_env via secrets.tf.
  #
  # AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (volunteer-reminder SMS via
  # SnsSmsAdapter) are wired in secret_env. Non-secret AWS_REGION and the
  # origination numbers are merged below.
  resolved_jobs_env = merge(
    var.enable_aws ? { AWS_REGION = var.aws_region } : {},
    local.aws_sms_origination_env,
    # Forward a small set of non-secret plain values from the API env so jobs
    # see the same defaults (e.g. From header, public web base URL).
    {
      for k, v in {
        SMTP_DEFAULT_FROM_EMAIL = lookup(var.api_env, "SMTP_DEFAULT_FROM_EMAIL", null)
        PUBLIC_WEB_URL          = lookup(var.api_env, "PUBLIC_WEB_URL", null)
      } : k => v if v != null
    },
    # GCP project id — apps/jobs/src/lib/discord-alerts.ts builds Cloud Logging
    # deep-links via buildCloudLoggingUrl(runId), which reads GCP_PROJECT_ID ??
    # PROJECT_ID. Without it the link resolves to null and never appears in the
    # Discord alert. Unconditional — the project id is always known at plan time.
    { GCP_PROJECT_ID = var.project_id },
    # Outbox drain wake-ups (generated-jobs.tf, "Write-triggered drains"):
    # jobs writes some outbox rows itself and re-wakes a drain that stopped on
    # its time budget.
    local.jobs_trigger_topic_prefix != null
    ? { JOB_TRIGGER_TOPIC_PREFIX = local.jobs_trigger_topic_prefix }
    : {},
    # Edit-triggered search reindex drain (search-reindex.tf).
    local.search_drain_jobs_env,
    # Lineup-notice sweep continuations get their OWN Cloud Tasks queue
    # (lineup-notice-sweep.tf). Jobs enqueues hops 2..5 of the chain, so it
    # needs the same queue the API's first hop went to. Additive to
    # CLOUD_TASKS_QUEUE above, which stays the search drain's.
    local.lineup_sweep_jobs_env,
    # Venue sales-tax rate fills get their OWN Cloud Tasks queue
    # (tax-rate-fill.tf). Same queue path in jobs as in the API.
    local.tax_rate_fill_jobs_env,
    # Sentry DSN — apps/jobs/src/instrument.ts reads process.env.SENTRY_DSN
    # at boot, same conditional merge as the API env above.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_DSN = var.sentry_dsn }
    : {},
    # Sentry environment tag — apps/jobs/src/instrument.ts resolves environment as
    # SENTRY_ENVIRONMENT ?? NODE_ENV ?? "development", same conditional merge as
    # the API env above. Without it dev + prod jobs (both NODE_ENV=production)
    # collide in Sentry.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_ENVIRONMENT = local.sentry_environment }
    : {},
    # Image-moderation review threshold (non-secret). The Azure endpoint + key
    # ride in secret_env via secrets.tf; only this plain tuning knob lives here.
    # Omitted when unset so the jobs env schema applies its own default (4).
    var.image_moderation_review_threshold != null
    ? { IMAGE_MODERATION_REVIEW_THRESHOLD = tostring(var.image_moderation_review_threshold) }
    : {},
    # Per-category overrides (non-secret, same rationale as the fallback above).
    # Keys are validated in variables.tf, so this can only emit the four real
    # category names; anything absent is simply not injected and the jobs env
    # schema leaves it undefined, which the use case reads as "fall back".
    {
      for k, v in var.image_moderation_category_thresholds :
      "IMAGE_MODERATION_THRESHOLD_${k}" => tostring(v)
    },
    # Migration-drift enforcement override — INCIDENT TOOL, see the variable.
    # Same knob as the API env above, deliberately not a separate variable: the
    # drift condition is a property of the shared DATABASE, so a wedged DB blocks
    # api and jobs together. Omitted entirely when null (the default).
    var.migration_drift_enforce != null
    ? { MIGRATION_DRIFT_ENFORCE = var.migration_drift_enforce }
    : {},
    var.jobs_env,
    # Global Redis key prefix — see local.default_redis_namespace above, and
    # the mirror of this block at the end of resolved_api_env.
    #
    # Merged LAST so `var.jobs_env` cannot override it. Unconditional: this
    # previously read
    #   var.enable_upstash ? { REDIS_NAMESPACE = ... } : {}
    # and therefore never fired in ANY environment, because dev and prod both
    # set enable_upstash = false against a shared, out-of-band Upstash
    # database — the gate was false in exactly the case that needs the prefix.
    # Do not put the gate back, and do not move this above `var.jobs_env`.
    { REDIS_NAMESPACE = local.default_redis_namespace },
  )
}


# ─────────────────────────────────────────────────────────────────────────────────
# SES DNS records (DKIM + MAIL FROM)
#
# When enable_aws && enable_ses, the SES module provisions a domain identity and outputs
# DKIM tokens.  We create the necessary DNS records in Cloudflare so SES can
# verify the domain and sign outbound email.
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  # SES always issues exactly 3 DKIM tokens. Keys must be static (token values
  # are unknown at plan time), so index by position.
  ses_enabled      = var.enable_aws && var.enable_ses
  ses_dkim_tokens  = local.ses_enabled ? module.environment.ses_dkim_tokens : []
  ses_dkim_records = local.ses_enabled ? { "0" = 0, "1" = 1, "2" = 2 } : {}
}

resource "cloudflare_record" "ses_dkim" {
  for_each = local.ses_dkim_records

  zone_id         = var.cloudflare_zone_id
  name            = "${local.ses_dkim_tokens[each.value]}._domainkey.${var.domain}"
  type            = "CNAME"
  content         = "${local.ses_dkim_tokens[each.value]}.dkim.amazonses.com"
  ttl             = 3600
  proxied         = false
  allow_overwrite = true
}

# MAIL FROM MX record: mail.<domain> → feedback-smtp.<region>.amazonses.com
resource "cloudflare_record" "ses_mail_from_mx" {
  count = local.ses_enabled ? 1 : 0

  zone_id         = var.cloudflare_zone_id
  name            = module.environment.ses_mail_from_domain
  type            = "MX"
  content         = "feedback-smtp.${var.aws_region}.amazonses.com"
  priority        = 10
  ttl             = 3600
  proxied         = false
  allow_overwrite = true
}

# MAIL FROM SPF record: allows SES to send on behalf of the MAIL FROM subdomain.
resource "cloudflare_record" "ses_mail_from_spf" {
  count = local.ses_enabled ? 1 : 0

  zone_id         = var.cloudflare_zone_id
  name            = module.environment.ses_mail_from_domain
  type            = "TXT"
  content         = "v=spf1 include:amazonses.com ~all"
  ttl             = 3600
  proxied         = false
  allow_overwrite = true
}


# --- Jobs runtime (Cloud Run + Scheduler + Pub/Sub push) ---

locals {
  jobs_region = coalesce(var.jobs_region, var.region)

  # Note: GCP service account `account_id` must match:
  #   ^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])$
  # i.e. 6-30 chars, lowercase, starts with a letter.
  # Keep these short and stable.
  jobs_name_prefix = "hf-${local.workspace_environment}"

  jobs_scheduler_sa_id   = "hf${local.workspace_environment}-jobs-sch"
  jobs_pubsub_push_sa_id = "hf${local.workspace_environment}-jobs-psh"
}

# Invoker identities.
resource "google_service_account" "jobs_scheduler_invoker" {
  account_id   = local.jobs_scheduler_sa_id
  display_name = local.jobs_scheduler_sa_id
  project      = var.project_id
}

resource "google_service_account" "jobs_pubsub_push_invoker" {
  account_id   = local.jobs_pubsub_push_sa_id
  display_name = local.jobs_pubsub_push_sa_id
  project      = var.project_id
}

module "jobs_service" {
  source = "./modules/cloud-run-jobs-service"

  count = var.jobs_image == null ? 0 : 1

  project_id   = var.project_id
  region       = local.jobs_region
  environment  = local.workspace_environment
  name_prefix  = local.jobs_name_prefix
  service_name = var.jobs_service_name
  jobs_image   = var.jobs_image
  memory       = var.jobs_memory

  # Request timeout: Cloud Run's default 300s, on purpose (the module has no
  # knob yet). The trigger paths are sized to it: the drain subscriptions' 300s
  # ack deadline (generated-jobs.tf), the drains' 300s attemptDeadline, and the
  # 300s Cloud Tasks dispatch cap in cloud-tasks-scheduler.ts. search.ensure-format
  # and search.full-reindex rebuild the whole index in one request; raise this
  # to 600s once the search corpus nears ~2,000 docs, and those deadlines with it.

  # Containers expose 8080 in Dockerfiles; Cloud Run sets PORT accordingly.
  port = 8080

  # Wire S3-compatible bucket config into the service.
  # Bucket itself is provisioned below (when configured via Cloudflare R2).
  # Endpoint is derived from cloudflare_account_id when not explicitly set.
  s3 = {
    bucket            = try(module.storage_r2[0].bucket_name, var.storage_s3_bucket_name)
    endpoint          = coalesce(var.storage_s3_endpoint, local.r2_endpoint)
    access_key_id     = var.storage_s3_access_key_id
    secret_access_key = var.storage_s3_secret_access_key
    public_base_url   = var.storage_s3_public_base_url
    public_read       = var.storage_s3_public_read
  }

  # Give scheduler + pubsub push + API proxy identities permission to invoke.
  invoker_service_accounts = merge(
    {
      scheduler  = google_service_account.jobs_scheduler_invoker.email
      pubsubPush = google_service_account.jobs_pubsub_push_invoker.email
    },
    var.api_image != null ? { apiProxy = module.api_service[0].runtime_service_account_email } : {},
  )

  env        = local.resolved_jobs_env
  secret_env = local.jobs_secret_env

  depends_on = [time_sleep.wait_for_secret_iam]
}

resource "google_artifact_registry_repository_iam_member" "jobs_runtime_reader" {
  count = var.jobs_image == null ? 0 : 1

  project    = var.project_id
  location   = local.artifact_registry_location
  repository = local.artifact_registry_repository_id

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${module.jobs_service[0].runtime_service_account_email}"
}

module "storage_r2" {
  source = "./modules/r2-bucket"

  count = (var.jobs_image == null || var.storage_s3_bucket_name == null || var.cloudflare_account_id == null) ? 0 : 1

  enabled    = true
  account_id = var.cloudflare_account_id
  name       = var.storage_s3_bucket_name

  # Optional passthroughs; prefer secret wiring later.
  endpoint          = var.storage_s3_endpoint
  access_key_id     = var.storage_s3_access_key_id
  secret_access_key = var.storage_s3_secret_access_key
  public_base_url   = var.storage_s3_public_base_url
  default_public    = var.storage_s3_public_read
}

# ─────────────────────────────────────────────────────────────────────────────────
# Jobs Pub/Sub topics, subscriptions, and schedulers are defined in:
#   generated-jobs.tf (auto-generated from apps/jobs/src/jobs)
#
# To add a new job:
# 1. Add the entry to apps/jobs/src/jobs
# 2. Run: pnpm -C apps/jobs generate:tf
# 3. Run: terraform plan
# ─────────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────────
# Google Wallet — the api-runtime SA signs Wallet JWTs via IAM Credentials
# (no JSON key shipped). Three prerequisites for `enable_google_wallet`:
#   1. `walletobjects.googleapis.com` must be enabled on the project. Without
#      it EVERY Wallet call fails 403 SERVICE_DISABLED — including the JWT
#      save-link path — even though the IAM binding below looks correct. This
#      bit us: `enable_google_wallet = true` shipped in dev while the API was
#      off, so the adapter 403'd on every request.
#   2. The api-runtime SA must be able to call iamcredentials.signJwt as
#      itself — that's `roles/iam.serviceAccountTokenCreator` on its own
#      resource. Bound below.
#   3. After apply, manually add the api-runtime SA email
#      (`module.api_service[0].runtime_service_account_email`) as a
#      Developer/Admin in the Google Pay & Wallet Console → Users tab.
#      No GCP API for this — Wallet ACLs live in the Wallet Console only.
#      Confirmed: the `permissions` API 403s unless the caller is ALREADY an
#      authorized user of the issuer, so there is no API bootstrap path.
# ─────────────────────────────────────────────────────────────────────────────────

# Project-level singleton: dev and prod share `hearthfire-491918`, so only one
# workspace may manage this (same rule as the Cloudflare rulesets — see
# `enable_cloudflare_cache_rules`). Prod owns it; dev inherits the enablement
# because it is the same project. `disable_on_destroy = false` so tearing down
# prod never yanks the API out from under dev.
resource "google_project_service" "walletobjects" {
  count   = var.enable_google_wallet && local.workspace_environment == "prod" ? 1 : 0
  project = var.project_id
  service = "walletobjects.googleapis.com"

  disable_on_destroy = false
}

resource "google_service_account_iam_member" "wallet_signer_self" {
  count              = var.enable_google_wallet && length(module.api_service) > 0 ? 1 : 0
  service_account_id = "projects/${var.project_id}/serviceAccounts/${module.api_service[0].runtime_service_account_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${module.api_service[0].runtime_service_account_email}"
}

# --- API + Web (Cloud Run) ---

locals {
  api_region = coalesce(var.api_region, var.region)
  web_region = coalesce(var.web_region, var.region)
}


# --- Artifact Registry (Docker) ---

# The `services` Artifact Registry repo is a SINGLE physical resource shared by
# every environment (dev + prod push images to the same repo, distinguished by
# tag). Terraform CLI workspaces give each env its OWN state, so if BOTH
# workspaces declared this as a `resource` they would co-manage one physical
# repo — which silently breaks the moment their configs diverge (e.g. the
# us-central1 → us-east4 region move: dev applied first and destroyed+recreated
# the repo, leaving prod's state pointing at a repo that no longer existed →
# every prod apply then tried to CREATE the already-existing repo → 409).
#
# Fix: exactly ONE workspace OWNS the repo (var.manage_shared_artifact_registry
# = true, set in prod.tfvars); every other workspace READS it via the data
# source below. `prevent_destroy` is a belt-and-suspenders backstop: it turns
# any accidental destroy/replace (a future region move, or a botched
# ownership migration) into a LOUD plan error instead of deleting the image
# registry. To move regions, see docs/deploy.md#terraform-state-surgery (state rm +
# re-import the repo in the owner workspace).
resource "google_artifact_registry_repository" "services" {
  count = var.manage_shared_artifact_registry ? 1 : 0

  location      = var.region
  project       = var.project_id
  repository_id = var.artifact_registry_repository
  format        = "DOCKER"

  lifecycle {
    prevent_destroy = true
  }

  # Cleanup policies to prevent unbounded image growth as CI pushes a new digest
  # on every main commit.
  #
  # Policies are evaluated by Artifact Registry per package (e.g. api/web/jobs).
  #
  # SAFETY MODEL: the DELETE policy is scoped to UNTAGGED versions only, so it
  # can never remove a live or rollback image. Cloud Run deploys from moving
  # tags (<pkg>:prod, <pkg>:dev); every build also writes an immutable
  # dev-<gitsha> tag — all TAGGED, hence excluded
  # by the delete rule and additionally pinned by the explicit keep-tagged
  # policy. Only superseded/untagged manifests, cache, and attestation layers
  # older than N days are pruned. This matters because prod services are scaled
  # to zero: deleting a :prod/:dev digest would break cold-start.
  #
  # cleanup_policy_dry_run gates enforcement: keep true to stage (evaluate +
  # report only, delete nothing); set false to actually reclaim space.
  cleanup_policy_dry_run = var.artifact_registry_cleanup_dry_run

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"

    most_recent_versions {
      # Keep last N versions per package.
      keep_count = var.artifact_registry_keep_last
    }
  }

  # Belt-and-suspenders: never delete a version that carries any tag
  # (prod/dev moving tags, dev-<sha> immutable tags, git-sha tags, and the
  # buildcache-v2/buildcache-prod tags left from the registry layer cache that
  # CI replaced with the GitHub Actions cache on 2026-10-17).
  cleanup_policies {
    id     = "keep-tagged"
    action = "KEEP"

    condition {
      tag_state = "TAGGED"
    }
  }

  dynamic "cleanup_policies" {
    for_each = var.artifact_registry_delete_older_than_days > 0 ? [1] : []
    content {
      id     = "delete-untagged-old"
      action = "DELETE"

      condition {
        # UNTAGGED-only: tagged (live/rollback) images are never eligible.
        tag_state = "UNTAGGED"
        # GCP Artifact Registry duration format requires seconds with trailing 's'.
        older_than = "${var.artifact_registry_delete_older_than_days * 24 * 3600}s"
      }
    }
  }

  labels = {
    application = "ithasfire"
    environment = local.workspace_environment
    component   = "artifact-registry"
  }
}

# Non-owner workspaces (var.manage_shared_artifact_registry = false) read the
# repo instead of managing it. The repo must already exist (the owner env
# created it); on a brand-new project, bring up the owner env first.
data "google_artifact_registry_repository" "services" {
  count = var.manage_shared_artifact_registry ? 0 : 1

  location      = var.region
  project       = var.project_id
  repository_id = var.artifact_registry_repository
}

locals {
  # Resolve the repo's location + id from whichever of the two the current
  # workspace uses (owned resource vs. read-only data source). All IAM-reader
  # bindings and consumers reference these instead of the resource directly.
  artifact_registry_location = (
    var.manage_shared_artifact_registry
    ? google_artifact_registry_repository.services[0].location
    : data.google_artifact_registry_repository.services[0].location
  )
  artifact_registry_repository_id = (
    var.manage_shared_artifact_registry
    ? google_artifact_registry_repository.services[0].repository_id
    : data.google_artifact_registry_repository.services[0].repository_id
  )
}

module "api_service" {
  source = "./modules/cloud-run-service"

  count = var.api_image == null ? 0 : 1

  project_id   = var.project_id
  region       = local.api_region
  environment  = local.workspace_environment
  name_prefix  = "hf-${local.workspace_environment}"
  service_name = "api"
  image        = var.api_image
  port         = var.api_port

  cpu    = var.api_cpu
  memory = var.api_memory

  min_instances = var.api_min_instances
  max_instances = var.api_max_instances

  # Startup probe — ensures Cloud Run doesn't route traffic until Prisma,
  # Redis, and all adapters are connected and the Fastify server is listening.
  startup_probe_path          = "/health"
  startup_probe_initial_delay = 0

  # API should be reachable from the internet (Stripe webhooks, browser clients, etc.).
  #
  # CLIENT-IP / INGRESS TRUST CHAIN — READ BEFORE ADDING A LOAD BALANCER.
  # Today the request path is: client → Cloudflare (DNS proxied=true, orange
  # cloud) → Cloud Run domain mapping (CNAME ghs.googlehosted.com, Host-header
  # routed) → this container. There is NO GCLB. Because ingress here is
  # INGRESS_TRAFFIC_ALL, the Cloud Run origin is internet-reachable in
  # principle, so the ONLY thing keeping CF-Connecting-IP unforgeable is that
  # callers can't practically resolve/hit the domain-mapping origin bypassing
  # Cloudflare. The app trusts CF-Connecting-IP to identify the client for
  # rate-limiting / abuse caps — see packages/transport/trpc/src/context.ts
  # (`extractClientIp`) and its `trustProxy` assumptions.
  #
  # WHEN WE INTRODUCE A LOAD BALANCER (GCLB): flip this ingress to
  # "internal-and-cloud-load-balancing", front the GCLB with Cloudflare
  # (and/or enable Cloudflare Authenticated Origin Pulls / mTLS so only
  # Cloudflare can reach the origin), and RE-VERIFY the client-IP header trust
  # chain + `trustProxy` in packages/transport/trpc/src/context.ts. A GCLB adds
  # its own X-Forwarded-For hop, so which header carries the real client IP
  # WILL change — do not assume CF-Connecting-IP survives unchanged.
  ingress               = "INGRESS_TRAFFIC_ALL"
  allow_unauthenticated = var.api_allow_unauthenticated

  env        = local.resolved_api_env
  secret_env = local.api_secret_env

  # Ensure the api runtime SA has been granted secretAccessor on every
  # referenced secret AND IAM has had time to propagate before the Cloud
  # Run service template revalidates secret_key_ref entries.
  depends_on = [time_sleep.wait_for_secret_iam]
}

resource "google_artifact_registry_repository_iam_member" "api_runtime_reader" {
  count = var.api_image == null ? 0 : 1

  project    = var.project_id
  location   = local.artifact_registry_location
  repository = local.artifact_registry_repository_id

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${module.api_service[0].runtime_service_account_email}"
}

module "web_service" {
  source = "./modules/cloud-run-service"

  count = var.web_image == null ? 0 : 1

  project_id   = var.project_id
  region       = local.web_region
  environment  = local.workspace_environment
  name_prefix  = "hf-${local.workspace_environment}"
  service_name = "web"
  image        = var.web_image
  port         = var.web_port

  cpu    = var.web_cpu
  memory = var.web_memory

  min_instances = var.web_min_instances
  max_instances = var.web_max_instances

  startup_probe_path          = "/api/health"
  startup_probe_initial_delay = 0

  # Web should be reachable from the internet (browser clients).
  ingress               = "INGRESS_TRAFFIC_ALL"
  allow_unauthenticated = var.web_allow_unauthenticated

  env        = local.resolved_web_env
  secret_env = local.web_secret_env

  depends_on = [time_sleep.wait_for_secret_iam]
}

resource "google_artifact_registry_repository_iam_member" "web_runtime_reader" {
  count = var.web_image == null ? 0 : 1

  project    = var.project_id
  location   = local.artifact_registry_location
  repository = local.artifact_registry_repository_id

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${module.web_service[0].runtime_service_account_email}"
}

# The identity GitHub Actions authenticates as (GCP_WIF_SERVICE_ACCOUNT): bound
# for workload identity below, and granted narrow rights elsewhere (e.g. the
# search.ensure-format publish in search-reindex.tf).
locals {
  ci_deployer_service_account_email = "github-actions@${var.project_id}.iam.gserviceaccount.com"
}

# We'll put it in the root for now, but use count depending on workspace if you want separation.
# However, you manually created it ONCE for the project.
# So we should only code it to exist ONCE.
module "gh_oidc" {
  source = "./modules/gh-oidc"

  # Only create this resource if we are in the 'dev' workspace (acting as our primary/admin env)
  # AND we want to bring it under management.
  # Since you want to import what exists, and it exists globally in the project,
  # we'll just instantiate it here.
  # But careful: applying this in 'prod' workspace will try to create a duplicate or error
  # if naming collides, unless we restrict it.
  # Given you have ONE project, "dev" is as good a place as any to hold the IAM config.
  count = local.workspace_environment == "dev" ? 1 : 0

  project_id = var.project_id
  # Renamed Hearthfire → Ithasfire. This value is load-bearing twice over: it is
  # the WIF provider's attribute_condition AND the principalSet in the
  # workloadIdentityUser binding. While it said "Hearthfire" an apply would have
  # reverted the live provider and dropped the binding CI authenticates with —
  # locking every workflow (dev AND prod) out of GCP. Only a missing
  # iam.workloadIdentityPoolProviders.update permission (403) prevented that.
  repository_name       = "a-guy-on-the-internet/Ithasfire"
  service_account_email = local.ci_deployer_service_account_email
}


# ─────────────────────────────────────────────────────────────────────────────────
# Meilisearch (Search Service)
# ─────────────────────────────────────────────────────────────────────────────────

# GCS bucket for Meilisearch persistent data
resource "google_storage_bucket" "meilisearch_data" {
  count    = var.enable_meilisearch ? 1 : 0
  name     = "hf-${local.workspace_environment}-meilisearch-data"
  location = var.region
  project  = var.project_id
  # Meilisearch is retired (search runs on Postgres). Allow destroy in all envs
  # so `enable_meilisearch = false` can tear the bucket down — otherwise the
  # prod teardown fails on a non-empty bucket. The data is disposable (a
  # rebuildable search index), so there is nothing to protect here.
  force_destroy = true

  uniform_bucket_level_access = true

  versioning {
    enabled = local.workspace_environment == "prod"
  }
}

module "meilisearch" {
  source = "./modules/cloud-run-service"

  count = var.enable_meilisearch ? 1 : 0

  project_id   = var.project_id
  region       = var.region
  environment  = local.workspace_environment
  name_prefix  = "hf-${local.workspace_environment}"
  service_name = "meilisearch"

  image = var.meilisearch_image
  port  = 7700

  env = {
    MEILI_ENV                 = local.workspace_environment == "prod" ? "production" : "development"
    MEILI_MASTER_KEY          = local.meilisearch_master_key
    MEILI_DB_PATH             = "/meili_data/data.ms"
    MEILI_DUMP_DIR            = "/meili_data/dumps"
    MEILI_SNAPSHOT_DIR        = "/meili_data/snapshots"
    MEILI_HTTP_ADDR           = "0.0.0.0:7700"
    MEILI_LOG_LEVEL           = local.workspace_environment == "prod" ? "INFO" : "DEBUG"
    MEILI_MAX_INDEXING_MEMORY = "512MiB"
  }

  cpu           = var.meilisearch_cpu
  memory        = var.meilisearch_memory
  min_instances = var.meilisearch_min_instances
  max_instances = var.meilisearch_max_instances

  # Mount GCS bucket for persistent storage
  gcs_volume = {
    bucket_name = google_storage_bucket.meilisearch_data[0].name
    mount_path  = "/meili_data"
    read_only   = false
  }

  # Meilisearch uses its own API key authentication (MEILI_MASTER_KEY).
  # Network access is restricted to internal-only (same GCP project).
  # Cloud Run IAM is NOT used here because the meilisearch-js client sends
  # its API key in the Authorization header, which conflicts with the
  # OIDC identity token Cloud Run IAM expects in the same header.
  allow_unauthenticated = true
  ingress               = "INGRESS_TRAFFIC_INTERNAL_ONLY"
}


# ─────────────────────────────────────────────────────────────────────────────────
# Tileserver (self-hosted map tiles via TileServer GL)
# ─────────────────────────────────────────────────────────────────────────────────

# GCS bucket for tileserver PMTiles data (mounted read-only via GCS FUSE)
resource "google_storage_bucket" "tileserver_data" {
  count         = var.enable_tileserver ? 1 : 0
  name          = "hf-${local.workspace_environment}-tileserver-data"
  location      = var.region
  project       = var.project_id
  force_destroy = local.workspace_environment != "prod"

  uniform_bucket_level_access = true
}

module "tileserver" {
  source = "./modules/tileserver"

  count = var.enable_tileserver && var.tileserver_image != null ? 1 : 0

  project_id   = var.project_id
  region       = var.region
  environment  = local.workspace_environment
  name_prefix  = "hf-${local.workspace_environment}"
  service_name = "tileserver"
  image        = var.tileserver_image

  # Tiles are fetched client-side by MapLibre GL in the browser, so the service
  # MUST be publicly reachable.  DDOS mitigation:
  #  - max_instances = 2 caps Cloud Run auto-scaling spend.
  #  - Cloud Run's built-in request queuing handles burst within one container.
  #  - For stronger protection, add Cloud Armor or a Cloudflare Worker proxy.
  allow_unauthenticated = true
  min_instances         = 0
  max_instances         = 2

  # Cap container resources to limit blast radius, but raster rendering sets the
  # floor: MapLibre's native renderer under Xvfb climbs ~60MiB per static image
  # for the first several renders (jemalloc arena warm-up, not a leak) and
  # plateaus near 950MiB.  512Mi was measured to OOM-kill the container on the
  # third static render, which takes vector tiles down with it since the same
  # container serves the browser maps.  Measured under amd64 emulation on arm64,
  # so treat ~950MiB as indicative — the headroom to 2Gi is deliberate.
  cpu    = "1"
  memory = "2Gi"

  # CORS proxy reads ALLOWED_ORIGINS to restrict which browser origins may fetch tiles.
  # Wildcard subdomains (*.ithasfire.com) are supported by cors-proxy.mjs.
  env = {
    ALLOWED_ORIGINS = var.tileserver_allowed_origins
  }

  gcs_volume = {
    bucket_name = google_storage_bucket.tileserver_data[0].name
    mount_path  = "/data/data"
    read_only   = true
  }
}

resource "google_artifact_registry_repository_iam_member" "tileserver_runtime_reader" {
  count = var.enable_tileserver && var.tileserver_image != null ? 1 : 0

  project    = var.project_id
  location   = local.artifact_registry_location
  repository = local.artifact_registry_repository_id

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${module.tileserver[0].runtime_service_account_email}"
}


# ─────────────────────────────────────────────────────────────────────────────────
# Valhalla (self-hosted routing engine for A→B travel time)
#
# Internal-only Cloud Run service.  Scales to zero when idle so the feature gate
# truly controls cost: enable_valhalla=false → 0 instances, 0 spend.
# ─────────────────────────────────────────────────────────────────────────────────

module "valhalla" {
  source = "./modules/valhalla"

  count = var.enable_valhalla && var.valhalla_image != null ? 1 : 0

  project_id   = var.project_id
  region       = var.region
  environment  = local.workspace_environment
  name_prefix  = "hf-${local.workspace_environment}"
  service_name = "valhalla"
  image        = var.valhalla_image

  # Only the API service may call Valhalla.
  invoker_service_accounts = merge(
    var.api_image != null ? { api = module.api_service[0].runtime_service_account_email } : {},
  )

  min_instances = 0
  max_instances = var.valhalla_max_instances
  cpu           = var.valhalla_cpu
  memory        = var.valhalla_memory
}

resource "google_artifact_registry_repository_iam_member" "valhalla_runtime_reader" {
  count = var.enable_valhalla && var.valhalla_image != null ? 1 : 0

  project    = var.project_id
  location   = local.artifact_registry_location
  repository = local.artifact_registry_repository_id

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${module.valhalla[0].runtime_service_account_email}"
}


# ─────────────────────────────────────────────────────────────────────────────────
# Audio Transcoder (Pub/Sub-triggered Cloud Run for MP3 → HLS)
# ─────────────────────────────────────────────────────────────────────────────────

locals {
  audio_transcoder_region = coalesce(var.audio_transcoder_region, var.region)

  # R2 endpoint is deterministic from the Cloudflare account ID.
  r2_endpoint = var.cloudflare_account_id != null ? "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com" : null

  # Audio transcoder defaults to the same R2 bucket/creds as the storage bucket.
  # Wrapped in try() so all-null inputs return null instead of crashing plan;
  # the audio_transcoder module is count-gated on audio_transcoder_image anyway.
  audio_transcoder_s3_bucket     = try(coalesce(var.audio_transcoder_s3_bucket_name, var.storage_s3_bucket_name), null)
  audio_transcoder_s3_endpoint   = try(coalesce(var.audio_transcoder_s3_endpoint, var.storage_s3_endpoint, local.r2_endpoint), null)
  audio_transcoder_s3_key_id     = try(coalesce(var.audio_transcoder_s3_access_key_id, var.storage_s3_access_key_id), null)
  audio_transcoder_s3_secret_key = try(coalesce(var.audio_transcoder_s3_secret_access_key, var.storage_s3_secret_access_key), null)
  audio_transcoder_s3_public_url = try(coalesce(var.audio_transcoder_s3_public_base_url, var.storage_s3_public_base_url), null)
}

# Service account for Pub/Sub push to Audio Transcoder
resource "google_service_account" "audio_transcoder_pubsub_push_invoker" {
  count        = var.audio_transcoder_image == null ? 0 : 1
  account_id   = "hf${local.workspace_environment}-audio-psh"
  display_name = "hf${local.workspace_environment}-audio-psh"
  project      = var.project_id
}

# Runtime SA for the Audio Transcoder, created at ROOT (not inside the module)
# so the secret IAM binding (secrets.tf) can depend on the real SA — fixing the
# fresh-apply "service account does not exist" race — without dragging the whole
# module into that binding's dependency subgraph (which cycles once the module
# must also wait on time_sleep.wait_for_secret_iam). account_id matches the
# module's local.runtime_sa_id ("hf-<env>-audio-rt").
resource "google_service_account" "audio_transcoder_runtime" {
  count        = var.audio_transcoder_image == null ? 0 : 1
  account_id   = "hf-${local.workspace_environment}-audio-rt"
  display_name = "hf-${local.workspace_environment}-audio-transcoder Runtime"
  project      = var.project_id
}

# State-only relocation: dev/prod already have this SA in state at the OLD
# in-module address (the original resource had NO count, the module block does,
# hence module.audio_transcoder[0].google_service_account.runtime). Without this
# block the next apply would DESTROY the in-module SA and CREATE the root one
# with the same account_id (hf-<env>-audio-rt) — which fails because GCP reserves
# deleted SA names ~30 days and the running transcoder depends on it. The moved
# block re-addresses state in place (no destroy/create). account_id + display_name
# are identical to the old module resource, so this is a pure move with no
# attribute drift. When audio_transcoder_image == null both addresses have count
# 0 and the block is a no-op.
moved {
  from = module.audio_transcoder[0].google_service_account.runtime
  to   = google_service_account.audio_transcoder_runtime[0]
}

module "audio_transcoder" {
  source = "./modules/cloud-run-audio-transcoder"

  count = var.audio_transcoder_image == null ? 0 : 1

  project_id  = var.project_id
  region      = local.audio_transcoder_region
  environment = local.workspace_environment
  name_prefix = "hf-${local.workspace_environment}"
  image       = var.audio_transcoder_image

  cpu           = var.audio_transcoder_cpu
  memory        = var.audio_transcoder_memory
  max_instances = var.audio_transcoder_max_instances
  min_instances = var.audio_transcoder_min_instances

  # Pub/Sub push invoker
  invoker_service_accounts = {
    pubsubPush = google_service_account.audio_transcoder_pubsub_push_invoker[0].email
  }

  # S3-compatible storage for source files and HLS output.
  # Defaults to the same R2 bucket/creds as the jobs service. Credentials are
  # injected via secret_env (Secret Manager refs); access_key_id /
  # secret_access_key in this object are no longer rendered onto the Cloud Run
  # service spec but stay here to satisfy the module's variable type.
  s3 = {
    bucket            = local.audio_transcoder_s3_bucket
    endpoint          = local.audio_transcoder_s3_endpoint
    access_key_id     = local.audio_transcoder_s3_key_id
    secret_access_key = local.audio_transcoder_s3_secret_key
    public_base_url   = local.audio_transcoder_s3_public_url
  }

  secret_env = local.audio_transcoder_secret_env

  # Runtime SA is created at root (above) so the secret IAM binding can depend
  # on it directly. The module consumes it rather than creating its own.
  runtime_service_account_email = google_service_account.audio_transcoder_runtime[0].email

  # Gate ONLY the Cloud Run service on secret IAM propagation (mirrors the root
  # api/web/jobs services). Passed as a variable rather than a module-level
  # depends_on so the runtime SA (created at root, referenced by the secret
  # binding) is not forced to wait on time_sleep, which would cycle.
  service_depends_on = [time_sleep.wait_for_secret_iam]

  env = merge(
    var.enable_neon && try(module.environment.neon_pooler_connection_uri, null) != null
    ? {
      DATABASE_URL        = module.environment.neon_pooler_connection_uri
      DIRECT_DATABASE_URL = module.environment.neon_connection_uri
    }
    : {},
    var.enable_upstash && try(module.environment.redis_url, null) != null
    ? { REDIS_URL = module.environment.redis_url }
    : {},
    # Sentry DSN — apps/audio-transcoder/src/instrument.ts reads
    # process.env.SENTRY_DSN at boot, same conditional merge as the API and
    # jobs env above. Until this was wired, every transcode failure — including
    # a full DLQ exhaustion — was visible only as a pino line in Cloud Logging.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_DSN = var.sentry_dsn }
    : {},
    # Sentry environment tag — without it dev + prod transcoders (both
    # NODE_ENV=production) collide in Sentry, same as jobs.
    var.sentry_dsn != null && var.sentry_dsn != ""
    ? { SENTRY_ENVIRONMENT = local.sentry_environment }
    : {},
    var.audio_transcoder_env,
    # Global Redis key prefix — see local.default_redis_namespace above.
    #
    # Merged LAST, deliberately, exactly as in resolved_api_env and
    # resolved_jobs_env: a REDIS_NAMESPACE written into audio_transcoder_env
    # is ignored, not honoured. Every other key in that map is a normal
    # override; this one is the dev/prod isolation boundary and must not be
    # something a tfvars edit can dissolve.
    #
    # Unconditional even though REDIS_URL above is gated and is in fact never
    # set today (enable_upstash is false in every environment, and
    # audio_transcoder_secrets omits REDIS_URL), so the transcoder currently
    # lands on its Postgres/Noop idempotency branch. That is the point: the
    # namespace must already be in place on the day someone wires REDIS_URL
    # here, or idem:audio-transcoder:* would land outside ithasfire:<env> and
    # dev would silently share prod's keyspace.
    { REDIS_NAMESPACE = local.default_redis_namespace },
  )
}

resource "google_artifact_registry_repository_iam_member" "audio_transcoder_runtime_reader" {
  count = var.audio_transcoder_image == null ? 0 : 1

  project    = var.project_id
  location   = local.artifact_registry_location
  repository = local.artifact_registry_repository_id

  role   = "roles/artifactregistry.reader"
  member = "serviceAccount:${module.audio_transcoder[0].service_account_email}"
}

# Allow the API runtime SA to publish transcode requests to the audio-transcode
# Pub/Sub topic. The API switched from direct-calling the internal-only
# transcoder Cloud Run service (404s) to publishing to this topic, which fans
# out to the transcoder via the existing push subscription. Gated on BOTH the
# audio_transcoder module and the api_service existing — mirrors the dual
# requirement (cf. wallet_signer_self, which gates the api SA grant on
# length(module.api_service) > 0).
resource "google_pubsub_topic_iam_member" "api_audio_transcode_publisher" {
  count = var.audio_transcoder_image == null || var.api_image == null ? 0 : 1

  project = var.project_id
  topic   = module.audio_transcoder[0].topic_name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.api_service[0].runtime_service_account_email}"
}

