import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

// Dependency-free on purpose: this module is bundled into the web middleware.
// Do not import ./utils (it pulls in @trpc/server, zod and @th/errors).
import { normalizeString } from "./normalize-string";

/**
 * Ordered header precedence for resolving the real client IP behind our proxy
 * chain. Request path today: client → Cloudflare edge → Google Cloud Run
 * frontend → container. Cloudflare sets `cf-connecting-ip`; the rest are
 * conventional fall-throughs. The server-observed socket peer is tried LAST
 * (and lives at the call site, not in this list): behind the proxy the socket
 * peer is Google's internal frontend — the SAME value for every anonymous
 * visitor — so it must never win over a forwarding header.
 *
 * This is the single source of truth for the precedence. `viewer-location.ts`
 * (geo) reuses this constant for the front of its broader source-labelling IP
 * list so the two cannot drift — see the cross-reference there. Better Auth's
 * rate limiter (`advanced.ipAddress.ipAddressHeaders` in
 * `apps/api/src/auth/better-auth.ts`, via the `@th/trpc/client-ip` subpath
 * export) reuses it likewise, so auth and tRPC rate limiting key on the same
 * client identity.
 */
export const CLIENT_IP_HEADER_PRECEDENCE = [
  "cf-connecting-ip",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
] as const;

type HeaderRecord = Record<string, unknown> | null | undefined;

/**
 * Lower-case every header key and collapse each value to a single trimmed
 * string. Fastify already lower-cases keys, but we normalize defensively so
 * callers/tests may pass mixed-case keys. Array-valued headers (e.g. a repeated
 * `x-forwarded-for`) collapse to their first non-empty entry.
 */
const normalizeHeaders = (headers: HeaderRecord): Record<string, string> => {
  const normalized: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return normalized;
  for (const [key, value] of Object.entries(headers)) {
    let picked: string | null = null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = normalizeString(entry);
        if (candidate) {
          picked = candidate;
          break;
        }
      }
    } else {
      picked = normalizeString(value);
    }
    if (picked) normalized[key.toLowerCase()] = picked;
  }
  return normalized;
};

/** Leftmost (client-most) entry of a comma-separated `x-forwarded-for` value. */
const firstForwardedFor = (value: string): string | null =>
  normalizeString(value.split(",")[0]);

/**
 * Resolve the client IP from forwarding headers, falling back to the
 * server-observed socket address. Header precedence is
 * {@link CLIENT_IP_HEADER_PRECEDENCE}; for `x-forwarded-for` we take the
 * leftmost (client-most) entry. Reads headers case-insensitively and handles
 * array-valued headers. Returns `null` when nothing resolves.
 */
export const resolveClientIp = (
  headers: HeaderRecord,
  socketAddress?: unknown,
): string | null => {
  const normalized = normalizeHeaders(headers);
  // DELIBERATELY no `isIP` validation gate here (unlike viewer-location.ts's
  // geo `pickIpField`). Behind Cloudflare `cf-connecting-ip` is always a valid
  // IP, and the rate limiter intentionally wants the raw forwarded value as its
  // bucket key — off-Cloudflare forgeability is the documented, accepted
  // soft-cap risk (see extractClientIp in context.ts), not something an isIP
  // check would meaningfully close. Do NOT "consistency-fix" this by bolting on
  // isIP: it would diverge the two resolvers this constant is shared to unify.
  for (const name of CLIENT_IP_HEADER_PRECEDENCE) {
    const raw = normalized[name];
    if (!raw) continue;
    if (name === "x-forwarded-for") {
      const first = firstForwardedFor(raw);
      if (first) return first;
      continue;
    }
    return raw;
  }
  return normalizeString(socketAddress);
};

