import { z } from "zod";

const isProd = process.env.NODE_ENV === "production";

const schema = z.object({
  // Prod uses a RESTRICTED key (`rk_live_…`), whose per-resource scopes are
  // listed in docs/ops/stripe-restricted-key-scopes.md. `min(1)` cannot check
  // scope, and Stripe reports a missing permission at CALL time, not at boot —
  // so an under-scoped key boots fine and then fails mid-checkout, mid-Connect
  // onboarding, or inside a settlement transfer. Adding a new Stripe SDK call
  // means adding its permission to the live key AND to that doc.
  STRIPE_SECRET_KEY: isProd ? z.string().min(1) : z.string().optional(),
  STRIPE_API_VERSION: z.string().optional(),
  // Optional: connected account id to use in E2E seed routes.
  E2E_STRIPE_ACCOUNT_ID: z.string().optional(),
  // Optional override for stripe-mock.
  // Example: http://127.0.0.1:12111
  // Treat empty string as undefined so Zod doesn't fail on "STRIPE_BASE_URL="
  STRIPE_BASE_URL: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().url().optional(),
  ),
  // E2E Stripe mode: sandbox (real Stripe test key) or stub (local fake processor).
  E2E_STRIPE_MODE: z.enum(["sandbox", "stub"]).optional(),
  STRIPE_WEBHOOK_SECRET: isProd ? z.string().min(1) : z.string().optional(),
  // Signing secret for the Stripe Connect webhook endpoint (connected-account
  // events such as `account.updated`). REQUIRED in prod.
  //
  // This was previously optional in prod, and that optionality was invisible:
  // Terraform omits the env var entirely when the tfvar is empty, so a missing
  // secret produced no error anywhere — connected-account deliveries simply
  // failed signature verification and were dropped with a Sentry-invisible
  // `logger.warn`. `account.updated` is the only push writer of
  // `Payee.payoutsEnabled = true` (the live status read and the reconcile job
  // heal it later), so dropping it blocks orgs from publishing paid events
  // until a pull heals the row. Fail at boot instead.
  //
  // Empty string is treated as unset so a blank tfvar/CI secret fails loudly
  // rather than being accepted as a (never-matching) signing key.
  STRIPE_CONNECT_WEBHOOK_SECRET: z.preprocess(
    (val) => (val === "" ? undefined : val),
    isProd ? z.string().min(1) : z.string().min(1).optional(),
  ),
  // Dev-only: force connected-account capabilities ON when syncing a Payee row
  // from Stripe (webhook or live read). Seeded Stripe Custom accounts never
  // complete onboarding, so Stripe reports their capabilities inactive and
  // every seeded paid event would become unsellable seconds after
  // `pnpm seed:dev`. Defaults ON outside production; set to "false" to
  // reproduce production capability semantics locally. Always OFF in prod —
  // see `forceConnectCapabilities` below.
  STRIPE_CONNECT_FORCE_CAPABILITIES: z.string().optional(),
  // Better Auth (API-hosted auth server)
  BETTER_AUTH_SECRET: isProd ? z.string().min(32) : z.string().optional(),
  // Shared secret injected into the `x-origin-secret` request header by a
  // Cloudflare Transform Rule (see infra/terraform/modules/cloudflare) on
  // every request that transits the Cloudflare edge. Cloud Run has no GCLB
  // in front of it today (see the trustProxy note in app.ts), so this is
  // the interim way to detect/deny direct-to-origin requests that bypassed
  // Cloudflare's WAF + rate limiting. Required in prod; unused locally
  // (there is no Cloudflare edge in front of local/preview).
  // Length is checked AFTER trimming: Cloudflare stamps the trimmed value, so
  // a 31-char secret plus a trailing newline must not pass as 32.
  ORIGIN_SHARED_SECRET: isProd
    ? z.string().trim().min(32)
    : z.string().optional(),
  // Rollout flag for the origin-secret guard (see plugins/origin-guard.ts).
  // Defaults to false (log-only) on purpose: a misconfigured/missing secret
  // must never be able to 403 every request in prod. Flip to "true" only
  // after confirming `origin_secret_mismatch` warnings are quiet in prod
  // logs (i.e. the Cloudflare Transform Rule is live and matches
  // ORIGIN_SHARED_SECRET).
  ENFORCE_ORIGIN_SECRET: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Rollout mode for the tRPC whole-API `global:<actor>` rate-limit bucket
  // (packages/transport/trpc/src/guard.ts defaultRateLimit). Its 600/min size
  // is estimated from the code, not measured traffic, and SSR is charged to
  // the visitor's IP, so a venue crowd on one IP could trip it. Unset →
  // "shadow": the bucket is charged but a would-deny only increments
  // `trpc.global_rate_limit.would_deny` and logs
  // `global_rate_limit_would_deny`. Set "enforce" once that data looks sane;
  // "off" is the kill switch.
  //
  // An empty or typo'd value (e.g. "Enforce", "") FAILS boot validation, so
  // Cloud Run keeps serving the previous revision instead of rolling out.
  // Exercise the switch in dev before you need it in an incident.
  TRPC_GLOBAL_RATE_LIMIT_MODE: z
    .enum(["enforce", "shadow", "off"])
    .default("shadow"),
  // GDPR consent audit log — IP-hash salt. Required in prod so every
  // consent record carries a one-way device fingerprint; if unset, the
  // tRPC router silently writes `null` for ipHash and Article 7(1)
  // provenance is degraded. Generate via `openssl rand -hex 32`.
  CONSENT_IP_HASH_SALT: isProd ? z.string().min(32) : z.string().optional(),
  // Public base URL where this API is reachable (used by Better Auth to generate callback URLs).
  // Example: https://api.ithasfire.com or http://localhost:3001
  BETTER_AUTH_BASE_URL: z.string().url().optional(),
  // Comma-separated list of trusted origins for Better Auth redirects (web + mobile schemes).
  // Example: "http://localhost:3000,myapp://,exp://*/*"
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  // Explicit `Domain=` value for the cross-subdomain session cookie. Set ONLY
  // in environments where the web + api hosts share a registrable parent and
  // that parent is UNIQUE to the environment (prod: `.ithasfire.com`). MUST be
  // a leading-dot registrable domain (e.g. `.ithasfire.com`). Left UNSET on
  // dev on purpose so dev keeps a host-only cookie and never collides with
  // prod (dev + prod both live under `ithasfire.com`, so a shared `Domain=`
  // would clobber cookies across envs and leak a prod token to dev services).
  // Validated + host-sanity-bound by `resolveCookieDomain`; an invalid value
  // is ignored (logged, cookie stays host-only) rather than throwing at boot.
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  // Dev-only cookie-name prefix. Sets Better Auth's `advanced.cookiePrefix`
  // (see better-auth.ts) so dev's session cookie names differ from prod's on
  // the SHARED `.ithasfire.com` registrable domain. Dev now enables a
  // cross-subdomain cookie (SESSION_COOKIE_DOMAIN=.ithasfire.com) so the
  // web-dev origin can read the api-dev session; without a distinct prefix
  // dev + prod would set a `.ithasfire.com` cookie of the SAME name and
  // clobber each other. Set to e.g. `better-auth-dev` on dev; MUST stay UNSET
  // on prod — prod keeps Better Auth's default `better-auth` prefix, and
  // changing it would rename (invalidate) every live prod session cookie.
  //
  // PINNED TO A `better-auth` PREFIX — this is a cross-app coupling, and the
  // schema is the only place it can be enforced. This var lives in apps/api,
  // but THREE apps/web matchers recognise the resulting cookie NAME:
  //   - `lib/auth/session-cookie.ts` (`startsWith("better-auth")` +
  //     `endsWith(".session_token")`)
  //   - `middleware/private-route-gate.ts` (`SESSION_COOKIE_BASE_NAMES`)
  //   - `middleware/staff-route-gate.ts`, via the first of those
  // The staff gate is what makes this load-bearing rather than cosmetic: it
  // uses cookie presence as a NEGATIVE pre-filter before spending an API round
  // trip, so a prefix those matchers don't recognise (say `ithasfire-dev`)
  // short-circuits EVERY signed-in user to `/sign-in` on `/admin`,
  // `/moderate` AND `/platform` — with no fetch, and no Sentry event, because
  // "no session cookie" is a silent, expected branch. Failing at BOOT with a
  // clear message beats an invisible fleet-wide lockout. Widening this
  // therefore means widening those three matchers in the same change.
  SESSION_COOKIE_PREFIX: z
    .string()
    .startsWith(
      "better-auth",
      "SESSION_COOKIE_PREFIX must start with `better-auth` — apps/web's session-cookie matchers (lib/auth/session-cookie.ts, middleware/private-route-gate.ts) only recognise that family, and the staff-route gate silently bounces every signed-in user to /sign-in for a prefix they don't match.",
    )
    .optional(),
  // Better Auth (authoritative)
  BETTER_AUTH_JWKS_URL: isProd ? z.string().url() : z.string().url().optional(),
  // Optional verification constraints for the Better Auth JWTs.
  BETTER_AUTH_ISSUER: z.string().optional(),
  BETTER_AUTH_AUDIENCE: z.string().optional(),

  // OAuth providers (Google)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_WEB_CLIENT_ID: z.string().optional(),
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),

  // Spotify Web API (Client Credentials flow) for public artist enrichment on
  // musician EPKs. Both optional — feature is opt-in and no-ops when absent.
  // Client id is not sensitive (arguably public); the secret is sensitive.
  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),

  // OAuth providers (Apple)
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_SECRET: z.string().optional(),
  // Bundle identifier for iOS native sign-in (e.g., "com.ithasfire.mobile")
  APPLE_APP_BUNDLE_IDENTIFIER: z.string().optional(),

  // AWS credentials (for SNS SMS and SES email)
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  // Registered US origination number (10DLC or toll-free; E.164 or
  // phone-number ARN) per use case: passcodes and notifications. One number
  // in both variables is the expected setup. Sent as
  // AWS.MM.SMS.OriginationNumber; when only one is set it sends both kinds.
  // SMS stays off (options hidden) until at least one is set. Empty string
  // is unset.
  AWS_SMS_ORIGINATION_OTP: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().min(1).optional(),
  ),
  AWS_SMS_ORIGINATION_NOTIFICATIONS: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().min(1).optional(),
  ),
  // Ceiling on passcode texts across ALL callers per rolling hour, applied
  // to each of two pools: phone verification and 2FA
  // (`auth/otp-sms-budget.ts`). Bounds SMS pumping once the per-IP /
  // per-number limits are spread over many IPs and numbers. Phone OTP over
  // the cap answers 429; 2FA over the cap falls back to email.
  AUTH_OTP_SMS_MAX_PER_HOUR: z.coerce.number().int().positive().default(300),
  // Topic ARN allow-list for the AWS SNS two-way SMS inbound webhook
  // (POST /webhooks/aws/sms-inbound — STOP/START consent reconciliation).
  // The route answers 503 not_configured when unset; only envelopes whose
  // TopicArn matches exactly are accepted (NFR-002 in
  // docs/specs/2026-05-18/completed/sms-opt-out-sns.spec.yaml). Empty string
  // is treated as unset.
  AWS_SNS_SMS_INBOUND_TOPIC_ARN: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().min(1).optional(),
  ),

  // If this defaults to localhost, the API will repeatedly attempt to connect
  // and log noisy ECONNREFUSED errors in environments where Redis isn't
  // started (e.g. certain CI/E2E runs). Make it opt-in.
  REDIS_URL: z.string().optional(),
  /**
   * Key namespace for every Redis key this service writes (ioredis
   * `keyPrefix`). Terraform emits `ithasfire:<env>`; dev and prod share one
   * Upstash database, so without this their keys collide.
   */
  REDIS_NAMESPACE: z.string().optional(),
  IDEMPOTENCY_BACKEND: z.enum(["redis", "postgres"]).default("redis"),
  APP_BASE_URL: z.string().default("http://localhost:3001"),
  /** Public web app URL used in transactional email links (invitation accept, etc.). */
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  /** Support/help page URL used in transactional emails and receipts. */
  SUPPORT_URL: z.string().optional(),

  // SMTP mail (used by MailerPort adapter)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  // Use transform instead of coerce because coerce would make "0" and "false" truthy
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? undefined : v === "true" || v === "1",
    ),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_DEFAULT_FROM_EMAIL: z.string().email().optional(),
  SMTP_APP_HEADER: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  PRODUCT_NAME: z.string().default("Ithas Fire"),
  GEO_BACKEND: z.string().optional(),

  S3_BUCKET: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || undefined : v),
    z.string().optional(),
  ),
  S3_PUBLIC_READ: z.string().optional(),

  // Meilisearch (search service)
  MEILISEARCH_HOST: z.string().url().optional(),
  MEILISEARCH_API_KEY: z.string().optional(),
  SEARCH_BACKEND: z.enum(["meili", "postgres"]).default("postgres"),
  SEARCH_W_FULLTEXT: z.coerce.number().default(1.0),
  SEARCH_W_PREFIX: z.coerce.number().default(0.7),
  SEARCH_W_FUZZY: z.coerce.number().default(0.5),
  SEARCH_W_POPULARITY: z.coerce.number().default(0.05),
  SEARCH_W_GEO: z.coerce.number().default(1.0),

  // Self-hosted tileserver (static map images for transactional emails)
  TILESERVER_URL: z.string().url().optional(),

  // Cloudflare Turnstile (bot protection for public embed checkout)
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // HMAC secret for generating/verifying announcement unsubscribe tokens.
  // Required in production; optional locally (unsubscribe links won't work without it).
  // ALSO the root the location obfuscation key is HKDF-derived from
  // (`packages/core/src/lib/location/obfuscation-key.ts`), shared with the
  // jobs service. Absent → every obscured location renders fully hidden.
  // Rotating it moves every public obfuscation circle.
  UNSUBSCRIBE_SECRET: isProd
    ? z.string().min(32)
    : z.string().min(1).optional(),

  // Physical mailing address appended to announcement emails (CAN-SPAM compliance).
  // E.g. "123 Main St, Anytown, ST 12345"
  SENDER_PHYSICAL_ADDRESS: z.string().optional(),

  // Ziptax (US sales tax rate lookup by postal code)
  ZIPTAX_API_KEY: z.string().optional(),

  // Expo push notifications. Expo's public push API needs no auth by default;
  // this is the optional "enhanced security" access token (Expo dashboard →
  // Access tokens). The adapter is constructed unconditionally either way.
  EXPO_ACCESS_TOKEN: z.string().optional(),

  // Valhalla (self-hosted routing engine for A→B travel time)
  VALHALLA_URL: z.string().url().optional(),

  // Feature flag: when "true", expose the travel-time endpoint.
  // Silently ignored when VALHALLA_URL is not set.
  ENABLE_TRAVEL_TIME: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // Feature flag: when "false", event creation mutations are rejected.
  // Defaults to true so existing deployments are unaffected.
  ENABLE_CREATE_EVENTS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === "true" || v === "1")),

  // Feature flag: when "false", ticket purchase / checkout mutations are rejected.
  // Defaults to true so existing deployments are unaffected.
  ENABLE_BUY_TICKETS: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === "true" || v === "1")),

  // Feature flag: when "true", all non-exempt routes show a maintenance screen.
  // Defaults to false so normal operation is unaffected.
  ENABLE_MAINTENANCE_MODE: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", admin web /scan renders the unified resolver
  // UI (single camera + manual search) backed by `scan.resolvePayload`.
  // Defaults to false so the existing two-mode ticket-only page keeps shipping.
  ENABLE_UNIFIED_SCAN_RESOLVER: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", the event-builder surfaces the waiver section
  // and checkout enforces waiver acceptance. Off by default until the legal
  // copy + acceptance audit log are signed off.
  ENABLE_WAIVERS: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", the freeform entity-page block editor (grid/stack
  // canvas) is unlocked for artist/venue/promoter pages. Off by default — pages
  // use the app-controlled standard template until a platform admin opts in.
  ENABLE_ENTITY_PAGE_EDITOR: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", the org-level messaging CRM (audiences +
  // announcements) is surfaced in the admin nav and its routes are reachable.
  // Off by default until outbound email/SMS blasting is vetted for
  // compliance/deliverability.
  ENABLE_BROADCASTS: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", the ticket-resale admin surfaces (resale
  // listings page + the resale parts of the Default agreement settings) are
  // reachable. Off by default until the resale flow is vetted.
  ENABLE_RESALE: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", PUBLIC human ("user account") entity-page
  // profiles are reachable (`/humans/[slug]`, the HUMAN variant of `/p/[slug]`,
  // and human hits in public search). Off by default — the profiles stay hidden
  // (404) until an editor exists. Org/place profiles and the human's own
  // admin/ownership surfaces are unaffected. Admin-toggleable via the DB
  // setting `feature:humanProfilesPublic`, so no deploy is required to flip it.
  ENABLE_HUMAN_PROFILES_PUBLIC: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Feature flag: when "true", the event waitlist ("notify me") surfaces are
  // reachable — the public join form on the event page and the organiser-side
  // waitlist configuration in the event builder. Off by default because only
  // the join half exists: nothing sets `NOTIFIED`, and there's no release
  // trigger, job, or admin roster. Admin-toggleable via the DB setting
  // `feature:waitlists`, so no deploy is required to flip it.
  ENABLE_WAITLISTS: z
    .string()
    .optional()
    .transform((v) => v !== undefined && (v === "true" || v === "1")),

  // Internal Jobs service URL (used to proxy staff admin calls)
  JOBS_SERVICE_URL: z.string().url().optional(),

  // Pub/Sub topic prefix for waking outbox drains after a committed write
  // (`projects/<project>/topics/<env>-`). Injected by Terraform
  // (infra/terraform/main.tf); its presence selects the Pub/Sub trigger. See
  // `DRAIN_TRIGGERS` in @th/ports/job-trigger.
  JOB_TRIGGER_TOPIC_PREFIX: z.string().min(1).optional(),
  // Local opt-in when no topic prefix is set: `http` wakes drains by POSTing
  // JOBS_SERVICE_URL directly. Unset = no wake-ups (the scheduled safety net
  // is the only trigger).
  JOB_TRIGGER_BACKEND: z.enum(["http"]).optional(),

  // Shared secret for authenticating requests to the jobs service.
  // Must match JOBS_API_KEY on the jobs service side.
  JOBS_API_KEY: z.string().min(16).optional(),

  // Edit-triggered search reindex drain (Cloud Tasks). Both set by Terraform;
  // either unset = no delayed drain (marks wait for the nightly full reindex).
  // Queue: `projects/<project>/locations/<region>/queues/<queue>`.
  CLOUD_TASKS_QUEUE: z.string().min(1).optional(),
  // Dedicated queue for `lineup-notices.continue-sweep`, which must NOT share
  // the search drain's (that one is pinned to one dispatch at a time for a
  // search-only reason). Set by Terraform (infra/terraform/lineup-notice-sweep.tf).
  // Unset = continuations fall back to CLOUD_TASKS_QUEUE, the behaviour they
  // had before the queue existed. See createLineupSweepContinuation.
  CLOUD_TASKS_LINEUP_SWEEP_QUEUE: z.string().min(1).optional(),
  // Dedicated queue for `tax.fill-location-rate` (background venue tax-rate
  // fills queued by listings). Its own, NOT the search drain's: a provider
  // outage would otherwise park hundreds of slow failing lookups ahead of
  // every drain on that single-dispatch queue. Set by Terraform
  // (infra/terraform/tax-rate-fill.tf). Unset = NO fallback: nothing is
  // queued, cards say "See details" until a checkout, an event-page quote or
  // the nightly reindex fills the venue. See createTaxRateFillScheduler.
  CLOUD_TASKS_TAX_FILL_QUEUE: z.string().min(1).optional(),
  // Service account whose OIDC token the tasks carry to the jobs service.
  // Shared by every queue.
  CLOUD_TASKS_INVOKER_SA: z.string().email().optional(),
  // Earliest drain after an edit / slot width edits share one drain in.
  // Floor 30s: at 0 a rescheduling drain would compute its OWN slot, a task
  // name Cloud Tasks refuses while that task runs.
  SEARCH_REINDEX_DRAIN_DELAY_S: z.coerce.number().int().min(30).max(3600).optional(),
  SEARCH_REINDEX_DRAIN_WINDOW_S: z.coerce.number().int().min(1).max(3600).optional(),

  // Volunteer scanner: HMAC secret for the human+event-scoped volunteer QR
  // tokens. Distinct from the ticket QR secret so we can rotate
  // them independently. When unset, volunteer mint/resolve procedures
  // return `not_configured`.
  //
  // Length floor, matching BETTER_AUTH_SECRET / UNSUBSCRIBE_SECRET: this is
  // an HS256 key, the whole token is offline-crackable from a single captured
  // QR, and recovering it forges a token for ANY human at ANY event — while
  // the only remediation is rotating it, which voids every outstanding
  // organizer badge platform-wide. Tokens now legitimately live on paper, so
  // "captured" is a realistic starting point rather than a theoretical one.
  // Stays `.optional()`: unset is a supported state (the port is left null and
  // the procedures answer `not_configured`); what is not supported is a SET
  // but weak secret.
  // NOTE the `.optional()` on BOTH branches — unlike BETTER_AUTH_SECRET this
  // key is genuinely not required in prod. The floor gates a SET value; it
  // must not turn "feature off" into a boot crash.
  VOLUNTEER_SCAN_TOKEN_SECRET: isProd
    ? z.string().min(32).optional()
    : z.string().min(16).optional(),
  // TTL (in hours) for `short` volunteer scan tokens. Defaults to 24h.
  VOLUNTEER_QR_TTL_HOURS: z.coerce.number().int().positive().optional(),

  // Public URLs for the scanner app — surfaced in onboarding emails and on
  // the /admin/[slug]/scanner-setup page. Either may be omitted; UI and email
  // render only the platforms with a URL configured. Use TestFlight / Play
  // internal-track URLs while the app is off-marketplace.
  SCANNER_APP_IOS_URL: z.string().url().optional(),
  SCANNER_APP_ANDROID_URL: z.string().url().optional(),

  // Support chat rate limits (per authenticated human, Redis fixed-window).
  // The send path enforces a two-tier limiter — a tight burst window to stop
  // rapid-fire flooding plus a wider sustained window to cap total volume — and
  // staff replies get a single generous backstop against a runaway/scripted
  // client. Both send tiers are independent counters; a request must pass both.
  SUPPORT_SEND_BURST_MAX: z.coerce.number().int().positive().default(5),
  SUPPORT_SEND_BURST_WINDOW_S: z.coerce.number().int().positive().default(10),
  SUPPORT_SEND_SUSTAINED_MAX: z.coerce.number().int().positive().default(30),
  SUPPORT_SEND_SUSTAINED_WINDOW_S: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  SUPPORT_REPLY_MAX: z.coerce.number().int().positive().default(60),
  SUPPORT_REPLY_WINDOW_S: z.coerce.number().int().positive().default(60),

  // In-process read caches that let production Neon suspend between uptime
  // checks (see `ttl-read-through-cache.ts` / `with-cached-platform-settings.ts`).
  // Both are tagged with a shared Redis generation, bumped by every actor
  // mutation (failed ones too), every committed search-index write (API and
  // jobs) and every e2e reset/seed. A change that went through one of those
  // reaches another instance within that cache's *_GENERATION_MEMO_S; the
  // writing instance at once. The TTL only bounds what nothing bumps for:
  // the clock (an event starting, a price tier flipping), direct DB scripts,
  // and a failed INCR (reported). Redis unreachable → no caching at all.
  // PUBLIC_DISCOVERY: the anonymous home-page lists (`events.countryEvents`,
  // `search.featuredEvents`). 0 disables the cache.
  // PLATFORM_SETTINGS: the feature-gate snapshot. Point reads stay at 60s.
  // *_GENERATION_MEMO_S: cross-instance staleness after a write, AND the cap
  // on Redis GETs (one per window per instance) — the Upstash budget knob,
  // see docs/ops/resource-burn.md RB-0003.
  PUBLIC_DISCOVERY_CACHE_TTL_S: z.coerce.number().int().nonnegative().default(900),
  PUBLIC_DISCOVERY_GENERATION_MEMO_S: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  PLATFORM_SETTINGS_GENERATION_MEMO_S: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  PLATFORM_SETTINGS_CACHE_TTL_S: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(900),

  // Dev/test: when "true", settlements are scheduled for immediate payout
  // so the batch runner picks them up on the next cycle. Never enable in production.
  DEV_INSTANT_PAYOUTS: z
    .string()
    .optional()
    .transform((v) => !isProd && (v === "true" || v === "1")),

  // Sentry error tracking
  SENTRY_DSN: z.string().optional(),
  // Sentry organisation slug used to build issue deep-links in operational
  // alerts (e.g. the Discord "View issue" link on tRPC unhandled errors).
  // Optional — callers default to the stable SaaS org (`hearth-fire`) when
  // unset, so no infra apply is needed. Set to override.
  SENTRY_ORG: z.string().optional(),

  // Discord alerts webhook for operational events (new users, email verifications,
  // place reviews, job failures, etc.). Separate from DISCORD_DEPLOY_WEBHOOK which
  // is only used in CI. Optional — alerts are silently skipped when not set.
  DISCORD_ALERTS_WEBHOOK: z.string().url().optional(),

  // Dedicated Discord webhook for the support chat widget so support pings land
  // in their own channel, separate from the ops/agent noise above. Optional —
  // support alerts are silently skipped (best-effort) when not set.
  // See docs/specs/2026-06-23/completed/support-chat-widget.spec.yaml.
  DISCORD_SUPPORT_WEBHOOK: z.string().url().optional(),

  // ── Wallet Passes (Apple Wallet / Google Wallet) ────────────────────────────
  // All optional — the adapter falls back to a stub when not set.
  APPLE_PASS_CERTIFICATE_P12_BASE64: z.string().optional(),
  APPLE_PASS_CERTIFICATE_PASSWORD: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_PASS_TYPE_IDENTIFIER: z.string().optional(),
  GOOGLE_WALLET_ISSUER_ID: z.string().optional(),
  // Optional: explicit signer SA email for the Google Wallet adapter. When
  // omitted the adapter signs as Application Default Credentials (the Cloud
  // Run runtime SA in prod, gcloud user locally). Useful for local dev
  // where the user wants to sign as the dev/prod runtime SA explicitly.
  GOOGLE_WALLET_SIGNER_EMAIL: z.string().optional(),
});

