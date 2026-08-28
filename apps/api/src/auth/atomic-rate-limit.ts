import { createHmac } from "node:crypto";

import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import { resolveClientIp } from "@th/trpc/client-ip";

import { resolveAuthLimits, resolveGuessSpaceRule } from "./rate-limit-rules";

/**
 * ATOMIC pre-limiter for Better Auth's guess-space endpoints.
 *
 * ## Why this exists
 *
 * Better Auth's built-in rate limiter is a non-atomic read-modify-write:
 * `onRequestRateLimit` does `storage.get(key)` and `onResponseRateLimit` does
 * `get` → `set(key, count + 1)` (`better-auth/dist/api/rate-limiter/index.mjs`).
 * The arithmetic happens in Better Auth core, BETWEEN our `customStorage`
 * hook's `get` and `set`, so concurrent requests all read the same count and
 * all write `count + 1`. Increments are lost, and every cap in
 * `rate-limit-rules.ts` becomes a floor rather than a ceiling.
 *
 * Measured against the live dev API — `/sign-in/email`, cap `{window:60,
 * max:5}`, wrong password, one pinned `cf-connecting-ip`:
 *
 *   12 SEQUENTIAL  → 401 401 401 401 401 429 429 429 429 429 429 429
 *   24 CONCURRENT  → 24x 401, ZERO 429s
 *
 * The storage adapter CANNOT fix this — no amount of Redis work inside
 * `get`/`set` closes a gap that lives in the caller. So we enforce the same
 * numbers ahead of Better Auth with this repo's own atomic limiter
 * (`RedisRateLimitAdapter`: INCR + self-healing EXPIRE in a single Lua
 * `EVAL`). Better Auth's limiter stays enabled and untouched as a backstop.
 *
 * THE BACKSTOP IS NOT A SAFETY NET FOR NON-CANONICAL PATHS. "Effective limit
 * is the min of the two" holds only for the CANONICAL form. Better Auth keys
 * its own limiter with `normalizePathname` (a `startsWith` basePath strip)
 * while its router strips with `split` + rou3 — so for every non-canonical
 * form (dot segments, basePath re-occurrence, a non-empty first segment) its
 * `customRules` lookup MISSES and the request lands on the 100/60s global
 * floor, not the 5/60s rule. For those forms THIS LAYER IS THE ONLY THING
 * applying the correct cap. Do not reason "even if the pre-limiter has a gap,
 * Better Auth still caps it at 5" — it does not.
 *
 * Deliberately NOT done: faking atomic counts inside `customStorage`. That
 * would encode Better Auth's internal algorithm into our storage and break
 * silently on the next upgrade.
 *
 * ## Scope
 *
 * Guess-space endpoints only — see `AUTH_GUESS_SPACE_PATHS` in
 * `rate-limit-rules.ts` for the list and for why `/get-session`, `/token` and
 * the global floor are excluded.
 */

/**
 * Better Auth's basePath. `better-auth.ts` never overrides `basePath`, so it
 * is the library default, and `plugins/better-auth.ts` mounts the Fastify
 * catch-all at the same prefix. Endpoint paths in `rate-limit-rules.ts` are
 * written basePath-relative (`/sign-in/email`), exactly as Better Auth
 * normalizes them before matching `customRules`.
 */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * Redis key namespace for this limiter's buckets.
 *
 * Must not collide with either neighbour on the shared Redis:
 *  - Better Auth's own counters live under `bauth:rl:` (KEY_PREFIX in
 *    `rate-limit-storage.ts`).
 *  - The tRPC limiter's counters live under `rl:` (RedisRateLimitAdapter's
 *    default prefix) with keys like `default:<procedure>:<actor>` or
 *    `announce:send:<orgId>`.
 *
 * We go through the same `RateLimitPort` instance as tRPC, so the final Redis
 * key is `rl:authgate:...` — sharing the `rl:` prefix but distinct in the
 * first segment, which no tRPC key uses.
 */
export const AUTH_ATOMIC_KEY_NAMESPACE = "authgate";

