// ─────────────────────────────────────────────────────────────────────────────
// Redis connection config — one resolver shared by every composition root.
//
// Exists because of the 2026-09-01 dev-jobs outage: Secret Manager
// `hf-dev-redis-url` was overwritten with the literal string
// `redis://127.0.0.1:6379`, so both `hf-dev-api` and `hf-dev-jobs` on Cloud Run
// dialled loopback. The API's guard only checked that REDIS_URL was *set* — it
// was — so nothing fired. Jobs had no guard at all and no retry bound, so it
// reconnected every ~2s for eleven days, flooding Cloud Logging and Sentry
// while every job hard-failed. Two things had to change: the guard has to look
// at the *host*, not just presence, and the client has to fail fast.
// ─────────────────────────────────────────────────────────────────────────────

export interface RedisConnectionConfig {
  /** Connection URL to hand to `new Redis(...)`. */
  url: string;
  /**
   * ioredis `keyPrefix`. Undefined when no namespace is configured (local dev),
   * so keys keep their historical un-prefixed names.
   */
  keyPrefix?: string;
  commandTimeout: number;
  maxRetriesPerRequest: number;
}

export interface ResolveRedisConnectionInput {
  /** Raw `REDIS_URL`. */
  url: string | undefined;
  /** Raw `REDIS_NAMESPACE`, e.g. `ithasfire:dev`. Trailing `:` optional. */
  namespace: string | undefined;
  /** Raw `NODE_ENV`. Only the exact value `"production"` enables the guards. */
  nodeEnv: string | undefined;
}

const LOCAL_FALLBACK_URL = "redis://localhost:6379";

/**
 * `commandTimeout` + `maxRetriesPerRequest` are bounded so a wedged/unreachable
 * Redis connection fails fast instead of hanging (or silently retrying for a
 * long time via ioredis's default offline-queueing behaviour).
 *
 * On the API this client backs `defaultRateLimit`, applied to EVERY tRPC
 * procedure in the request path (2026-07-05 security-audit follow-up) — a
 * slow-to-fail Redis call there would add latency to the whole API, not just
 * the ~11 routers with their own rate limits. The rate-limit middleware
 * (`guard.ts`) fails open on any Redis error, so a fast, bounded failure here
 * is strictly better than the previous unbounded default. Idempotency
 * (`RedisIdempotency`, when `IDEMPOTENCY_BACKEND=redis`) shares this same
 * client; failing fast on a wedged connection is an improvement there too —
 * idempotency callers shouldn't hang the request indefinitely either.
 *
 * Jobs shares the same bounds: unbounded retries are exactly what turned the
 * Sep-2026 misconfiguration into an 11-day log flood.
 */
const COMMAND_TIMEOUT_MS = 500;
const MAX_RETRIES_PER_REQUEST = 2;

/** Hostnames that can never be a real Redis server from inside a container. */
const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "::1", "::"]);

/** The whole 127.0.0.0/8 range, not just 127.0.0.1. */
const IPV4_LOOPBACK_RANGE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * `redis:` / `rediss:` are NON-SPECIAL schemes, so WHATWG `new URL()` uses the
 * opaque-host parser and does NOT normalise IPv4 shorthand the way it would for
 * `http:`. Measured 2026-09-14:
 *
 *   redis://127.1:6379              -> hostname "127.1"
 *   redis://2130706433:6379         -> hostname "2130706433"
 *   redis://[::ffff:127.0.0.1]:6379 -> hostname "[::ffff:7f00:1]"
 *
 * All three reach 127.0.0.1 once `net.connect` resolves them, so a check that
 * only matched dotted-quad would wave them straight through. These are the
 * shorthand forms a human actually types; this is a misconfiguration guard,
 * not an adversarial one, so exotic encodings are out of scope by design.
 */
function isLoopbackShorthand(host: string): boolean {
  // Bare 32-bit integer, e.g. 2130706433 === 127.0.0.1.
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    return Number.isInteger(n) && n >>> 24 === 127;
  }
  // Dotted shorthand with fewer than four parts, e.g. 127.1 or 127.0.1.
  if (/^127(\.\d{1,3}){1,2}$/.test(host)) return true;
  // IPv4-mapped IPv6, which `new URL()` compresses to ::ffff:7f00:1.
  if (/^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(host)) {
    return true;
  }
  return false;
}

/**
 * `new URL()` keeps IPv6 hosts bracketed (`[::1]`); strip them so the host
 * compares equal to the bare literal.
 */
function normalizeHost(hostname: string): string {
  const unbracketed =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return unbracketed.toLowerCase();
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "") return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  // RFC 6761 reserves the whole `.localhost` TLD for loopback.
  if (host.endsWith(".localhost")) return true;
  if (IPV4_LOOPBACK_RANGE.test(host)) return true;
  return isLoopbackShorthand(host);
}

/**
 * Normalise `REDIS_NAMESPACE` into an ioredis `keyPrefix`.
 *
 * Terraform emits `ithasfire:dev` / `ithasfire:prod` with NO trailing colon,
 * but ioredis concatenates `keyPrefix` verbatim, so we add exactly one. An
 * already-suffixed value is left alone rather than doubled.
 */
export function normalizeKeyPrefix(
  namespace: string | undefined,
): string | undefined {
  const trimmed = namespace?.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith(":") ? trimmed : `${trimmed}:`;
}

export function resolveRedisConnection(
  input: ResolveRedisConnectionInput,
): RedisConnectionConfig {
  const isProduction = input.nodeEnv === "production";
  const rawUrl = input.url?.trim() ? input.url.trim() : undefined;

  if (!rawUrl) {
    // Preserved verbatim: apps/api has thrown exactly this since 2026-07.
    if (isProduction) throw new Error("REDIS_URL is required in production");
    return {
      url: LOCAL_FALLBACK_URL,
      keyPrefix: normalizeKeyPrefix(input.namespace),
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    };
  }

  if (isProduction) {
    let hostname: string;
    try {
      hostname = new URL(rawUrl).hostname;
    } catch {
      // Don't hand an unparseable URL to ioredis and hope — that is how a
      // config typo becomes a reconnect loop instead of a boot failure.
      // The URL itself is NOT interpolated: it carries the Redis password.
      throw new Error(
        "REDIS_URL is not a parseable URL — refusing to start in production",
      );
    }
    if (hostname === "") {
      throw new Error(
        "REDIS_URL has no host — refusing to start in production",
      );
    }
    if (isLoopbackHost(hostname)) {
      throw new Error(
        `REDIS_URL points at the loopback address "${hostname}" in production — ` +
          "this deploy is misconfigured (a container cannot reach a Redis on its own loopback). " +
          "Check the REDIS_URL secret.",
      );
    }
  }

  return {
    url: rawUrl,
    keyPrefix: normalizeKeyPrefix(input.namespace),
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
  };
}
