import { TRPCError } from "@trpc/server";
import { actorFromApiKeyGate } from "./key-scope/actor";
import type { AuthNPortError } from "@th/ports/authn";
import type { HumanRole } from "@th/ports/authz";
import type { RateLimitEntry, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import { fail } from "@th/errors";
import { describeError } from "@th/core/lib/io";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import { rateLimitIpBucket } from "@th/core/lib/security/rate-limit-ip-bucket";
import { t } from "./trpc";
import { INVALID_ATTEMPTS_RATE_LIMITED } from "./rate-limit-markers";
import type { Ctx } from "./context";
import { normalizeString, toTrpcError } from "./utils";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const isAuthNError = (err: unknown): err is AuthNPortError =>
  typeof err === "object" && err !== null && "code" in err;

const unauthorized = (cause?: unknown) =>
  new TRPCError({ code: "UNAUTHORIZED", message: "unauthorized", cause });

const getAuthToken = (ctx: Ctx): string | null =>
  [
    ctx.authToken,
    normalizeString(ctx.auth?.token),
    normalizeString((ctx.auth as any)?.sessionToken),
  ].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  ) ?? null;

const withActor = (ctx: Ctx, actorHumanId: string | null): Ctx => ({
  ...ctx,
  actorHumanId,
  logger: actorHumanId ? ctx.logger.child({ actorHumanId }) : ctx.logger,
});

/**
 * Resolve the acting human for this request.
 *
 * Suspended/banned humans are refused INSIDE the AuthN port, not here: both
 * `ensureAuthedHumanFromApiKey` and `ensureAuthedHuman` read `Human.status`
 * in the same statement that resolves the humanId and throw an `unauthorized`
 * AuthN error for anything not ACTIVE. That error already maps to
 * UNAUTHORIZED in `requireAuth` and to anonymous in `optionalAuth`, so the
 * guard needs no second per-request query. The same read also refuses a
 * JWT whose `sid` session no longer exists.
 */
const resolveActorHumanId = async (ctx: Ctx): Promise<string | null> => {
  if (ctx.actorHumanId) return ctx.actorHumanId;

  if (ctx.apiKey) {
    // The API-key gate (key-scope/gate.ts), chained before auth in init.ts,
    // already resolved the key and set the actor: the holder, or null for a
    // PLATFORM_WIDE key (FR-007). Never resolved twice (NFR-003).
    return actorFromApiKeyGate(ctx);
  }

  const token = getAuthToken(ctx);
  if (!token) return null;

  const { providerUserId, sessionId } = await ctx.authn.getProviderUserId({
    token,
  });
  const normalizedProviderUserId = normalizeString(providerUserId);
  if (!normalizedProviderUserId) return null;

  const requestUserId = normalizeString(ctx.auth?.userId);
  if (requestUserId && requestUserId !== normalizedProviderUserId) {
    return null;
  }

  const { humanId } = await ctx.authn.ensureAuthedHuman({
    providerUserId: normalizedProviderUserId,
    token,
    // Binds the JWT to its Better Auth session: the adapter refuses it once
    // that session is gone (see `ensureAuthedHumanInputSchema.sessionId`).
    ...(sessionId ? { sessionId } : {}),
  });
  return humanId;
};

export const publicOnly = t.middleware(({ ctx, next }) => next({ ctx }));

export const optionalAuth = t.middleware(async ({ ctx, next }) => {
  try {
    const actorHumanId = await resolveActorHumanId(ctx);
    return next({ ctx: withActor(ctx, actorHumanId) });
  } catch (err) {
    if (isAuthNError(err)) {
      return next({ ctx: withActor(ctx, null) });
    }
    throw err;
  }
});