/**
 * Byte-for-byte what Better Auth's `rateLimitResponse()` sends, so no client
 * can tell which limiter denied it. Confirmed against the running dev API,
 * not just read out of the dist:
 *
 *   HTTP/1.1 429 Too Many Requests
 *   content-type: text/plain;charset=UTF-8
 *   x-retry-after: 60
 *
 *   {"message":"Too many requests. Please try again later."}
 *
 * (`new Response(jsonString)` with no explicit content-type is why a JSON
 * body ships as `text/plain` — matching the quirk matters, because
 * `apps/web/src/lib/trpc.ts`'s auth cold-load retry logic keys off the wire
 * shape it already sees.)
 */
export const AUTH_RATE_LIMIT_RESPONSE_BODY = JSON.stringify({
  message: "Too many requests. Please try again later.",
});
export const AUTH_RATE_LIMIT_RESPONSE_CONTENT_TYPE = "text/plain;charset=UTF-8";
export const AUTH_RATE_LIMIT_RETRY_AFTER_HEADER = "x-retry-after";

/**
 * Matches the 15-minute window used by `guard.ts` (tRPC) and
 * `rate-limit-storage.ts` (Better Auth storage): a sustained Redis outage
 * should leave periodic breadcrumbs in Sentry, not one event per request and
 * not silence after the first.
 */
const REPORT_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Cap on how much attacker-controlled text can end up inside a Redis key.
 * The IP component is a RAW forwarded header value (deliberately unvalidated
 * — see `resolveClientIp`), so it is whatever the client sent.
 */
const MAX_IP_KEY_LENGTH = 64;

type HeadersLike = Record<string, unknown> | null | undefined;

export type AuthRateLimitLogger = {
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
};

export type AtomicAuthRateLimitDeps = {
  rateLimit: RateLimitPort;
  logger: AuthRateLimitLogger;
  /**
   * Secret keying the account-identifier HMAC (see
   * {@link createAccountIdentifierHasher}).
   *
   * Injected rather than read from `env` so this module stays framework-free
   * and unit-testable; the composition root (`plugins/auth-rate-limit.ts`)
   * supplies it.
   */
  identifierHashKey: string;
  /**
   * Best-effort Sentry reporter for the FAIL-OPEN branches only. Wired at the
   * composition root. Never fired for an ordinary denial — a 429 is expected
   * behaviour, not an error.
   */
  reportError?: ReporterPort;
};

export type AtomicAuthRateLimitRequest = {
  /** Raw request URL, e.g. `/api/auth/sign-in/email?foo=1`. */
  url: string;
  headers: HeadersLike;
  /** Fastify-parsed body. Object for JSON, Buffer/string otherwise. */
  body: unknown;
  /**
   * Raw `content-type` header. Needed because Fastify's parser matches the
   * LITERAL `application/json` while better-call accepts anything matching
   * its own (looser) JSON predicate — see {@link BETTER_CALL_JSON_CONTENT_TYPE}.
   */
  contentType?: unknown;
  /** Server-observed socket peer — LAST resort, see {@link resolveLimiterIp}. */
  socketAddress?: unknown;
};

export type AtomicAuthRateLimitDecision =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