const schemaWithRefinements = schema.superRefine((value, ctx) => {
  // In production, public image uploads (event hero images) go through the
  // S3/R2 file-storage adapter with `public: true`. That adapter throws
  // `public_base_url_not_configured` at request time when S3_PUBLIC_BASE_URL
  // is empty — which previously surfaced as a silent per-request 500. When
  // S3/R2 storage is configured (S3_BUCKET set), require a valid public base
  // URL at boot so the misconfiguration fails loudly on startup instead.
  if (isProd && value.S3_BUCKET) {
    const publicBaseUrl = value.S3_PUBLIC_BASE_URL?.trim();
    if (!publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_PUBLIC_BASE_URL"],
        message:
          "S3_PUBLIC_BASE_URL is required in production when S3_BUCKET is set (public image uploads will fail without it)",
      });
      return;
    }
    if (!z.string().url().safeParse(publicBaseUrl).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["S3_PUBLIC_BASE_URL"],
        message:
          "S3_PUBLIC_BASE_URL must be a valid URL (e.g. https://cdn.ithasfire.com)",
      });
    }
  }
});

// parse with process.env; in dev we want missing keys to be undefined rather than throw
export const env = schemaWithRefinements.parse(process.env);

/**
 * Whether to force connected-account capabilities ON when syncing a `Payee`
 * row from Stripe.
 *
 * Hard-coded `false` in production — production must always trust Stripe's
 * real capability state. Outside production it defaults ON (seeded Stripe
 * Custom accounts never complete onboarding), and can be switched off with
 * `STRIPE_CONNECT_FORCE_CAPABILITIES=false` to reproduce production semantics
 * locally. That switch is the only way to exercise the DB-row-vs-live-Stripe
 * divergence outside prod.
 */
export const forceConnectCapabilities =
  !isProd && env.STRIPE_CONNECT_FORCE_CAPABILITIES !== "false";