/**
 * Client-IP fields for LOG LINES and ERROR REPORTS (forensics), as opposed to
 * {@link resolveClientIp}, which yields one rate-limit bucket key.
 *
 * - `clientIp`: the same value the limiters key on, so a log line can be
 *   joined to a limiter bucket.
 * - `cfConnectingIp`: the Cloudflare-set header on its own, so a reader can
 *   tell whether `clientIp` came from Cloudflare or from a fall-through.
 * - `forwardedFor`: the FULL `x-forwarded-for` chain, verbatim. When
 *   `cf-connecting-ip` is forged (see the hop-trust note below), the
 *   RIGHTMOST entries are still honest: each proxy APPENDS the peer it saw,
 *   and Google's Cloud Run frontend appends last. A direct-to-origin attacker
 *   therefore shows up there under their real address even though every
 *   header to its left is theirs to write.
 *
 * Hop trust (why the three are logged side by side, not collapsed): the
 * origin guard (apps/api/src/plugins/origin-guard.ts) only BLOCKS requests
 * that lack the Cloudflare-stamped `x-origin-secret` when
 * ENFORCE_ORIGIN_SECRET=true. Terraform defaults that flag to false and
 * neither envs/prod nor envs/dev sets it (checked 2026-09-29), so the
 * `*.run.app` origin still answers requests that never touched Cloudflare,
 * and `cf-connecting-ip` is client-forgeable on that path. Once enforcement
 * is on, `cf-connecting-ip` becomes trustworthy for every non-/health request.
 */
/**
 * Longest `forwardedFor` we log. The header is client-written, so an attacker
 * could otherwise pad every log line and Sentry tag with kilobytes. Truncation
 * keeps the RIGHTMOST characters: those are the proxy-appended, honest hops
 * (see above); the client-controlled prefix is what gets cut.
 */
export const MAX_FORWARDED_FOR_LENGTH = 512;

const TRUNCATION_MARK = "…";

const keepRightmost = (value: string | null): string | null =>
  value !== null && value.length > MAX_FORWARDED_FOR_LENGTH
    ? TRUNCATION_MARK +
      value.slice(value.length - (MAX_FORWARDED_FOR_LENGTH - TRUNCATION_MARK.length))
    : value;

/** Longest IP string we log (IPv6 with a zone id fits comfortably). */
export const MAX_LOGGED_IP_LENGTH = 64;

/**
 * For LOG LINES / SENTRY only: an IP-shaped value, or null. `cf-connecting-ip`
 * (and whatever `resolveClientIp` fell through to) is client-writable on the
 * direct-to-origin path, so without this a caller could put arbitrary text in
 * every log line and the `client_ip` tag. `resolveClientIp` itself is NOT
 * changed: the rate limiters key on it, and changing its output would move
 * every bucket.
 */
const loggableIp = (value: string | null | undefined): string | null => {
  if (!value || value.length > MAX_LOGGED_IP_LENGTH) return null;
  return isIP(value) !== 0 ? value : null;
};

export type ClientIpForensics = {
  clientIp: string | null;
  cfConnectingIp: string | null;
  forwardedFor: string | null;
};

/**
 * `resolvedClientIp`: pass `ctx.clientIp` when a tRPC context exists, so the
 * logged `clientIp` is the value the limiters actually keyed on — including a
 * verified web → API forward, which header-only resolution cannot see. The
 * raw `cfConnectingIp` / `forwardedFor` fields are unaffected. Omit it (or
 * pass `undefined`) to resolve from the headers as before.
 */