/**
 * Resolve the path the way the DOWNSTREAM does, then strip Better Auth's
 * basePath / trailing slashes so the result matches the keys in
 * `AUTH_RATE_LIMIT_CUSTOM_RULES`.
 *
 * ## Why `new URL()` and not string surgery
 *
 * `plugins/better-auth.ts` builds `new URL(request.url, ...)` and hands the
 * RESULT to `auth.handler`, so WHATWG URL normalization happens BETWEEN this
 * limiter and better-call's router. Any path-matching here that works on
 * Fastify's RAW request target therefore sees a DIFFERENT string than the
 * thing that actually executes — and every difference is a total bypass of
 * this layer.
 *
 * That was not theoretical. Measured against the live dev API, 24 concurrent
 * requests each (cap 5), before this function used `new URL`:
 *
 *   /api/auth/sign-in/email              →  5 x 401, 19 x 429   (limiter on)
 *   /api/auth/./sign-in/email            → 24 x 401              (BYPASS)
 *   /api/auth/%2e/sign-in/email          → 24 x 401              (BYPASS)
 *   /api/auth/x/.%2e/sign-in/email       → 24 x 401              (BYPASS)
 *   /api/auth/sign-in\email              → 24 x 401              (BYPASS)
 *   /api/auth/passkey/x/../verify-authentication → 24 x 400      (BYPASS)
 *
 * WHATWG does dot-segment removal, decodes `%2e` as a dot segment, and — for
 * special schemes — rewrites `\` to `/`. The BACKSLASH case is the nastiest:
 * it has no dot segments, so an upstream RFC-3986 normalizer would not
 * neutralize it, and `ENFORCE_ORIGIN_SECRET` defaults to FALSE (log-only), so
 * the `*.run.app` origin is reachable with no edge normalization at all.
 *
 * Using the same primitive as the downstream is what makes agreement
 * structural rather than a list of escapes to keep in sync. Verified
 * equivalent for every variant above.
 *
 * ## Why the basePath strip is a SUBSTRING SEARCH, not a prefix test
 *
 * The `new URL()` half above is necessary but not sufficient. A `startsWith`
 * strip mirrors `normalizePathname` (`@better-auth/core/utils/url`) — and
 * that function drives Better Auth's OWN limiter, NOT the router that decides
 * what executes. better-call strips with
 *
 *   pathname.split(basePath).reduce((acc, curr, i) => {
 *     if (i !== 0) { if (i > 1) acc.push(`${basePath}${curr}`); else acc.push(curr); }
 *     return acc;
 *   }, []).join("")
 *
 * (`node_modules/better-call/dist/router.mjs`), which DISCARDS everything
 * before the FIRST occurrence of basePath. That reduce is algebraically
 * `pathname.slice(pathname.indexOf(basePath) + basePath.length)` — the parts
 * after index 1 get basePath re-prepended, so the join reconstructs the raw
 * suffix exactly. `indexOf` is used below for clarity; the equivalence is not
 * assumed, it is asserted against a VERBATIM copy of the reduce over a table
 * of targets in `test/auth-atomic-rate-limit.test.ts`, so a better-call
 * upgrade that changes the derivation fails loudly instead of silently
 * reopening this hole.
 *
 * The gap that mattered, measured live at 24 concurrent (cap 5):
 *
 *   /api/auth/../api/auth/sign-in/email     → 24 x 401  (BYPASS)
 *   /api/auth/../x/api/auth/sign-in/email   → 24 x 401  (BYPASS)
 *   /api/auth/..\x/api/auth/sign-in/email   → 24 x 401  (BYPASS)
 *
 * Trace of the first: Fastify routes it (the RAW target starts with
 * `/api/auth/`, so the plugin's pre-filter fires) → `new URL` normalizes to
 * `/api/api/auth/sign-in/email` → a `startsWith` test FAILS → null, zero
 * tokens → but better-call's split yields `/sign-in/email` and sign-in runs.
 * Better Auth's own limiter has the same inconsistency internally, so its
 * customRule missed too and the request fell through to the 100/60s global
 * floor — the bypass degraded the backstop as well.
 *
 * ## rou3 IGNORES THE CONTENT OF THE FIRST SEGMENT
 *
 * The remainder does NOT have to start with `/` to route. rou3 (better-call's
 * router) splits the path on `/` and compares from index 1 — segment 0's
 * content is never examined, only the segment COUNT has to match. Executed
 * against the installed rou3 0.7.12, not inferred:
 *
 *   findRoute("X/token")             -> /token
 *   findRoute("9;1y/sign-in/email")  -> /sign-in/email
 *   findRoute(":a/sign-in/email")    -> /sign-in/email
 *   findRoute("!/sign-in/email")     -> /sign-in/email
 *   findRoute("token")               -> no match   (segment count differs)
 *   findRoute("orize")               -> no match   (segment count differs)
 *   findRoute("api/auth/sign-in/email") -> no match (segment count differs)
 *
 * So `/api/auth/../api/authX/sign-in/email` normalizes to
 * `/api/api/authX/sign-in/email`, the basePath strip yields
 * `X/sign-in/email`, and rou3 happily routes that to `/sign-in/email`. A
 * `!rest.startsWith("/") → null` rejection was therefore a FALSE PREMISE and a
 * total bypass — measured live at 24 x 401, zero 429s, with the character
 * after `auth` free (`X`, `9`, `;`, `-`, … all work), making it trivially
 * shardable as well.
 *
 * The fix is to COLLAPSE that leading segment to the empty one the canonical
 * form has, rather than reject: it must land in the SAME bucket as the
 * canonical path, or varying the segment shards the counter.
 *
 * ## Rejections
 *
 * Applied to the STRIPPED remainder (`rest`), matching the router's own
 * post-strip checks in `processRequest`:
 *
 *  - empty                → better-call returns 404 (`if (!path?.length)`)
 *  - contains `//`        → better-call returns 404 (`/\/{2,}/.test(path)`)
 *  - no `/` at all        → wrong segment count, rou3 can never match. This is
 *                           what keeps `/api/authorize` (strip → `orize`) out.
 *
 * Verified live rather than reasoned about, because rejecting something the
 * router would EXECUTE is the failure mode that matters:
 * `/api/auth//sign-in/email`, a trailing slash, a case-changed path, a
 * percent-encoded letter (`/%73ign-in/`), `/api/auth/api/auth/sign-in/email`
 * and `/api/auth/..%2fx/...` (`%2f` is not decoded as a separator, so hook and
 * router agree) ALL return 404.
 *
 * The trailing-slash strip is deliberately kept: it mirrors
 * `normalizePathname`, which is what Better Auth's own limiter matches
 * `customRules` with, so both limiters agree on the rule even though rou3
 * itself 404s the trailing-slash form. Over-inclusive in the safe direction.
 */
