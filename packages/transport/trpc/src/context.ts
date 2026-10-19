import type { MailerPort } from "@th/ports/comms/mailer";
import type { PushPort } from "@th/ports/comms/push";
import type { FooterDefaultsCachePort } from "@th/ports/comms/footer-defaults";
import type {
  NotifyInput,
  NotifyOutput,
} from "@th/core/use-cases/comms/notify";
import type { NotifySupportFn } from "@th/core/use-cases/support";
import type { LineupSweepContinuation } from "@th/core/use-cases/event-humans/_shared/lineup-sweep-continuation";
import type { ApiKeyScope, AuthNPort } from "@th/ports/authn";
import type { AuthZPort } from "@th/ports/authz";
import type { TranslatorPort } from "@th/ports/translator";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { GeoPort } from "@th/ports/geo";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  CacheGenerationPort,
  ReadThroughCachePort,
} from "@th/ports/read-through-cache";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { Repos } from "@th/ports/repos";
import type {
  PlaceLayoutGeometryParserPort,
  PlaceLayoutStreamingPort,
} from "@th/ports/place-layouts";
import type {
  SearchPromptPort,
  SearchQueryPort,
  MultiSearchPort,
} from "@th/ports/search";
import type { TurnstilePort } from "@th/ports/turnstile";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TimezoneLookupPort } from "@th/ports/timezone-lookup";
import type { MusicStatsPort } from "@th/ports/music-stats";
import type { RoutingPort } from "@th/ports/routing.port";
import type { WalletPassPort } from "@th/ports/wallet-pass.port";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";
import { normalizeString } from "./utils";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import {
  checkClientIpForward,
  resolveClientIp,
  transitedEdge,
  type ClientIpForwardVerdict,
} from "./client-ip";
import { extractViewerLocation, type ViewerLocation } from "./viewer-location";

export type { ViewerLocation, ViewerLocationSource } from "./viewer-location";

export type RequestAuth = {
  userId?: string | null;
  sessionId?: string | null;
  token?: string | null;
};

export type HeadersLike = Record<string, unknown> & {
  authorization?: unknown;
  cookie?: unknown;
  "x-api-key"?: unknown;
  "x-request-id"?: unknown;
  "x-correlation-id"?: unknown;
};