export const requireAuth = t.middleware(async ({ ctx, next }) => {
  try {
    const actorHumanId = await resolveActorHumanId(ctx);
    if (!actorHumanId) throw unauthorized();
    return next({ ctx: withActor(ctx, actorHumanId) });
  } catch (err) {
    if (isAuthNError(err)) {
      throw unauthorized(err);
    }
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

export type RateLimitOpts<TInput = unknown> = {
  /**
   * Build a unique key for this rate-limit window. Receives the resolved
   * context (with `actorHumanId`) and the parsed procedure input.
   *
   * @example
   * ```ts
   * key: (ctx, input) => `announce:send:${input.orgId}:${input.audienceType}`
   * ```
   */
  key: (ctx: Ctx, input: TInput) => string;

  /**
   * Maximum number of requests allowed within the window. May be a plain
   * number or a function resolved from the request context (e.g. when the
   * limit is configurable via env-threaded `TrpcDeps`).
   * @default 10
   */
  maxRequests?: number | ((ctx: Ctx) => number);

  /**
   * Window length in seconds. The counter resets after this period. May be a
   * plain number or a function resolved from the request context.
   * @default 60
   */
  windowSeconds?: number | ((ctx: Ctx) => number);

  /**
   * Human-readable description of the action for the error message.
   * @example "sending announcements to this audience"
   */
  message?: string;
};

/**
 * Every distinct `ctx.reportError` (in practice a single `Sentry.captureException`
 * reference wired once in `dep.ts` for the lifetime of the process — see
 * `TrpcDeps.reportError`) gets its own throttled wrapper, memoized here so the
 * throttle window survives across requests instead of resetting on every call
 * (this function runs per-request, so a fresh `createThrottledReporter(...)`
 * on every invocation would never actually throttle anything). Keyed by
 * identity rather than a module-level singleton so tests that wire a fresh
 * `reportError` mock per case get independent, non-leaking throttle state.
 */
const rateLimitThrottledReporters = new WeakMap<ReporterPort, ReporterPort>();

/** A sustained rate-limit-backend outage should still surface periodic
 * breadcrumbs in Sentry rather than either spamming one event per request or
 * going silent after the first (see the Jun 2026 4-day silent search outage
 * this convention exists to prevent). */
const RATE_LIMIT_REPORT_THROTTLE_MS = 15 * 60 * 1000;

function getThrottledRateLimitReporter(
  reportError: ReporterPort | null | undefined,
): ReporterPort | undefined {
  if (!reportError) return undefined;
  let throttled = rateLimitThrottledReporters.get(reportError);
  if (!throttled) {
    throttled = createThrottledReporter(
      reportError,
      RATE_LIMIT_REPORT_THROTTLE_MS,
    );
    rateLimitThrottledReporters.set(reportError, throttled);
  }
  return throttled;
}

/**
 * Best-effort wrapper around `ctx.rateLimit.consume`. Rate limiting here is
 * defense-in-depth, not a hard gate on legitimate traffic — a Redis blip or
 * outage must never be able to take down (or even meaningfully slow down)
 * otherwise-valid requests just because a counter couldn't be incremented.
 *
 * On failure, logs the error and treats the request as allowed (fail open).
 * Used by `rateLimit(...)` (per-router custom limits); `defaultRateLimit` (the
 * floor) uses the many-key form below. Both go through
 * `reportRateLimitFailOpen`, so the fail-open behavior — and the logging
 * shape — stays identical between them.
 */
export async function consumeRateLimitOrAllow(
  ctx: Ctx,
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    return await ctx.rateLimit.consume(key, maxRequests, windowSeconds);
  } catch (err) {
    reportRateLimitFailOpen(ctx, key, err);
    return {
      allowed: true,
      remaining: maxRequests,
      retryAfterSeconds: 0,
    };
  }
}

/**
 * Many-bucket form of {@link consumeRateLimitOrAllow}: one
 * `ctx.rateLimit.consumeMany` call (one Redis round trip), same fail-open
 * behaviour. On failure EVERY entry is allowed, and the log line and report
 * carry the FIRST entry's key, so callers put their primary bucket first
 * (`defaultRateLimit` puts the per-procedure key there, keeping the shape
 * operators already search for).
 */
async function consumeManyRateLimitOrAllow(
  ctx: Ctx,
  entries: ReadonlyArray<RateLimitEntry>,
): Promise<RateLimitResult[]> {
  try {
    const results: unknown = await ctx.rateLimit.consumeMany(entries);
    // A malformed answer (not an array, wrong length, an entry without a
    // boolean `allowed`) is a backend fault like any other: fail OPEN through
    // the same report, rather than letting the caller's `.filter` /
    // `.allowed` throw a TypeError outside this try and fail CLOSED as a 500.
    if (
      !Array.isArray(results) ||
      results.length !== entries.length ||
      !results.every(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          typeof (result as RateLimitResult).allowed === "boolean",
      )
    ) {
      throw new Error(
        `rate_limit_consume_many_bad_result: expected ${entries.length} results`,
      );
    }
    return results as RateLimitResult[];
  } catch (err) {
    reportRateLimitFailOpen(ctx, entries[0]?.key ?? "", err);
    return entries.map((entry) => ({
      allowed: true,
      remaining: entry.maxTokens,
      retryAfterSeconds: 0,
    }));
  }
}

/** Log + (throttled) report for a swallowed rate-limit-backend failure. */
function reportRateLimitFailOpen(ctx: Ctx, key: string, err: unknown): void {
  ctx.logger.error("rate_limit_consume_failed", {
    key,
    error: describeError(err),
  });
  try {
    getThrottledRateLimitReporter(ctx.reportError)?.(err, {
      tags: { area: "rate_limit_fail_open" },
      extra: { key, error: describeError(err) },
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never turn the
    // fail-open allow into a thrown error.
  }
}

/**
 * Creates a tRPC middleware that enforces a fixed-window rate limit backed
 * by the `RateLimitPort` (Redis counter).
 *
 * Must be chained **after** `requireAuth` so `ctx.actorHumanId` is available.
 *
 * If `key` reads `input`, the limiter MUST be chained **after** `.input()`:
 * in tRPC v11 a middleware sees `input: undefined` until the input-parser
 * middleware has run, so a limiter placed before `.input()` throws a
 * TypeError (a 500) on every call and lets malformed bodies past the 400.
 *
 * @example
 * ```ts
 * authedProcedure
 *   .input(schema)
 *   .use(rateLimit({
 *     key: (_ctx, input) => `announce:send:${input.orgId}`,
 *     maxRequests: 5,
 *     windowSeconds: 60,
 *     message: "sending announcements",
 *   }))
 *   .mutation(...)
 * ```
 */
export function rateLimit<TInput = unknown>(opts: RateLimitOpts<TInput>) {
  return t.middleware(async ({ ctx, input, next }) => {
    // Resolve limits inside the middleware so the function form can read ctx
    // (e.g. env-configured tiers threaded via TrpcDeps).
    const maxRequests =
      typeof opts.maxRequests === "function"
        ? opts.maxRequests(ctx)
        : (opts.maxRequests ?? 10);
    const windowSeconds =
      typeof opts.windowSeconds === "function"
        ? opts.windowSeconds(ctx)
        : (opts.windowSeconds ?? 60);

    const key = opts.key(ctx, input as TInput);
    const result = await consumeRateLimitOrAllow(
      ctx,
      key,
      maxRequests,
      windowSeconds,
    );

    if (!result.allowed) {
      const action = opts.message ?? "performing this action";
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded for ${action}. Try again in ${result.retryAfterSeconds}s.`,
      });
    }

    return next({ ctx });
  });
}

/**
 * Charge one FAILED attempt to `key` and throw TOO_MANY_REQUESTS once the
 * bucket is spent. For procedures that must never throttle a good request
 * (a valid signed token: the one-click opt-out, where a mail provider's
 * shared IP carries many recipients) but should still slow down guessing:
 * call it only on the failure outcome, after the cheap check ran. Same
 * fail-open posture as `rateLimit(...)`. The default floor still applies to
 * every call. The message starts with `INVALID_ATTEMPTS_RATE_LIMITED:`
 * (rate-limit-markers.ts) so a caller can tell this refusal, which can
 * never drop a good request, from the floor's.
 */
export async function chargeFailedAttempt(
  ctx: Ctx,
  opts: {
    key: string;
    maxRequests: number;
    windowSeconds: number;
    message: string;
  },
): Promise<void> {
  const result = await consumeRateLimitOrAllow(
    ctx,
    opts.key,
    opts.maxRequests,
    opts.windowSeconds,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `${INVALID_ATTEMPTS_RATE_LIMITED}: Rate limit exceeded for ${opts.message}. Try again in ${result.retryAfterSeconds}s.`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default (floor) rate limit — defense in depth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conservative floor applied to every procedure that goes through
 * `publicProcedure` / `optionalProcedure` / `authedProcedure`, regardless of
 * whether that procedure also declares its own tighter `rateLimit(...)`
 * (2026-07-05 security-audit follow-up: throttling was opt-in per endpoint,
 * so most of the API had zero rate limiting).
 *
 * Deliberately generous — this must never trip on normal UI usage
 * (pagination, search-as-you-type, polling, batched tRPC calls all hit many
 * procedures rapidly). It exists purely to cap the blast radius of a runaway
 * or scripted client hammering a single procedure that nobody has gotten
 * around to rate-limiting explicitly yet. The ~11 existing per-router custom
 * `rateLimit(...)` calls are intentionally stricter than this floor and stack
 * fine on top of it (distinct Redis buckets).
 */
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 240;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Whole-API cap per actor, across EVERY procedure (key `global:<actor>`).
 *
 * The per-procedure floor above never sums across paths, so a client spreading
 * calls over many procedures could make 240 x (number of procedures) calls a
 * minute. This caps the total.
 *
 * Sized against call counts estimated from the code (2026-09-30), not
 * measured traffic: a cold event page is ~20-25 procedure calls (SSR + client;
 * SSR calls now count against the visitor's own IP), an admin event-builder
 * load ~30, and the busiest poll (POS card-wait) is 40/min. 600/min is ~20
 * cold heavy page loads a minute, sustained, per actor. A door scanner makes
 * ~2 calls per scan, so its per-procedure buckets (240) trip before this one
 * does; no procedure is exempt.
 */
export const GLOBAL_RATE_LIMIT_MAX_REQUESTS = 600;
export const GLOBAL_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Middleware form of the default floor above. Must run after auth resolution
 * (`optionalAuth` / `requireAuth`) so `ctx.actorHumanId` is available.
 *
 * Charges TWO buckets in one `consumeMany` call: one Redis `EVAL`, the same
 * command count as the single-bucket version this replaced (the script does
 * roughly twice the work inside that one command):
 *
 * - `default:<path>:<actor>` at 240/60s, keyed per-(procedure path, actor) so
 *   one hot procedure can't exhaust the budget for unrelated ones;
 * - `global:<actor>` at 600/60s, summed across every procedure, so one actor
 *   can't get 240/min out of each of hundreds of procedures.
 *
 * The request is denied if EITHER bucket is over; Retry-After is the longest
 * wait among the denied buckets. Both buckets are charged either way (no
 * short-circuit), matching two separate `consume` calls.
 *
 * `actor` is `ctx.actorHumanId` when the procedure RESOLVED one, else
 * `clientIp` (for web SSR, the visitor IP the web signs into
 * `x-th-client-ip`), then `"unknown"` as a last resort (should not occur in
 * practice — `clientIp` resolution always returns something for real
 * requests). Only `optionalProcedure` / `authedProcedure` resolve an actor:
 * `publicProcedure` chains `publicOnly`, which never looks at the session,
 * and `createContext` starts every request at `actorHumanId: null`. So a
 * SIGNED-IN caller of a public procedure — and every call through the web's
 * de-identified `getPublicTrpcClient` — is keyed on its IP, not on the human,
 * and shares that IP's buckets with everyone behind it.
 *
 * The GLOBAL key's IP is `rateLimitIpBucket(clientIp)`: IPv4 unchanged, IPv6
 * collapsed to its /64 (one customer allocation), so rotating addresses
 * inside a /64 cannot mint fresh global budgets. The per-procedure key keeps
 * the raw `clientIp`, byte-identical to before, so existing live buckets and
 * their behaviour do not move.
 *
 * Global-bucket exceptions (see the comments in the body):
 * - `ctx.globalRateLimitMode` (absent → `shadow`, see the body): `off` drops
 *   the entry, `shadow` charges it but only reports a would-deny, `enforce`
 *   429s;
 * - anonymous callers whose request did not transit Cloudflare and carried no
 *   valid visitor forward (`clientIpSource === "direct"`) skip it.
 *
 * A batched HTTP request (`?batch=1`) runs this middleware once PER CALL in the
 * batch, so a batch of N calls spends N tokens from each bucket it touches.
 *
 * Fails open on a rate-limit-backend error, like `rateLimit(...)`.
 */
export const defaultRateLimit = t.middleware(async ({ ctx, path, next }) => {
  const actor = ctx.actorHumanId ?? ctx.clientIp ?? "unknown";
  const globalActor =
    ctx.actorHumanId ?? rateLimitIpBucket(ctx.clientIp) ?? "unknown";
  // Absent → SHADOW, not enforce. 600/min per anonymous IP is estimated from
  // the code, not measured, and SSR is now charged to the visitor's own IP: a
  // venue crowd behind one IPv4 (or one IPv6 /64) at the door could trip it,
  // and SSR turns those 429s into 500s. Shadow charges the SAME key in the
  // SAME single EVAL and only reports would-denies, so moving to `enforce`
  // is one env var (TRPC_GLOBAL_RATE_LIMIT_MODE) once that data looks sane.
  const mode = ctx.globalRateLimitMode ?? "shadow";
  // FAIL-SAFE for anonymous callers that did NOT transit Cloudflare and carry
  // no valid visitor forward (`clientIpSource === "direct"`): skip the GLOBAL
  // bucket, pay only the per-procedure one. Signed-in actors are keyed on
  // their human id, so they keep the global bucket regardless.
  //
  // Why: our web server's internal SSR calls reach the API this way. When
  // their forward is missing or broken — the likeliest case being an
  // ORIGIN_SHARED_SECRET rotation where one service rolls out before the
  // other, so every forward fails `bad_sig` — `clientIp` becomes the web's
  // egress address (leftmost x-forwarded-for) for EVERY visitor. Charging
  // that to `global:<web egress>` would 429 all anonymous SSR at once, and
  // SSR turns those into 500s. The check deliberately does NOT depend on the
  // origin secret, because a secret mismatch is exactly the failure it must
  // survive.
  //
  // Why this grants no outside caller anything new:
  // - Log-only origin guard (ENFORCE_ORIGIN_SECRET off): a direct-to-origin
  //   caller can already dodge EVERY per-IP bucket, global included, by
  //   writing a fresh `cf-connecting-ip` per request. Omitting it instead
  //   buys them less, not more.
  // - Enforce mode: apps/api/src/plugins/origin-guard.ts 403s any request
  //   without the origin secret before tRPC runs, so only secret holders
  //   (Cloudflare, which always sets `cf-connecting-ip`, and our web server)
  //   can arrive without that header.
  // - Browser traffic through Cloudflare always carries `cf-connecting-ip`,
  //   so it never skips.
  // Local dev and e2e (loopback, no Cloudflare) also skip the global bucket.
  const skipGlobalForDirect =
    !ctx.actorHumanId && ctx.clientIpSource === "direct";
  const chargeGlobal = mode !== "off" && !skipGlobalForDirect;
  const globalKey = `global:${globalActor}`;
  // Per-procedure key FIRST: the fail-open log/report carries entries[0].key.
  const results = await consumeManyRateLimitOrAllow(ctx, [
    {
      key: `default:${path}:${actor}`,
      maxTokens: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    },
    ...(chargeGlobal
      ? [
          {
            key: globalKey,
            maxTokens: GLOBAL_RATE_LIMIT_MAX_REQUESTS,
            windowSeconds: GLOBAL_RATE_LIMIT_WINDOW_SECONDS,
          },
        ]
      : []),
  ]);

  const [procedureResult, globalResult] = results;
  const denied: RateLimitResult[] = [];
  if (procedureResult && !procedureResult.allowed) denied.push(procedureResult);
  if (globalResult && !globalResult.allowed) {
    if (mode === "shadow") {
      reportGlobalBucketEvent(ctx, "would_deny", globalKey, globalResult);
    } else {
      reportGlobalBucketEvent(ctx, "denied", globalKey, globalResult);
      denied.push(globalResult);
    }
  }
  if (denied.length > 0) {
    const retryAfterSeconds = Math.max(
      ...denied.map((result) => result.retryAfterSeconds),
    );
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit exceeded. Try again in ${retryAfterSeconds}s.`,
    });
  }

  return next({ ctx });
});

/**
 * Signal for the global bucket going over, in either mode:
 * - `would_deny` (shadow): the data that decides whether `enforce` is safe;
 * - `denied` (enforce): without this the only trace of a global 429 is the
 *   warn-level `trpc.client_error` line, which Sentry does not capture.
 *
 * Each event increments `trpc.global_rate_limit.<event>` on EVERY occurrence
 * (tags: `source` = clientIpSource, `actor` = human | ip), so the rate is
 * exact. It also emits a `logger.error("global_rate_limit_<event>")` (warn
 * is not captured by Sentry), throttled to one line per minute per event per
 * rate-limit backend and carrying `suppressedSinceLastLog`, so a burst never
 * becomes a Sentry event per request. Throttle state is memoized on the
 * `ctx.rateLimit` object (one per process in production, fresh per test) for
 * the same reason `getThrottledRateLimitReporter` memoizes by reference: this
 * runs per request. Never throws.
 */
const GLOBAL_BUCKET_LOG_THROTTLE_MS = 60 * 1000;
const MAX_LOGGED_ACTOR_LENGTH = 64;
const globalBucketLogState = new WeakMap<
  object,
  Map<string, { lastLoggedAt: number; suppressed: number }>
>();

function reportGlobalBucketEvent(
  ctx: Ctx,
  event: "would_deny" | "denied",
  key: string,
  result: RateLimitResult,
): void {
  const source = ctx.clientIpSource ?? "edge";
  try {
    ctx.metrics?.increment(`trpc.global_rate_limit.${event}`, {
      source,
      actor: ctx.actorHumanId ? "human" : "ip",
    });
  } catch {
    // Metrics are best-effort — never let them affect the request.
  }
  try {
    const anchor = ctx.rateLimit as unknown as object;
    let byEvent = globalBucketLogState.get(anchor);
    if (!byEvent) {
      byEvent = new Map();
      globalBucketLogState.set(anchor, byEvent);
    }
    let state = byEvent.get(event);
    if (!state) {
      state = { lastLoggedAt: Number.NEGATIVE_INFINITY, suppressed: 0 };
      byEvent.set(event, state);
    }
    const now = Date.now();
    if (now - state.lastLoggedAt < GLOBAL_BUCKET_LOG_THROTTLE_MS) {
      state.suppressed += 1;
      return;
    }
    const suppressedSinceLastLog = state.suppressed;
    state.lastLoggedAt = now;
    state.suppressed = 0;
    // The actor can be an unvalidated proxy-header value; cap what we log.
    const prefix = "global:";
    const actor = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    const loggedKey =
      actor.length > MAX_LOGGED_ACTOR_LENGTH
        ? `${prefix}${actor.slice(0, MAX_LOGGED_ACTOR_LENGTH)}…`
        : key;
    ctx.logger.error(`global_rate_limit_${event}`, {
      key: loggedKey,
      clientIpSource: source,
      retryAfterSeconds: result.retryAfterSeconds,
      suppressedSinceLastLog,
    });
  } catch {
    // Logging is best-effort — never let it affect the request.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform / moderation staff second-factor gate
// ─────────────────────────────────────────────────────────────────────────────
//
// WHERE THE RULE IS ENFORCED. A staff role counts only with a passkey or TOTP
// enrolled, and the authz port applies that: `AuthZPort.hasStaffRole` answers
// `{ allowed: false, secondFactorRequired: true }` for a role holder with
// neither. A staff-gated use case or router check that asks the port is
// covered without being listed anywhere, new ones included.
//
// WHAT THIS FILE ADDS. On the paths below the middleware raises
// `SECOND_FACTOR_REQUIRED` before the procedure runs. The web shells and the
// moderation toasts key on that code to send the holder to `/enroll-2fa`. A
// staff-gated path that is not listed is refused all the same: every staff
// gate asks the port, and none reads `Human.roles` itself. It answers with
// its own role error (`STAFF_ONLY`, `FORBIDDEN`), or with
// `SECOND_FACTOR_REQUIRED` when its use case goes through
// `requirePlatformStaff` / `requireScannerAccessOnOrg`, or raises that code
// itself (`scanner.getSessionContext`, `scanner.listAccessibleEvents`).

/**
 * Every `HumanRole` the second-factor rule covers. Used ONLY to decide
 * whether the early check below applies to the calling actor — this list does
 * NOT grant access. Each procedure (or the use case it calls) enforces the
 * SPECIFIC role(s) it requires.
 */
const SECOND_FACTOR_GATED_ROLES: HumanRole[] = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
  "COMMUNITY_MODERATOR",
];

/**
 * Read-only "am I allowed in" probes that MUST keep returning a normal
 * (non-throwing) response for a staff/moderator actor missing a second
 * factor, so the client shell / SSR layout can redirect to the friendly
 * enrollment prompt (`/enroll-2fa`) instead of a raw tRPC error surfacing as
 * a toast. Both pass `allowWithoutSecondFactor` on their own role probe (the
 * only transport callers that do) and return a separate
 * `secondFactorEnrolled` field for that purpose.
 */
const SECOND_FACTOR_PROBE_PATHS = new Set([
  "platform.checkStaffAccess",
  "community.checkModeratorAccess",
]);

/**
 * Exact tRPC procedure paths — OUTSIDE the `platform.*` / `platformJobs.*`
 * routers, which are matched wholesale below — where the middleware raises
 * `SECOND_FACTOR_REQUIRED` early: the rest of the `/moderate` surface, the
 * ADMIN money and DSAR reads, and the staff queues mounted at the root router.
 *
 * This list picks the ERROR CODE, not who gets in (see the section header).
 * List a path only when it is unconditionally staff-only. The middleware
 * runs for every holder of a gated role, so listing a procedure that owners
 * or org members also call would demand a second factor from a staff member
 * using their ordinary access. Those procedures have a conditional staff
 * branch instead, refused at the port: `unifiedSearch.autocompleteAdmin` and
 * the moderator view of `community.listEventDates` (both pass the port's
 * answer to `throwIfStaffSecondFactorRequired` to keep the friendly code),
 * `places.getVerificationDocumentUrl`, `support.setThreadStatus`,
 * `events.cancelEvent` / `completeEvent` / `archiveEvent`, and the
 * platform-ADMIN override across `scanner.*` and `pos.*`.
 */
const SECOND_FACTOR_GATED_MODERATION_PATHS = new Set([
  "community.createListing",
  // The ownerless place a listing can be held at, and its correction,
  // archive and restore: same COMMUNITY_MODERATOR / ADMIN gate inside each
  // use case, no owner/member branch.
  "community.createPlace",
  "community.updatePlace",
  "community.archivePlace",
  "community.restorePlace",
  // The read the place card asks before opening that edit dialog: a
  // /moderate read like `eventSuggestions.listForModeration`, so the same
  // early step-up as the writes it answers for.
  "community.getPlaceEditability",
  // The /platform/community-listings read: platform ADMIN only inside its
  // use case, no owner/member branch.
  "community.listListingsForPlatform",
  // The DRAFT-authoring pair that goes with `createListing`: the field-save
  // behind the EventBuilder, and the flip that takes the listing live. Same
  // COMMUNITY_MODERATOR / ADMIN gate inside their use cases, so the same
  // step-up. Publishing is the moment an ownerless listing becomes visible to
  // everyone — if `createListing` needs a second factor, so does this.
  "community.updateListing",
  "community.publishListing",
  "community.updateRecurrence",
  // `community.ts` — the per-date call-off pair (a moderator taking ONE night
  // of a recurring listing off, and putting it back). COMMUNITY_MODERATOR /
  // ADMIN-gated inside their use cases, unconditionally and with no
  // owner/member fallback branch, so a path-level gate is exact here.
  //
  // Every other entry is reached through `/moderate/**` or `/platform/**`,
  // where the web edge middleware redirects an un-enrolled holder first.
  // These two render inline on the PUBLIC event page, which has NO edge gate,
  // so the inline toast depends on the code raised here.
  "community.cancelEventDate",
  "community.restoreEventDate",
  "eventSuggestions.review",
  "eventSuggestions.listForModeration",
  // `entity-reports.ts` — the /platform/reports queue + RESOLVED/DISMISSED
  // verdict (entity-report-intake spec v1.1: platform-level T&S). Both
  // platform-staff-gated (ADMIN/SUPPORT/DEVELOPER via `requirePlatformStaff`)
  // inside their use cases; path-listed here (not role-derived) because the
  // namespace isn't under `platform.*`.
  "entityReports.listForModeration",
  "entityReports.review",
  "moderatorApplications.review",
  "moderatorApplications.list",
  // `moderation.ts` — the FLAGGED image review queue + APPROVE/REJECT
  // (image-moderation spec FR-007); both COMMUNITY_MODERATOR/ADMIN-gated,
  // same 2FA step-up as the rest of /moderate.
  "moderation.listFlaggedImages",
  "moderation.reviewImage",
  // `moderation.ts` — the /platform/image-moderation OPS surface: the five
  // queue-health counts and the drill-down into one of them. Different gate
  // from the two above (ADMIN/DEVELOPER, not COMMUNITY_MODERATION_ROLES) but
  // the same step-up requirement: both are unconditionally staff-only reads
  // with no owner/member fallback branch, and the drill-down exposes the
  // storage keys and failure text of un-reviewed held content. A new
  // `moderation.*` procedure gets the early code only once its string
  // appears here.
  "moderation.queueSnapshot",
  "moderation.queueSignal",
  // Same OPS surface, second wave. The four reads carry the same reasoning as
  // the two above; `lookupByKey` in particular resolves an arbitrary R2 key to
  // a moderation verdict, and `alertState` reports what the platform has and
  // has not paged about — both unconditionally staff-only, neither with an
  // owner/member fallback branch.
  "moderation.queueBreakdown",
  "moderation.severityHistogram",
  "moderation.alertState",
  "moderation.lookupByKey",
  // The two ops WRITES, gated ADMIN-only in the router (a narrower list than
  // the ADMIN/DEVELOPER reads). `resolveUnscannable` terminally resolves a
  // record to ORPHANED; `rescanImage` discards a machine verdict and re-queues
  // the object. Both write an audit row naming the actor, which is worth
  // exactly as much as the identity behind it — hence the step-up.
  "moderation.resolveUnscannable",
  "moderation.rescanImage",
  "settlements.createFromOrder",
  "settlements.get",
  // `splits.ts` — order-split inspection, ADMIN-only (revenue-split detail
  // by payee/amount for a given order; read-only but exposes financial
  // allocation data).
  "splits.listForOrder",
  // `consent.ts` — DSAR consent-record lookups, ADMIN-only (both keyed
  // variants: by human, by anonymous device id).
  "consent.listForHuman",
  "consent.listForAnonymous",
  // `credits.ts` — money-adjacent: issues platform-funded account credit
  // (ADMIN/SUPPORT/DEVELOPER via `requirePlatformStaff`, unconditional)
  // redeemable at checkout, same risk class as `settlements.createFromOrder`
  // above.
  "credits.grant",
  // `place-reviews.ts` — platform moderation of venue reviews + the venue
  // directory listing toggle (all `requirePlatformStaff`, unconditional).
  "placeReviews.hide",
  "placeReviews.unhide",
  "placeReviews.listPlatform",
  "placeReviews.reassignPlace",
  "placeReviews.toggleDirectoryListing",
  // ADMIN-gated in-transport (`hasStaffRole`); the cron path bypasses tRPC.
  "placeReviews.recalculateStats",
  // `places.ts` — the /platform/places VENUE VERIFICATION surface. These live
  // under `places.*` (not `platform.*`) for historical reasons, so the
  // wholesale prefix gate misses them even though every one is
  // UNCONDITIONALLY staff-only (`hasStaffRole(["ADMIN","REVIEWER"])` →
  // `STAFF_ONLY`, checked first, with no owner/org fallback branch) — the
  // same shape as `placeReviews.*` above, and therefore a safe path-level
  // gate. Verified staff-only by reading each use case, not by grepping the
  // router file. Note the middleware only ever applies to actors who already
  // hold a gated staff role, so listing `getPlatformVerificationQueue` does
  // NOT over-gate the org-side `/verify` page that also calls it (a non-staff
  // org admin passes through untouched and still gets `STAFF_ONLY`).
  //
  // Context: the org-side `places.updatePlaceVerificationStatus` procedure
  // was the write that made this gap acute — an ADMIN with no enrolled second
  // factor could verify any place through it while the identical
  // `platform.updatePlaceVerificationStatus` was gated. That procedure has
  // been DELETED outright (see the note at its old site in
  // `routers/places.ts`), so that specific bypass is closed by removal; these
  // entries close the rest of the same cluster.
  //
  // Deliberately NOT listed: `places.getVerificationDocumentUrl`. Its staff
  // check is a CONDITIONAL branch — the request's own submitter (an ordinary
  // org user) is authorized too — so path-level gating would over-gate, same
  // reasoning as `unifiedSearch.autocompleteAdmin` above. Its staff branch
  // is refused at the port.
  "places.acknowledgePlaceVerification",
  "places.releasePlaceVerification",
  "places.reviewPlaceVerification",
  "places.getPlatformVerificationQueue",
  "places.setPlaceDirectoryListing",
  // `quotas.ts` — platform admin/staff view + adjudicate org resource-quota
  // expansion requests, and manage the platform-wide default limits (all
  // `requirePlatformStaff`, unconditional).
  "quotas.listExpansionRequests",
  "quotas.reviewExpansionRequest",
  "quotas.listDefaultLimits",
  "quotas.updateDefaultLimit",
  // `support.ts` — the operator support inbox: list threads + post
  // HUMAN_AGENT replies (both `requirePlatformStaff`, unconditional).
  "support.listThreads",
  "support.replyToThread",
  // `categories.ts` — moderation queue for organiser-submitted category
  // requests, direct category creation + hard category deletion (all
  // `requirePlatformStaff`, unconditional).
  "categories.listRequests",
  "categories.reviewRequest",
  "categories.create",
  "categories.delete",
  // The rest of the category lifecycle on /platform/categories: SEO type,
  // rename, activate / deactivate, reorder (ADMIN / DEVELOPER) and the staff
  // list that includes inactive rows (ADMIN / REVIEWER / DEVELOPER). Each
  // calls `requirePlatformStaff` before any read, with no owner or member
  // branch. `categories.list` is the public one and is NOT listed.
  "categories.setSeoType",
  "categories.rename",
  "categories.setActive",
  "categories.reorder",
  "categories.listAll",
  // Translated names: set / clear (ADMIN / DEVELOPER) and the machine-translation
  // prefill (ADMIN / REVIEWER / DEVELOPER). Both call `requirePlatformStaff`
  // before anything else. `changeSlug` (ADMIN / DEVELOPER) changes a category's
  // URL slug in one language and calls `requirePlatformStaff` first too.
  "categories.setTranslations",
  "categories.changeSlug",
  "categories.suggestTranslations",
]);

function isSecondFactorGatedPath(path: string): boolean {
  if (SECOND_FACTOR_PROBE_PATHS.has(path)) return false;
  if (path.startsWith("platform.") || path.startsWith("platformJobs.")) {
    return true;
  }
  return SECOND_FACTOR_GATED_MODERATION_PATHS.has(path);
}

/**
 * Raises `SECOND_FACTOR_REQUIRED` on the gated paths for an actor who holds a
 * platform `HumanRole` (ADMIN/REVIEWER/DEVELOPER/SUPPORT) or
 * `COMMUNITY_MODERATOR` and has no second factor (passkey OR TOTP) enrolled.
 * The refusal itself is `hasStaffRole`'s, at the authz port; this middleware
 * makes it arrive first and under the code the `/platform` and `/moderate`
 * clients redirect to `/enroll-2fa` on.
 *
 * Chained into `authedProcedure` itself (see `init.ts`), so every procedure
 * under a gated path picks it up. No-ops (cheap path-string check) for the
 * overwhelming majority of authed procedures that aren't listed.
 *
 * It asks the port's default probe for ANY gated role and reads only
 * `secondFactorRequired`: the port sets it for a role holder with no second
 * factor. A non-staff actor (`allowed: false`, no flag) and an enrolled
 * holder both pass through; the procedure's own (specific) role check
 * decides the rest. The dev bypass (`dev-staff-2fa-bypass.ts`) reaches this
 * through the port, which the composition root builds with it.
 */
export const requireStaffSecondFactor = t.middleware(async ({ ctx, path, next }) => {
  if (!ctx.actorHumanId || !isSecondFactorGatedPath(path)) {
    return next({ ctx });
  }

  const staffCheck = await ctx.authz.hasStaffRole({
    actorHumanId: ctx.actorHumanId,
    requiredRoles: SECOND_FACTOR_GATED_ROLES,
  });
  throwIfStaffSecondFactorRequired(staffCheck);

  return next({ ctx });
});

/**
 * Raises `SECOND_FACTOR_REQUIRED` when a default `hasStaffRole` probe says
 * the actor holds the role and has no second factor enrolled. Does nothing
 * for any other answer, so the caller still handles `allowed`.
 *
 * For staff-only branches that live INSIDE a broader procedure also used by
 * non-staff callers — listing that path would demand a second factor from
 * everyone else who holds a gated role and calls the same procedure. Used by
 * `unified-search.ts`'s `autocompleteAdmin` owner-scope override and
 * `community.ts`'s `listEventDates` moderator view, and by the middleware
 * above.
 */
export function throwIfStaffSecondFactorRequired(probe: {
  secondFactorRequired?: true | undefined;
}): void {
  if (!probe.secondFactorRequired) return;
  try {
    fail("SECOND_FACTOR_REQUIRED");
  } catch (err) {
    throw toTrpcError(err);
  }
}