export function normalizeAuthPath(url: string): string | null {
  // Origin-form only. `//host/path` is protocol-relative: resolving it against
  // a base would silently swap the authority and hand back a pathname from a
  // different origin.
  if (!url.startsWith("/") || url.startsWith("//")) return null;

  let pathname: string;
  try {
    // The base is irrelevant to `.pathname` for an origin-form target; it only
    // exists because `new URL` requires one. This is the SAME computation
    // `plugins/better-auth.ts` performs (there with the real host).
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    // Unparseable target — no path to key on, and better-call will not route
    // it either. Never throw into the auth request path.
    return null;
  }

  // Mirror the ROUTER: discard everything up to and including the FIRST
  // occurrence of basePath. NOT `startsWith` — see the long note above.
  const basePathIndex = pathname.indexOf(AUTH_BASE_PATH);
  if (basePathIndex === -1) return null;
  let rest = pathname.slice(basePathIndex + AUTH_BASE_PATH.length);

  if (!rest.length) return null;

  // rou3 ignores the CONTENT of segment 0 — only the segment COUNT must match
  // (see the long note above; executed against rou3 0.7.12, not inferred). So
  // a remainder that does not start with "/" still executes the endpoint.
  // COLLAPSE that leading segment onto the empty one the canonical form has,
  // so the request shares the canonical path's bucket and cannot be sharded by
  // varying the segment. Do NOT reject here — rejecting was bypass #4.
  if (!rest.startsWith("/")) {
    const firstSlash = rest.indexOf("/");
    // No slash at all (e.g. `/api/authorize` → `orize`): the segment count is
    // wrong, so rou3 can never match a route. Safe to drop.
    if (firstSlash === -1) return null;
    rest = rest.slice(firstSlash);
  }

  if (rest.includes("//")) return null;

  return rest.replace(/\/+$/, "") || "/";
}