const extractBearerToken = (
  headers: HeadersLike | null | undefined,
): string | null => {
  if (!headers) return null;
  const raw = headers.authorization;
  if (typeof raw !== "string") return null;
  const [schemeRaw, token] = raw.split(" ");
  if (!token) return null;
  if (typeof schemeRaw !== "string" || schemeRaw.toLowerCase() !== "bearer")
    return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractApiKey = (
  headers: HeadersLike | null | undefined,
): string | null => {
  if (!headers) return null;
  const raw = headers["x-api-key"];
  return normalizeString(raw);
};

const extractCorrelationId = (
  headers: HeadersLike | null | undefined,
): string | null => {
  if (!headers) return null;
  const raw = headers["x-correlation-id"];
  return normalizeString(raw);
};

const extractRequestId = (
  headers: HeadersLike | null | undefined,
): string | null => {
  if (!headers) return null;
  const raw = headers["x-request-id"];
  return normalizeString(raw);
};

type RequestSocketLike = {
  remoteAddress?: unknown;
};

/**
 * Resolve the client IP used for anti-abuse controls (the anonymous
 * suggestion transport limiter and the per-IP pending-suggestion cap).
 *
 * Precedence lives in {@link resolveClientIp} /
 * {@link import("./client-ip").CLIENT_IP_HEADER_PRECEDENCE}: forwarding headers
 * first (`cf-connecting-ip` → `true-client-ip` → `x-real-ip` → leftmost
 * `x-forwarded-for`), server-observed socket LAST. Behind our proxy chain the
 * socket peer is Google's internal Cloud Run frontend — identical for every
 * anonymous visitor — so socket-only resolution collapsed all anonymous
 * traffic into one rate-limit bucket. This mirrors `viewer-location.ts`, which
 * already trusts `cf-connecting-ip` for geo.
 *
 * SECURITY / hop-trust assumption (LB-revisit): `CF-Connecting-IP` is
 * unforgeable ONLY while traffic actually transits Cloudflare. Today the Cloud
 * Run origin has public ingress and there is NO GCLB in front of it (see
 * infra/terraform/stack/main.tf — Cloudflare-proxied records + a Cloud Run
 * domain mapping to ghs.googlehosted.com, no load balancer), so a request that
 * bypasses Cloudflare and hits the origin directly could forge this header.
 * That is an ACCEPTED soft-cap risk for now: these controls only throttle an
 * anonymous suggestion queue that is fully moderated before anything is public.
 *
 * WHEN A LOAD BALANCER (GCLB) IS INTRODUCED — i.e. client → Cloudflare → GCLB →
 * Cloud Run with internal ingress / Authenticated Origin Pulls — re-verify this
 * header precedence and the single-hop trust assumption, and reconsider whether
 * Fastify's `trustProxy` / `req.ip` (see apps/api/src/app.ts) should replace
 * these explicit header reads. The `trustProxy` note over there cross-references
 * this one.
 */
/**
 * Where `ctx.clientIp` came from:
 * - `forwarded`: a verified signed forward from our web server — the visitor.
 * - `edge`: no valid forward; the request came through Cloudflare
 *   (`cf-connecting-ip` present), so `clientIp` is Cloudflare's view of the
 *   caller — every ordinary browser request.
 * - `direct`: no valid forward AND no `cf-connecting-ip`: the request reached
 *   the origin without transiting Cloudflare. In practice that is our own web
 *   server's internal SSR calls whose forward is missing or broken (so
 *   `clientIp` is the web's egress address, shared by every visitor), local
 *   dev / e2e over loopback, or a caller hitting the *.run.app origin. See
 *   `defaultRateLimit` in guard.ts for the one thing it changes (anonymous
 *   callers skip the GLOBAL bucket) and why that grants no outside caller
 *   anything new.
 */
export type ClientIpSource = "forwarded" | "edge" | "direct";

/**
 * Rollout mode for the whole-API `global:<actor>` bucket (guard.ts
 * `defaultRateLimit`):
 * - `enforce`: a would-deny is a 429.
 * - `shadow` (the default): the bucket is still charged in the same single
 *   `consumeMany`, but a would-deny only increments
 *   `trpc.global_rate_limit.would_deny` and logs
 *   `global_rate_limit_would_deny` (throttled). See guard.ts for why shadow is
 *   the default until measured.
 * - `off`: the bucket is not charged at all.
 */
export type GlobalRateLimitMode = "enforce" | "shadow" | "off";

type ExtractedClientIp = {
  clientIp: string | null;
  source: ClientIpSource;
  /** Set only when all three forward headers were sent and were rejected. */
  rejected: Extract<ClientIpForwardVerdict, { ok: false }> | null;
};

const extractClientIp = (
  req: CreateContextInput["req"],
  forwardSecret: string | null | undefined,
  nowSeconds: number,
): ExtractedClientIp => {
  const headers = req.headers ?? null;
  // A signed forward from our own web server wins: on web → API
  // server-to-server calls every header below describes the WEB SERVER, not
  // the guest. An absent/invalid/stale forward is ignored and resolution is
  // exactly what it was before — see `checkClientIpForward` in client-ip.ts.
  const verdict = checkClientIpForward(headers, forwardSecret, nowSeconds);
  if (verdict.ok) {
    return { clientIp: verdict.ip, source: "forwarded", rejected: null };
  }
  return {
    clientIp: resolveClientIp(
      headers,
      req.raw?.socket?.remoteAddress ?? req.socket?.remoteAddress,
    ),
    source: transitedEdge(headers) ? "edge" : "direct",
    rejected: verdict.complete ? verdict : null,
  };
};

/** Seconds from the injected clock, falling back to the system clock. */
const nowSecondsFrom = (clock: ClockPort | null | undefined): number => {
  try {
    const ms = clock?.now().getTime();
    if (typeof ms === "number" && Number.isFinite(ms)) {
      return Math.floor(ms / 1000);
    }
  } catch {
    // A broken clock must not break context creation.
  }
  return Math.floor(Date.now() / 1000);
};

/**
 * A rejected forward (all three headers sent, verification failed) can mean
 * the web and API disagree — a secret rotated on one side, or drifting clocks
 * — and then every guest silently falls back to the web server's IP. That
 * must be visible, so each rejection is logged at ERROR (warn is not captured
 * by Sentry) and reported, both throttled to one per (`reason`, `via`) per
 * 15 minutes: a sustained break still leaves periodic breadcrumbs, and a
 * caller spraying junk headers cannot flood Sentry.
 *
 * `via` separates the two populations, and only one of them is our bug:
 * - `via=direct` (no `cf-connecting-ip`): the forward reached the API without
 *   transiting Cloudflare — normally our own web server's internal SSR path,
 *   where a rejection means a web↔API break (secret mismatch, clock drift).
 *   Alert on this one. Caveat: while the origin guard is log-only
 *   (ENFORCE_ORIGIN_SECRET off), a caller hitting the API's *.run.app origin
 *   directly with junk `x-th-client-ip*` headers ALSO lands here as
 *   `bad_sig via=direct`. Before rotating anything, check the logged
 *   `forwardedFor` on the request: our web server's egress address means a
 *   real break; anything else is a direct-to-origin prober.
 * - `via=edge`: the request came through Cloudflare, so the `x-th-client-ip*`
 *   headers were written by whoever sent it — any browser or scanner can
 *   produce `bad_sig` this way. Noise, tagged apart so muting it never mutes
 *   the real signal. (The web unlock/claim/sync routes also call the API via
 *   the edge; a break there shows up here too, alongside the direct-path
 *   reports that the SSR traffic will produce.)
 *
 * Memoized per `deps` object (one per `createContextFactory` call, i.e. per
 * process) so the throttle window survives across requests — the same reason
 * guard.ts memoizes its rate-limit reporter in a WeakMap.
 */
const CLIENT_IP_FORWARD_REPORT_THROTTLE_MS = 15 * 60 * 1000;
const forwardRejectionReporters = new WeakMap<TrpcDeps, ReporterPort>();

const getForwardRejectionReporter = (deps: TrpcDeps): ReporterPort => {
  let reporter = forwardRejectionReporters.get(deps);
  if (!reporter) {
    reporter = createThrottledReporter((error, context) => {
      try {
        deps.logger?.error("client_ip_forward_rejected", {
          ...(context?.extra ?? {}),
        });
      } catch {
        // Logging is best-effort here.
      }
      try {
        deps.reportError?.(error, context);
      } catch {
        // A throwing reporter must never break context creation.
      }
    }, CLIENT_IP_FORWARD_REPORT_THROTTLE_MS);
    forwardRejectionReporters.set(deps, reporter);
  }
  return reporter;
};

const reportRejectedForward = (
  deps: TrpcDeps,
  rejected: Extract<ClientIpForwardVerdict, { ok: false }>,
  via: "edge" | "direct",
): void => {
  try {
    getForwardRejectionReporter(deps)(
      new Error(`client_ip_forward_rejected: ${rejected.reason} via ${via}`),
      {
        tags: {
          area: "client_ip_forward_rejected",
          reason: rejected.reason,
          via,
        },
        extra: {
          reason: rejected.reason,
          via,
          ...(rejected.skewSeconds !== undefined
            ? { skewSeconds: rejected.skewSeconds }
            : {}),
        },
      },
    );
  } catch {
    // Never let reporting break context creation.
  }
};

const extractUserAgent = (
  headers: HeadersLike | null | undefined,
): string | null => {
  if (!headers) return null;
  const raw = headers["user-agent"];
  const s = normalizeString(raw);
  if (!s) return null;
  return s.slice(0, 1024);
};

const extractCookieHeader = (
  headers: HeadersLike | null | undefined,
): string | null => {
  if (!headers) return null;
  return normalizeString(headers.cookie);
};

export type NotifyFn = (input: NotifyInput) => Promise<NotifyOutput>;

export type TrpcDeps = {
  repos: Repos;
  fileStorage: FileStoragePort;
  payments: PaymentProcessorPort;
  /**
   * Recurring billing for memberships (Stripe Billing). Optional — absent
   * when no Stripe key is configured; the membership procedures that need it
   * fail with NOT_CONFIGURED rather than pretending to bill.
   */
  membershipBilling?: MembershipBillingPort | null;
  authn: AuthNPort;
  authz: AuthZPort;
  logger: LoggerPort;
  /**
   * Optional metrics sink. Use cases call `metrics?.increment(...)`
   * for spec-listed telemetry events (POS, scan, etc.). When omitted
   * the calls no-op — safe in test environments without a wired sink.
   */
  metrics?: MetricsPort | null;
  /**
   * Optional best-effort error reporter (wired to `Sentry.captureException` at
   * the API layer). Threaded into use cases that catch-and-swallow operational
   * failures — e.g. search backend errors that fall back to empty/Postgres —
   * so those stop being invisible in Sentry. Always fail-safe.
   */
  reportError?: ReporterPort | null;
  /**
   * Machine translation for the /platform category forms' prefill (Google
   * Cloud Translation). Absent when `GCP_PROJECT_ID` is unset (local dev):
   * `suggestCategoryTranslations` then returns no suggestions.
   */
  translator?: TranslatorPort | null;
  /**
   * Dev-only: force connected-account capabilities ON when syncing a `Payee`
   * row from Stripe. Seeded Stripe Custom accounts never complete onboarding,
   * so their real capabilities are inactive and every seeded paid event would
   * become unsellable. Wired from `forceConnectCapabilities` in
   * `apps/api/src/lib/env.ts`, which hard-codes `false` in production.
   */
  forceConnectCapabilities?: boolean;
  idempotency: IdempotencyPort;
  /** Fixed-window rate limiter (Redis-backed). */
  rateLimit: RateLimitPort;
  /** User-submitted text/content moderation. */
  contentFilter: ContentFilterPort;
  clock: ClockPort;
  placeLayoutParser: PlaceLayoutGeometryParserPort;
  placeLayoutStreaming: PlaceLayoutStreamingPort;
  searchQuery: SearchQueryPort;
  searchPrompts: SearchPromptPort;
  /**
   * Multi-index search for events, humans, places. Optional — falls back
   * to Postgres when absent. Includes the write side so use cases like
   * publish-event can incrementally upsert documents on success.
   */
  multiSearch?: MultiSearchPort | null;
  geo: GeoPort;
  notify: NotifyFn;
  /**
   * notify() with the MAILER bound, for flows whose email leg must send
   * inline from the request path (e.g. the booking-request-received venue
   * notification, FR-008). `notify` above deliberately omits the mailer —
   * many inline consumers rely on the email channel skipping
   * (`port_unavailable`) and send their emails through dedicated mailers or
   * outbox drains instead — so binding the mailer there would silently turn
   * on email for all of them. Optional: absent (tests, older composition
   * roots) callers fall back to `notify` and email degrades to a skip.
   */
  notifyWithEmail?: NotifyFn | null;
  /**
   * Delayed continuation of the post-publish lineup sweep (Cloud Tasks, on
   * the dedicated lineup-notice-sweep queue —
   * infra/terraform/lineup-notice-sweep.tf; the composition root falls back
   * to the search-drain queue's scheduler in environments applied before that
   * queue existed): rows the publish request's 10s sweep did not reach are
   * handed to `lineup-notices.continue-sweep`. Absent/null = they are
   * reported and wait for a future publish.
   */
  lineupSweepContinuation?: LineupSweepContinuation | null;
  /** Optional mailer for transactional emails (invitation, ticket issued, etc.). */
  mailer?: MailerPort | null;
  /**
   * Optional push port (Expo adapter at the API layer). Used by the device
   * register/unregister procedures; notify()'s push channel gets its own
   * binding where notify deps are assembled.
   */
  push?: PushPort | null;
  /**
   * Cache for platform-level email footer defaults (CAN-SPAM). Invalidated by
   * the platform router when a footer-affecting setting changes.
   */
  footerDefaultsCache?: FooterDefaultsCachePort | null;
  /**
   * Read-through cache in front of `repos.platformSettings`.
   *
   * Direct `repos.platformSettings.upsert(...)` writes invalidate themselves —
   * they go through the cached instance. `updatePlatformSetting` does NOT: it
   * writes via `repos.tx(...)`, and transaction-scoped repos are built fresh
   * from the tx client, so the cached wrapper never sees the write. The
   * platform router invalidates explicitly for that path.
   */
  platformSettingsCache?: { invalidate(): void } | null;
  /**
   * In-process result cache for the anonymous home-page discovery reads
   * (`events.countryEvents`, `search.featuredEvents`). Routers hand it to the
   * use case ONLY for anonymous requests (`isAnonymousRequest`), so nothing
   * resolved for a signed-in caller is ever stored or served from it. Absent →
   * every read goes to the database, as before.
   */
  publicDiscoveryCache?: ReadThroughCachePort | null;
  /**
   * Shared "public read models changed" counter behind `publicDiscoveryCache`
   * and the platform-settings snapshot. Bumped after every mutation by a
   * resolved actor (`bumpPublicReadsAfterActorMutation`, chained in
   * `init.ts`); search index writes bump it separately (adapters). Absent →
   * caches fall back to their TTL.
   */
  publicReadGeneration?: CacheGenerationPort | null;
  /** Base URL for the web app. Required alongside mailer for email links. */
  publicAppUrl?: string | null;
  /**
   * The file storage's public base URL (S3_PUBLIC_BASE_URL), for use cases
   * that recognise this deployment's own uploaded page images by URL before
   * queueing them for deletion (`resolveCommunityHandover`'s Clear). Null /
   * absent = no URL counts as an owned upload, so nothing is queued.
   */
  storagePublicBaseUrl?: string | null;
  /**
   * Self-hosted tileserver base URL (e.g. https://tiles.example.com) for
   * static venue-map images in transactional emails. The purchased-ticket
   * path reads `env.TILESERVER_URL` directly in the Stripe webhook; the
   * comp-ticket (volunteer reward) path renders through the tRPC ctx, so it
   * needs the URL here to reach map parity — absent it, comp emails ship
   * without the venue map.
   */
  tileServerUrl?: string | null;
  /** HMAC secret for generating/verifying announcement unsubscribe tokens. */
  unsubscribeSecret?: string | null;
  /**
   * HMAC key for open-call status-link tokens (HKDF of UNSUBSCRIBE_SECRET,
   * core `lib/security/open-call-status-token-key.ts`). Submit
   * derives the token from the new submission id with it, and the notifiers
   * re-derive a guest's link at send time. Null → submit answers
   * NOT_CONFIGURED and guest emails fail (reported).
   */
  openCallStatusTokenSecret?: string | null;
  /**
   * Physical mailing address for CAN-SPAM footer in announcement emails.
   * E.g. "123 Main St, Anytown, ST 12345"
   */
  senderPhysicalAddress?: string | null;
  /** Optional Cloudflare Turnstile adapter for bot protection on public endpoints. */
  turnstile?: TurnstilePort | null;
  /** Optional Ziptax adapter for US sales tax rate lookups by postal code. */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * lat/lng → IANA timezone resolver (venue-hierarchy FR-004), used by
   * places.upsertPlace to derive `Place.timezone` from the address. A local
   * pure-JS adapter (no network); optional only for older composition
   * roots/tests — the API root always wires it.
   */
  timezoneLookup?: TimezoneLookupPort | null;
  /**
   * Optional provider-agnostic music-stats adapter for public artist enrichment
   * (EPK). Spotify is the one wired today; `null` when
   * `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` are not configured.
   */
  musicStats?: MusicStatsPort | null;
  /** Optional routing adapter for A→B travel time/distance (Valhalla). */
  routing?: RoutingPort | null;
  /** Optional wallet pass adapter for generating Apple/Google Wallet passes. */
  walletPass?: WalletPassPort | null;
  /**
   * Volunteer scan token signer/verifier. Optional: when absent, the
   * volunteer mint/resolve procedures fail with `not_implemented` so we
   * don't accidentally serve unverifiable tokens in dev environments.
   */
  volunteerScanToken?: VolunteerScanTokenPort | null;
  /** Override TTL for short volunteer scan tokens (hours). Defaults to 24h. */
  volunteerScanTokenShortTtlHours?: number | null;
  /** Public iOS / TestFlight URL surfaced in scanner onboarding emails. */
  scannerAppIosUrl?: string | null;
  /** Public Android / Play Store / internal-track URL for scanner onboarding emails. */
  scannerAppAndroidUrl?: string | null;
  /** Internal URL of the jobs Fastify service (e.g. http://localhost:3002). */
  jobsServiceUrl?: string | null;
  /** When true, settlements are scheduled for immediate payout (dev/test only). */
  devInstantPayouts?: boolean;
  /**
   * Optional alerting hook fired when settlement creation fails for a fully
   * credit-covered checkout. That path has no Stripe webhook DLQ /
   * 200-with-retry backstop, so a dropped settlement would otherwise be
   * invisible to operators. Composed at the API app layer to mirror the
   * webhook finalize path's `onSettlementFailure` (Discord alert + Sentry,
   * keyed on `orderId`, pointing at the `settlements.createFromOrder` mutation).
   */
  onSettlementFailure?:
    | ((ctx: { orderId: string; error: string }) => void)
    | null;
  /** Feature gate: allow event creation. Defaults to true when omitted. */
  enableCreateEvents?: boolean;
  /** Feature gate: allow ticket purchasing / checkout. Defaults to true when omitted. */
  enableBuyTickets?: boolean;
  /** Feature gate: maintenance mode. Defaults to false when omitted. */
  enableMaintenanceMode?: boolean;
  /** Feature gate: admin web unified-scan resolver UI. Defaults to false when omitted. */
  enableUnifiedScanResolver?: boolean;
  /** Feature gate: event-builder waiver section + checkout waiver gate. Defaults to false when omitted. */
  enableWaivers?: boolean;
  /** Feature gate: unlock the freeform entity-page block editor. Defaults to false when omitted. */
  enableEntityPageEditor?: boolean;
  /** Feature gate: surface the audiences + announcements messaging CRM. Defaults to false when omitted. */
  enableBroadcasts?: boolean;
  /** Feature gate: surface the ticket-resale admin surfaces. Defaults to false when omitted. */
  enableResale?: boolean;
  /** Feature gate: surface PUBLIC human entity-page profiles. Defaults to false when omitted. */
  enableHumanProfilesPublic?: boolean;
  /** Feature gate: surface the event waitlist ("notify me") surfaces. Defaults to false when omitted. */
  enableWaitlists?: boolean;
  /**
   * Capability, not a gate: true iff the API holds SNS credentials and so can
   * send a text message (`apps/api/src/lib/sms-capability.ts`). Derived from
   * env at startup, never a platform setting. Defaults to false when omitted.
   */
  smsConfigured?: boolean;
  /** Optional Discord alerter for operational notifications (new users, reviews, etc.). */
  discordAlert?:
    | ((opts: {
        title: string;
        colour?: "info" | "warning" | "error";
        fields?: { name: string; value: string; inline?: boolean }[];
        description?: string;
      }) => Promise<void>)
    | null;
  /**
   * Optional best-effort support notifier. Fired on a new support thread and on
   * an AWAITING_HUMAN escalation. Composed at the API layer from the existing
   * Discord webhook sender (DISCORD_SUPPORT_WEBHOOK). Always fail-safe — a
   * delivery failure never propagates into the support send/status path.
   */
  notifySupport?: NotifySupportFn | null;
  /**
   * Per-human support rate-limit tiers (Redis fixed-window). Optional — when
   * omitted the support router falls back to its built-in defaults. Threaded
   * from env at the API layer so the limits are tunable without a deploy.
   * The send path runs two independent windows (burst + sustained); the staff
   * reply path runs a single generous backstop.
   */
  supportRateLimits?: {
    sendBurstMax: number;
    sendBurstWindowS: number;
    sendSustainedMax: number;
    sendSustainedWindowS: number;
    replyMax: number;
    replyWindowS: number;
  } | null;
  /** Optional webhook DLQ for viewing/replaying failed Stripe webhook events. */
  webhookDlq?: {
    list(
      limit?: number,
    ): Promise<
      Array<{
        stripeEventId: string;
        eventType: string;
        payload: string;
        error: string;
        receivedAt: string;
      }>
    >;
    get(stripeEventId: string): Promise<{
      stripeEventId: string;
      eventType: string;
      payload: string;
      error: string;
      receivedAt: string;
    } | null>;
    remove(stripeEventId: string): Promise<void>;
    count(): Promise<number>;
  } | null;
  /**
   * Re-drives a DLQ'd Stripe event through the real webhook dispatch.
   *
   * Assigned by the fastify webhook plugin onto this shared deps object (which
   * `createContextFactory` spreads per request), so the transport layer gets a
   * replay path without depending on fastify. Absent in environments that don't
   * mount the webhook route — `platform.replayWebhookDlqItem` 404s then rather
   * than pretending the replay happened.
   */
  replayStripeEvent?: (
    rawPayload: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Shared secret for verifying web-issued event unlock cookies. */
  eventUnlockSecret?: string | null;
  /**
   * Gated-event invite link token key, ALREADY DERIVED by the composition
   * root (`deriveInviteTokenSecret` in core `lib/security/invite-token.ts`,
   * HKDF of BETTER_AUTH_SECRET). Never the root secret itself. Null → the
   * invite procedures fail NOT_CONFIGURED.
   */
  inviteTokenSecret?: string | null;
  /**
   * "Stop invites from this organiser" token key, ALREADY DERIVED by the
   * composition root (`deriveInviteOptOutSecret` in core
   * `lib/security/invite-optout-token.ts`, HKDF of BETTER_AUTH_SECRET under
   * its own label). Null → invite sends and the opt-out procedures fail
   * NOT_CONFIGURED (no invite email goes out without a working opt-out).
   */
  inviteOptOutSecret?: string | null;
  /**
   * Root secret delegate invitation links are signed with (a purpose-bound
   * key is derived from it in core — `lib/delegate-invite-token.ts`). Null →
   * `delegates.createInvite` / `acceptInvite` fail NOT_CONFIGURED.
   */
  delegateInviteSecret?: string | null;
  /**
   * Root secret the ban-that-sticks hashes are keyed from (a purpose-bound
   * key is derived in core — `lib/security/network-identity.ts`). Null → a
   * ban still applies but records no banned-identity rows (reported).
   */
  identityHashSecret?: string | null;
  /**
   * Shared secret the web app signs forwarded visitor IPs with
   * (`x-th-client-ip*` headers — protocol in `client-ip.ts`). The API reuses
   * ORIGIN_SHARED_SECRET; a purpose-bound key is derived from it, so the raw
   * secret is never the MAC key. Null/blank → forwards are ignored and
   * `ctx.clientIp` resolves from the proxy headers as before.
   */
  clientIpForwardSecret?: string | null;
  /**
   * Rollout mode for the whole-API `global:<actor>` rate-limit bucket — see
   * {@link GlobalRateLimitMode}. Wired from `TRPC_GLOBAL_RATE_LIMIT_MODE` at
   * the API root; absent means `"shadow"`. Exists because the bucket's size
   * is a code-derived estimate, not measured traffic: `shadow` lets it be
   * watched in prod before it can 429 anyone, `off` is the kill switch.
   */
  globalRateLimitMode?: GlobalRateLimitMode;
  /**
   * Whether the API is running in a production (non-development) environment,
   * derived at the app layer from `NODE_ENV`. Use cases that must fail-closed
   * in prod but stay ergonomic locally (e.g. CAN-SPAM opt-out enforcement in
   * announcement dispatch) read this rather than reaching for `process.env`.
   * Defaults to treating an unset value as non-production.
   */
  isProduction?: boolean;
};

export type CreateContextInput = {
  req: {
    auth?: RequestAuth | null;
    headers?: HeadersLike | null;
    id?: unknown;
    raw?: { socket?: RequestSocketLike | null } | null;
    socket?: RequestSocketLike | null;
  };
};

export type Ctx = TrpcDeps & {
  auth: RequestAuth | null;
  authToken: string | null;
  apiKey: string | null;
  actorHumanId: string | null;
  /**
   * The API key's scope, set by the key gate (`key-scope/gate.ts`) when the
   * request carries a key; null for a session or anonymous request. Step-5
   * procedures read `keyScope.keyId` for `actingApiKeyId` (NFR-001).
   */
  keyScope: ApiKeyScope | null;
  /**
   * Set ONLY on `apiKeys.renewSelf` (its `selfRenewal` tag): the calling key
   * and its holder. The one place a PLATFORM_WIDE key's holder id reaches a
   * procedure (FR-007, FR-009). Read it through `requireKeySelfRenewal`.
   */
  keySelfRenewal: { keyId: string; holderHumanId: string } | null;
  viewerLocation: ViewerLocation | null;
  /**
   * Resolved client IP for anti-abuse controls: a verified signed forward from
   * the web app first, then forwarding headers (`cf-connecting-ip` → … →
   * `x-forwarded-for`), server-observed socket last. See
   * {@link extractClientIp}. Feeds rate-limit keys, Turnstile `remoteip` and
   * audit/forensics fields ONLY, so it can change a rate-limit outcome (a
   * per-visitor 429) but never response content. The web's de-identified SSR
   * client forwards it on that basis.
   */
  clientIp: string | null;
  /**
   * Where {@link Ctx.clientIp} came from — see {@link ClientIpSource}.
   * Optional so hand-built test contexts need not set it; absent is treated
   * like `"edge"` (no special-casing anywhere).
   */
  clientIpSource?: ClientIpSource;
  /** Truncated user-agent string (max 1024 chars). */
  userAgent: string | null;
  /** Raw Cookie header, used only by procedures that verify signed cookies. */
  cookieHeader: string | null;
};

export const createContextFactory =
  (deps: TrpcDeps) =>
  async ({ req }: CreateContextInput): Promise<Ctx> => {
    const headers = req?.headers ?? null;
    const auth = req?.auth ?? null;
    const apiKey =
      extractApiKey(headers) ?? normalizeString((auth as any)?.apiKey);
    const requestIdFromReq =
      typeof req?.id === "string"
        ? normalizeString(req.id)
        : typeof req?.id === "number"
          ? normalizeString(String(req.id))
          : null;
    const correlationId = extractCorrelationId(headers);
    const requestId =
      correlationId ?? extractRequestId(headers) ?? requestIdFromReq;
    const headerToken = extractBearerToken(headers);
    const sessionTokens = [
      normalizeString(auth?.token),
      normalizeString((auth as any)?.sessionToken),
    ];
    const authToken =
      [headerToken, ...sessionTokens].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.length > 0,
      ) ?? null;

    const resolvedIp = extractClientIp(
      req,
      deps.clientIpForwardSecret,
      nowSecondsFrom(deps.clock),
    );
    if (resolvedIp.rejected) {
      reportRejectedForward(
        deps,
        resolvedIp.rejected,
        resolvedIp.source === "direct" ? "direct" : "edge",
      );
    }

    const baseLogger = deps.logger;
    const requestLoggerBindings: Record<string, unknown> = {};
    if (correlationId) {
      requestLoggerBindings.correlationId = correlationId;
    } else if (requestId) {
      requestLoggerBindings.requestId = requestId;
    }
    const sessionId = normalizeString(auth?.sessionId);
    if (sessionId) requestLoggerBindings.sessionId = sessionId;
    if (apiKey) requestLoggerBindings.usesApiKey = true;

    const requestLogger = Object.keys(requestLoggerBindings).length
      ? baseLogger.child(requestLoggerBindings)
      : baseLogger;

    return {
      ...deps,
      logger: requestLogger,
      auth,
      authToken,
      apiKey,
      actorHumanId: null,
      keyScope: null,
      keySelfRenewal: null,
      viewerLocation: extractViewerLocation(headers),
      clientIp: resolvedIp.clientIp,
      clientIpSource: resolvedIp.source,
      userAgent: extractUserAgent(headers),
      cookieHeader: extractCookieHeader(headers),
    };
  };