export const describeClientIp = (
  headers: HeaderRecord,
  socketAddress?: unknown,
  resolvedClientIp?: string | null,
): ClientIpForensics => {
  const rawXff =
    headers && typeof headers === "object"
      ? Object.entries(headers).find(
          ([k]) => k.toLowerCase() === "x-forwarded-for",
        )?.[1]
      : undefined;
  const forwardedFor = Array.isArray(rawXff)
    ? normalizeString(rawXff.filter((v) => typeof v === "string").join(", "))
    : normalizeString(rawXff);
  return {
    clientIp: loggableIp(
      resolvedClientIp !== undefined
        ? resolvedClientIp
        : resolveClientIp(headers, socketAddress),
    ),
    cfConnectingIp: loggableIp(normalizeHeaders(headers)["cf-connecting-ip"]),
    forwardedFor: keepRightmost(forwardedFor),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Signed client-IP forward (web → API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why this exists: the web app calls the API server-to-server on a guest's
 * behalf (the password-unlock route handler, the SSR tRPC client). On those
 * calls every header {@link resolveClientIp} reads describes the WEB SERVER,
 * not the guest — `cf-connecting-ip` is the web's egress IP when the call
 * goes out through Cloudflare, and the socket peer is Google's frontend when
 * it goes to the internal *.run.app origin. Every guest then shares one
 * rate-limit bucket.
 *
 * The fix is for the web to vouch for the visitor's IP with an HMAC the API
 * can check:
 *
 *   x-th-client-ip      the visitor IP (must pass `isIP`, ≤ 64 chars)
 *   x-th-client-ip-ts   integer unix SECONDS when signed
 *   x-th-client-ip-sig  base64url(HMAC-SHA256(key, "th-client-ip:v1\n<ip>\n<ts>"))
 *
 * `key` = HMAC-SHA256(ORIGIN_SHARED_SECRET, "th-client-ip-forward:v1"), so the
 * raw origin secret — which Cloudflare also stamps onto requests as
 * `x-origin-secret` — is never itself the MAC key. Both sides trim the secret
 * before deriving the key.
 *
 * The API accepts the forwarded IP only when every check in
 * {@link verifyClientIpForward} passes. Anything else is ignored and the
 * request resolves through {@link resolveClientIp} exactly as before, so a
 * forged or stale header can never do worse than today's behaviour.
 *
 * These are PURE functions: no env reads, the clock is passed in. The web
 * signer (`apps/web/src/server/client-ip-forward.ts`) and the API verifier
 * (`extractClientIp` in context.ts) both import them from here.
 */
export const CLIENT_IP_FORWARD_HEADER = "x-th-client-ip";
export const CLIENT_IP_FORWARD_TS_HEADER = "x-th-client-ip-ts";
export const CLIENT_IP_FORWARD_SIG_HEADER = "x-th-client-ip-sig";

/** How far a signature's timestamp may sit from the verifier's clock. */
export const CLIENT_IP_FORWARD_MAX_SKEW_SECONDS = 60;

/** Longest IP string the forward will carry (matches {@link MAX_LOGGED_IP_LENGTH}). */
const MAX_FORWARDED_IP_LENGTH = 64;

const CLIENT_IP_FORWARD_KEY_LABEL = "th-client-ip-forward:v1";
const CLIENT_IP_FORWARD_MESSAGE_PREFIX = "th-client-ip:v1";

/**
 * Unix seconds: digits only, no leading zeros (so one ts has one spelling),
 * at most 12 digits (past the year 30000).
 */
const UNIX_SECONDS_RE = /^(0|[1-9]\d{0,11})$/;

const configuredSecret = (secret: string | null | undefined): string | null => {
  if (typeof secret !== "string") return null;
  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isForwardableIp = (ip: unknown): ip is string =>
  typeof ip === "string" &&
  ip.length > 0 &&
  ip.length <= MAX_FORWARDED_IP_LENGTH &&
  isIP(ip) !== 0;

const clientIpForwardSignature = (
  secret: string,
  ip: string,
  ts: number,
): string => {
  const key = createHmac("sha256", secret)
    .update(CLIENT_IP_FORWARD_KEY_LABEL)
    .digest();
  return createHmac("sha256", key)
    .update(`${CLIENT_IP_FORWARD_MESSAGE_PREFIX}\n${ip}\n${ts}`)
    .digest("base64url");
};

/**
 * Build the three forward headers for `ip`. Returns `{}` (send nothing) when
 * the secret is unset/blank or `ip` is not an IP — the verifier would reject
 * those anyway, and an empty object keeps call sites a plain spread.
 */
export const signClientIpForward = ({
  ip,
  secret,
  nowSeconds,
}: {
  ip: string;
  secret: string | null | undefined;
  nowSeconds: number;
}): Record<string, string> => {
  const key = configuredSecret(secret);
  if (!key || !isForwardableIp(ip) || !Number.isFinite(nowSeconds)) return {};
  const ts = Math.floor(nowSeconds);
  if (ts < 0) return {};
  return {
    [CLIENT_IP_FORWARD_HEADER]: ip,
    [CLIENT_IP_FORWARD_TS_HEADER]: String(ts),
    [CLIENT_IP_FORWARD_SIG_HEADER]: clientIpForwardSignature(key, ip, ts),
  };
};

/**
 * Header lookup, case-insensitive on the name. `undefined` when absent; the
 * raw value otherwise (string, or an array if a caller built one — tests and
 * non-Node transports can).
 *
 * Note on repeats: Node joins repeated UNKNOWN headers (these three included)
 * into one `", "`-separated string rather than an array, so a duplicated
 * header reaches us as e.g. `"203.0.113.7, 198.51.100.9"`. That value fails
 * `isIP`, the timestamp regex, or the signature, so it is rejected all the
 * same — just as `bad_ip` / `malformed` / `bad_sig` rather than as an array.
 */
const rawHeader = (headers: HeaderRecord, name: string): unknown => {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
};

/**
 * Why a forward was not accepted:
 * - `absent`: none of the three headers was sent (the normal case for any
 *   request that did not come from our web server).
 * - `malformed`: some but not all were sent, one is array-valued, or the
 *   timestamp is not a canonical integer.
 * - `no_secret`: headers were sent but this side has no secret to check them.
 * - `bad_ip`: the forwarded value is not an IP (≤ 64 chars, `isIP`).
 * - `stale`: the timestamp is more than ±60s from our clock.
 * - `bad_sig`: the signature does not match.
 */
export type ClientIpForwardRejection =
  | "absent"
  | "malformed"
  | "no_secret"
  | "bad_ip"
  | "stale"
  | "bad_sig";

export type ClientIpForwardVerdict =
  | { ok: true; ip: string }
  | {
      ok: false;
      reason: ClientIpForwardRejection;
      /** All three headers were present (whatever their values). */
      complete: boolean;
      /** `now - ts` for a parsed timestamp — set for `stale` and `bad_sig`. */
      skewSeconds?: number;
    };

/**
 * {@link verifyClientIpForward}, with the reason on failure — for callers that
 * report rejected forwards (a rotated secret or drifting clock otherwise fails
 * silently: every guest falls back to the web server's IP). Never throws.
 */
export const checkClientIpForward = (
  headers: HeaderRecord,
  secret: string | null | undefined,
  nowSeconds: number,
): ClientIpForwardVerdict => {
  try {
    const rawIp = rawHeader(headers, CLIENT_IP_FORWARD_HEADER);
    const rawTs = rawHeader(headers, CLIENT_IP_FORWARD_TS_HEADER);
    const rawSig = rawHeader(headers, CLIENT_IP_FORWARD_SIG_HEADER);
    const present = [rawIp, rawTs, rawSig].filter((v) => v !== undefined);
    if (present.length === 0) {
      return { ok: false, reason: "absent", complete: false };
    }
    const complete = present.length === 3;
    if (
      !complete ||
      typeof rawIp !== "string" ||
      typeof rawTs !== "string" ||
      typeof rawSig !== "string"
    ) {
      return { ok: false, reason: "malformed", complete };
    }

    const key = configuredSecret(secret);
    if (!key) return { ok: false, reason: "no_secret", complete };

    if (!isForwardableIp(rawIp)) {
      return { ok: false, reason: "bad_ip", complete };
    }

    if (!UNIX_SECONDS_RE.test(rawTs) || !Number.isFinite(nowSeconds)) {
      return { ok: false, reason: "malformed", complete };
    }
    const ts = Number(rawTs);
    const skewSeconds = Math.floor(nowSeconds) - ts;
    if (Math.abs(nowSeconds - ts) > CLIENT_IP_FORWARD_MAX_SKEW_SECONDS) {
      return { ok: false, reason: "stale", complete, skewSeconds };
    }

    const expected = Buffer.from(
      clientIpForwardSignature(key, rawIp, ts),
      "utf8",
    );
    const provided = Buffer.from(rawSig, "utf8");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return { ok: false, reason: "bad_sig", complete, skewSeconds };
    }
    return { ok: true, ip: rawIp };
  } catch {
    return { ok: false, reason: "malformed", complete: false };
  }
};

/**
 * The verified visitor IP from a signed forward, or null when there is no
 * valid forward. Null means "ignore the three headers and resolve the IP the
 * usual way" — the caller falls back to {@link resolveClientIp}.
 *
 * Accepts only when: a secret is configured; all three headers are present
 * and single-valued; the timestamp is a canonical integer within
 * {@link CLIENT_IP_FORWARD_MAX_SKEW_SECONDS} of `nowSeconds`; the signature
 * matches (constant-time, length-checked first); and the IP passes `isIP`.
 * Never throws. See {@link checkClientIpForward} for the reason on failure.
 */
export const verifyClientIpForward = (
  headers: HeaderRecord,
  secret: string | null | undefined,
  nowSeconds: number,
): string | null => {
  const verdict = checkClientIpForward(headers, secret, nowSeconds);
  return verdict.ok ? verdict.ip : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Verified client IP (API-internal, stamped by apps/api)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Header the API stamps onto a request AFTER it has verified a signed forward
 * (`apps/api/src/plugins/verified-client-ip.ts`), so consumers that only see
 * headers — Better Auth's own rate limiter, the atomic auth pre-limiter, the
 * ban-gate network sightings — key on the visitor instead of the web server.
 *
 * INVARIANT (security-load-bearing): this header is trustworthy ONLY because
 * that plugin runs as a global `onRequest` hook on every API request and
 * (1) ALWAYS deletes any inbound copy, then (2) sets it only when
 * {@link checkClientIpForward} accepts the HMAC. A client can therefore never
 * set it. Anything that reads it — {@link TRUSTED_CLIENT_IP_HEADER_PRECEDENCE},
 * {@link resolveTrustedClientIp} — is only safe on a request that went
 * through that hook. Do NOT read it in apps/web (no stripping there: it is a
 * plain client-writable header), and do NOT fold it into
 * {@link CLIENT_IP_HEADER_PRECEDENCE} / {@link resolveClientIp}, which other
 * surfaces (viewer-location geo, the web app) use without the hook.
 */
export const VERIFIED_CLIENT_IP_HEADER = "x-th-verified-client-ip";

/**
 * {@link CLIENT_IP_HEADER_PRECEDENCE} with {@link VERIFIED_CLIENT_IP_HEADER}
 * first. For Better Auth's `advanced.ipAddress.ipAddressHeaders` only — see
 * the invariant on {@link VERIFIED_CLIENT_IP_HEADER}. A separate list rather
 * than a change to the shared constant, because `viewer-location.ts` reuses
 * that one for geo, and putting the visitor IP into geo would change what
 * edge-cached SSR renders.
 */
export const TRUSTED_CLIENT_IP_HEADER_PRECEDENCE = [
  VERIFIED_CLIENT_IP_HEADER,
  ...CLIENT_IP_HEADER_PRECEDENCE,
] as const;

/**
 * {@link resolveClientIp}, but a verified forward stamped by the API's
 * verified-client-ip plugin wins. Read the invariant on
 * {@link VERIFIED_CLIENT_IP_HEADER} before calling this anywhere new: it is
 * ONLY safe inside the API, on a request that passed that plugin's hook.
 *
 * The stamped value is re-checked as an IP (≤ 64 chars, `isIP`) — the plugin
 * only ever writes one, so this costs nothing and keeps a stray non-IP value
 * from becoming a bucket key. On anything else, resolution is exactly
 * {@link resolveClientIp}.
 */
export const resolveTrustedClientIp = (
  headers: HeaderRecord,
  socketAddress?: unknown,
): string | null => {
  const verified = normalizeHeaders(headers)[VERIFIED_CLIENT_IP_HEADER];
  if (isForwardableIp(verified)) return verified;
  return resolveClientIp(headers, socketAddress);
};

/**
 * True when the request carries `cf-connecting-ip` (any value, even empty):
 * it came in through the Cloudflare edge, which sets that header on every
 * request it proxies. False means the request reached the origin directly —
 * our own web server's internal SSR calls, local dev / e2e over loopback, or
 * a caller hitting the *.run.app origin. See `ClientIpSource` in context.ts
 * for what the rate limiter does with the distinction. Never throws.
 */
export const transitedEdge = (headers: HeaderRecord): boolean => {
  try {
    return rawHeader(headers, "cf-connecting-ip") !== undefined;
  } catch {
    return false;
  }
};