/**
 * Which body field carries the account identifier, per endpoint. Every entry
 * was read off the endpoint's actual zod body schema in the installed
 * better-auth 1.6.9 / @better-auth/passkey dist — NOT assumed from the path:
 *
 *   /sign-in/email                    { email, password, ... }
 *   /sign-in/username                 { username, password, ... }
 *   /sign-in/phone-number             { phoneNumber, password, ... }
 *   /sign-in/email-otp                { email, otp, ... }
 *   /email-otp/verify-email           { email, otp }
 *   /email-otp/send-verification-otp  { email, type }
 *   /phone-number/verify              { phoneNumber, code, ... }
 *   /phone-number/send-otp            { phoneNumber }
 *
 * The remaining guess-space paths carry NO account identifier at all and are
 * therefore IP-limited only (documented rather than guessed at):
 *
 *   /two-factor/verify-{totp,otp,backup-code}  { code, trustDevice } — the
 *       account is identified by the two-factor cookie, not the body.
 *   /magic-link/verify                          GET, `?token=` in the query.
 *   /passkey/verify-authentication              { response } — a WebAuthn
 *       assertion; the credential id inside it is not a stable account handle
 *       we want to key on.
 */
const ACCOUNT_IDENTIFIER_FIELD: Readonly<Record<string, string>> = {
  "/sign-in/email": "email",
  "/sign-in/username": "username",
  "/sign-in/phone-number": "phoneNumber",
  "/sign-in/email-otp": "email",
  "/email-otp/verify-email": "email",
  "/email-otp/send-verification-otp": "email",
  "/phone-number/verify": "phoneNumber",
  "/phone-number/send-otp": "phoneNumber",
};

/**
 * better-call's OWN JSON predicate, copied verbatim from
 * `node_modules/better-call/dist/utils.mjs`:
 *
 *   const jsonContentTypeRegex = /^application\/([a-z0-9.+-]*\+)?json/i;
 *   ...
 *   if (jsonContentTypeRegex.test(normalizedContentType)) return await request.json();
 *
 * Note it is END-UNANCHORED, and the media-type allowlist upstream of it gates
 * with `base.includes("application/json")` — a SUBSTRING test. So
 * `application/jsonx` is a perfectly valid sign-in body as far as Better Auth
 * is concerned.
 *
 * `plugins/raw-body.ts`, meanwhile, registers Fastify's JSON parser for the
 * LITERAL string `application/json`, so `application/jsonx` falls through to
 * the `"*"` Buffer parser. One character therefore used to disable the ONLY
 * limiter dimension that survives IP rotation. Measured live, 24 concurrent
 * requests from 24 DISTINCT IPs against ONE account (account cap 20):
 *
 *   Content-Type: application/json             → 20 x 401,  4 x 429
 *   Content-Type: application/json; charset=…  → 20 x 401,  4 x 429
 *   Content-Type: application/jsonx            → 24 x 401   (BYPASS)
 *
 * Mirroring the sink's predicate exactly — same regex, same `.toLowerCase()`,
 * same full-string (not base) test — is what keeps the two from drifting.
 */
const BETTER_CALL_JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * Upper bound on a body we are willing to re-parse purely to read one field.
 * Fastify's own `bodyLimit` is 10 MiB (large CSV imports), and JSON.parse is
 * synchronous — re-parsing a 10 MiB payload would hand an attacker an
 * event-loop stall via the very endpoint being protected. Auth bodies are a
 * few hundred bytes; 64 KiB is enormous headroom. Over the bound we degrade to
 * IP-only rather than block.
 *
 * The stronger half of the argument: `extractAccountIdentifier` runs AFTER the
 * IP bucket has already allowed the request (the evaluator short-circuits on
 * IP denial), so an attacker gets at most `rule.max` — 5 — re-parses per IP
 * per window no matter what they send. The bound is a second belt, not the
 * thing standing between us and a parse-flood.
 */
const MAX_REPARSE_BYTES = 64 * 1024;

/** Fastify header values may be `string | string[]`. */
function firstHeaderValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    return typeof first === "string" ? first : null;
  }
  return null;
}

/**
 * When Fastify handed us a Buffer but better-call WOULD have parsed it as
 * JSON, parse it ourselves so the account bucket still applies. Returns the
 * body untouched when it is already an object, and `null` when there is
 * nothing safely readable.
 */
function coerceJsonBody(body: unknown, contentType: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;

  const raw = firstHeaderValue(contentType);
  if (!raw) return null;
  if (!BETTER_CALL_JSON_CONTENT_TYPE.test(raw.toLowerCase())) return null;
  if (body.byteLength > MAX_REPARSE_BYTES) return null;

  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    // Malformed JSON: nothing to key on, and Better Auth will 400 it anyway.
    return null;
  }
}

/**
 * Pull the account identifier out of the body and normalize it so `Foo@X.com`,
 * ` foo@x.com ` and `foo@x.com` share one bucket.
 *
 * `contentType` exists so a Buffer body that better-call would still accept as
 * JSON gets re-parsed here — see {@link BETTER_CALL_JSON_CONTENT_TYPE}.
 *
 * NEVER throws: a missing, non-object, unparseable, oversized or otherwise
 * malformed body yields `null`, which degrades that request to IP-only
 * limiting. An exception here would 500 the auth endpoint it is supposed to
 * protect.
 */
export function extractAccountIdentifier(
  path: string,
  body: unknown,
  contentType?: unknown,
): string | null {
  const field = ACCOUNT_IDENTIFIER_FIELD[path];
  if (!field) return null;

  const parsed = coerceJsonBody(body, contentType);
  if (typeof parsed !== "object" || parsed === null) return null;
  // Arrays are objects but never carry a named JSON field here. (Buffers are
  // already resolved by coerceJsonBody: either re-parsed or turned into null.)
  if (Buffer.isBuffer(parsed) || Array.isArray(parsed)) return null;

  const raw = (parsed as Record<string, unknown>)[field];
  if (typeof raw !== "string") return null;

  const normalized =
    field === "phoneNumber"
      ? // Phone numbers get formatting stripped so "+1 (615) 555-0100" and
        // "+16155550100" cannot be used to shard the account bucket.
        raw.replace(/[\s()\-.]/g, "")
      : raw.trim().toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

/**
 * Build the identifier hasher used for account bucket keys.
 *
 * Raw emails / phone numbers in infrastructure (Redis keyspace, `KEYS` dumps,
 * slowlog, any log line that echoes a key) are PII sitting outside the
 * database's access controls.
 *
 * KEYED (HMAC), not a bare digest. The stated threat is someone reading the
 * Redis keyspace, and the preimage space here is *enumerable*: emails and
 * phone numbers are guessable, so an unkeyed SHA-256 confirms membership at
 * megahashes/second against a wordlist — i.e. it obfuscates nothing from the
 * exact adversary it is meant to stop. HMAC with a secret the dump does not
 * contain makes that offline attack impossible.
 *
 * Truncated to 128 bits: collision-free at this scale and keeps keys short.
 *
 * DOMAIN-SEPARATED: the key in production is `BETTER_AUTH_SECRET`, which is
 * already used for other purposes, so the message is prefixed with a
 * NUL-terminated label. Without it, this construction and any other HMAC over
 * the same secret could be made to collide by an attacker who controls both
 * messages. The `\0` matters — a bare prefix is ambiguous if the label and the
 * value can otherwise run together.
 *
 * Rotating the key (or bumping the label version) re-buckets every account
 * once. Harmless — the window is 60s, so the worst case is one minute of
 * counters starting from zero.
 */
const IDENTIFIER_HASH_DOMAIN = "authgate:acct:v1\0";

export function createAccountIdentifierHasher(
  key: string,
): (value: string) => string {
  return (value) =>
    createHmac("sha256", key)
      .update(IDENTIFIER_HASH_DOMAIN)
      .update(value)
      .digest("hex")
      .slice(0, 32);
}

/**
 * Resolve the bucket IP using the platform-wide precedence
 * (`CLIENT_IP_HEADER_PRECEDENCE`, re-exported through `resolveClientIp`) —
 * the SAME source `better-auth.ts` feeds into
 * `advanced.ipAddress.ipAddressHeaders` and the same one the tRPC limiter
 * uses. Any other source (e.g. raw leftmost `x-forwarded-for`) would make the
 * key client-forgeable and the whole limiter shardable; see the long note at
 * the `advanced.ipAddress` wiring in `better-auth.ts`.
 *
 * Socket peer is tried LAST, matching `extractClientIp` in
 * `packages/transport/trpc/src/context.ts`. That differs from Better Auth,
 * which is headers-only (falling back to `127.0.0.1` in dev/test and to
 * SKIPPING rate limiting entirely in production when nothing resolves — see
 * `utils/get-request-ip.mjs`). The divergence is deliberate: "resolve nothing
 * ⇒ don't limit" is precisely the bypass this module exists to close.
 *
 * Residual risk, stated: behind the proxy the socket peer is Google's Cloud
 * Run frontend — the same value for every visitor — so a header-less world
 * would collapse all traffic into one bucket and lock everyone out. Cloud Run
 * always sets `x-forwarded-for` on inbound requests, so in a real deployment
 * the socket branch is unreachable; locally it yields `127.0.0.1`, which is
 * what Better Auth's dev fallback produces anyway.
 *
 * Returns `null` when even that resolves nothing.
 *
 * NOTE the returned value is RAW header text, truncated but not validated (no
 * `isIP` gate — see the deliberate note in `resolveClientIp`). An attacker can
 * therefore put an arbitrary 64-char string into a Redis key and into a
 * fail-open report's `extra.key`. That is accepted: it is bounded, it goes
 * only into structured logs and a Redis key name, and there is no injection
 * sink downstream (the limiter never interpolates it into a query).
 *
 * The consequence worth writing down: "no `@` appears in a bucket key" is NOT
 * a PII invariant, because a forged `x-real-ip` can contain one. The real PII
 * guarantee is that the ACCOUNT component is an HMAC — assert that, not the
 * absence of a character.
 */
export function resolveLimiterIp(
  headers: HeadersLike,
  socketAddress?: unknown,
): string | null {
  const ip = resolveClientIp(headers, socketAddress);
  if (!ip) return null;
  return ip.slice(0, MAX_IP_KEY_LENGTH);
}

export function buildIpBucketKey(path: string, ip: string): string {
  return `${AUTH_ATOMIC_KEY_NAMESPACE}:ip:${path}:${ip}`;
}

export function buildAccountBucketKey(
  path: string,
  identifierHash: string,
): string {
  return `${AUTH_ATOMIC_KEY_NAMESPACE}:acct:${path}:${identifierHash}`;
}

const ALLOWED: RateLimitResult = {
  allowed: true,
  remaining: Number.POSITIVE_INFINITY,
  retryAfterSeconds: 0,
};

/**
 * FAIL OPEN, matching house posture (`consumeRateLimitOrAllow` in
 * `packages/transport/trpc/src/guard.ts` and the `customStorage` wrapper in
 * `rate-limit-storage.ts`): a Redis outage must never brick sign-in.
 *
 * DOCUMENTED CONSEQUENCE: while Redis is down, brute-force protection on
 * these endpoints is OFF — this layer allows everything, and Better Auth's
 * own limiter fails open through the same storage. That is why the throttled
 * Sentry report below exists; it is the only signal that the protection has
 * silently stopped.
 */
async function consumeOrAllow(
  deps: AtomicAuthRateLimitDeps,
  reportFailure: ReporterPort,
  dimension: "ip" | "account",
  key: string,
  maxTokens: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    return await deps.rateLimit.consume(key, maxTokens, windowSeconds);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.logger.warn("auth_atomic_rate_limit_consume_failed", {
      dimension,
      key,
      error,
    });
    try {
      reportFailure(err, {
        tags: { area: "auth_atomic_rate_limit_fail_open", branch: dimension },
        extra: { key, error },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // fail-open allow into a thrown error.
    }
    return ALLOWED;
  }
}

/**
 * Build the evaluator. Returned as a closure so the throttled reporter's
 * window survives across requests (a per-request
 * `createThrottledReporter(...)` would never actually throttle anything —
 * same trap `guard.ts` memoizes around).
 */
export function createAtomicAuthRateLimiter(
  deps: AtomicAuthRateLimitDeps,
): (
  request: AtomicAuthRateLimitRequest,
) => Promise<AtomicAuthRateLimitDecision> {
  const reportFailure = createThrottledReporter(
    deps.reportError,
    REPORT_THROTTLE_MS,
  );
  const hashIdentifier = createAccountIdentifierHasher(deps.identifierHashKey);

  return async (request) =>
    evaluate(deps, reportFailure, hashIdentifier, request);
}

function denied(
  deps: AtomicAuthRateLimitDeps,
  path: string,
  dimension: "ip" | "account",
  result: RateLimitResult,
  windowSeconds: number,
): AtomicAuthRateLimitDecision {
  // Denials are EXPECTED behaviour, not errors: logged (never reported to
  // Sentry, which would page on a working control). `dimension` is
  // server-side only — the response body is identical either way, so a caller
  // can't probe which bucket they tripped.
  const retryAfterSeconds =
    result.retryAfterSeconds > 0 ? result.retryAfterSeconds : windowSeconds;
  deps.logger.warn("auth_atomic_rate_limit_denied", {
    path,
    dimension,
    retryAfterSeconds,
  });
  return { limited: true, retryAfterSeconds };
}

async function evaluate(
  deps: AtomicAuthRateLimitDeps,
  reportFailure: ReporterPort,
  hashIdentifier: (value: string) => string,
  request: AtomicAuthRateLimitRequest,
): Promise<AtomicAuthRateLimitDecision> {
  const path = normalizeAuthPath(request.url);
  if (!path) return { limited: false };

  // ONE lookup for both caps. Deliberately not two calls with a `!` on the
  // second: that non-null assertion was only safe because both funnelled
  // through `resolveGuessSpaceRule` in a fixed order, so a reorder would have
  // become a runtime crash on the auth request path.
  const limits = resolveAuthLimits(path);
  if (!limits) return { limited: false };
  const rule = limits.ip;

  const ip = resolveLimiterIp(request.headers, request.socketAddress);

  // ── IP bucket FIRST, and short-circuit on denial ─────────────────────
  //
  // Deliberately SEQUENTIAL rather than a `Promise.all` over both buckets,
  // at the cost of one extra Redis round-trip on the hot path.
  //
  // The account bucket is a shared resource belonging to the VICTIM, so a
  // token must only ever be spent on a request that was not already refused.
  // Burning it on requests we are 429ing anyway makes targeted lockout cost
  // `accountCap` requests from ONE host instead of requiring that many
  // DISTINCT IPs — i.e. it converts the account dimension from a
  // stuffing defence into a cheap denial-of-service button aimed at a
  // specific user. Demonstrated live before this ordering existed: after
  // driving one account's bucket past its cap from a single host, a sign-in
  // with the CORRECT password from a FRESH IP got a 429.
  //
  // The stuffing defence is untouched: an attacker rotating IPs never trips
  // the IP bucket, so their requests always reach — and are counted by — the
  // account bucket.
  if (ip) {
    const ipResult = await consumeOrAllow(
      deps,
      reportFailure,
      "ip",
      buildIpBucketKey(path, ip),
      rule.max,
      rule.window,
    );
    if (!ipResult.allowed) {
      return denied(deps, path, "ip", ipResult, rule.window);
    }
  }

  const identifier = extractAccountIdentifier(
    path,
    request.body,
    request.contentType,
  );

  // No identifier in the body (or none defined for this endpoint) — IP-only.
  // If neither dimension resolved, this layer allows and leaves the request
  // to Better Auth's own limiter.
  if (!identifier) return { limited: false };

  // Cap comes from the resolver, NOT `rule.max * <multiplier>` inline: the
  // anti-bombing send endpoints get a tighter multiplier than the guess-space
  // ones, and that distinction has to live next to the numbers or the next
  // multiplier change silently widens the send ceiling again.
  const accountCap = limits.account;
  const accountResult = await consumeOrAllow(
    deps,
    reportFailure,
    "account",
    buildAccountBucketKey(path, hashIdentifier(identifier)),
    accountCap.max,
    accountCap.window,
  );
  if (!accountResult.allowed) {
    return denied(deps, path, "account", accountResult, rule.window);
  }

  return { limited: false };
}
