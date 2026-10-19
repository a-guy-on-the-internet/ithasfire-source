/**
 * "A ban that sticks" (2026-09-29) — the Better Auth side.
 *
 *  - A banned human's email (canonicalised as mail is delivered, then HMAC'd)
 *    cannot be used to create an account or be moved onto an account.
 *  - Every sign-up and sign-in leaves a NetworkSighting: keyed hashes of the
 *    client IP and its network prefix, never the IP itself.
 *
 * Extracted from `better-auth.ts` for the same reason as `account-security.ts`:
 * importing the auth instance boots env, Prisma and Redis. The hooks there are
 * thin wiring over these functions.
 */

import type { LoggerPort } from "@th/ports";
import type { ReporterPort } from "@th/ports/reporter";
import { resolveTrustedClientIp } from "@th/trpc/client-ip";
import {
  isEmailBanned,
  type CheckBannedEmailDeps,
} from "@th/core/use-cases/auth/check-banned-email";
import {
  recordNetworkSighting,
  type RecordNetworkSightingDeps,
  type RecordNetworkSightingOutcome,
} from "@th/core/use-cases/auth/record-network-sighting";

/**
 * The refusal a banned address gets — deliberately the SAME code and message
 * the session gate answers a banned human with (`better-auth.ts`
 * session.create.before), so the response says nothing about why.
 */
export const ACCOUNT_NOT_ACTIVE_ERROR = {
  code: "ACCOUNT_NOT_ACTIVE",
  message: "This account is not active.",
} as const;

// ── Banned email ───────────────────────────────────────────────────────────

/**
 * May this address be used for a NEW account (or be moved onto one)? False
 * when it canonically matches a banned human's email. Lookup failures are
 * reported and rethrown by `isEmailBanned` (fail closed).
 */
export async function isEmailAllowedForAccount(
  deps: CheckBannedEmailDeps,
  email: unknown,
): Promise<boolean> {
  if (typeof email !== "string" || email.trim().length === 0) return true;
  return !(await isEmailBanned(deps, email));
}

/**
 * The new address a Better Auth `user.update` patch sets, or null when the
 * patch does not change the email.
 */
export function emailBeingSet(data: unknown): string | null {
  const email = (data as { email?: unknown } | null | undefined)?.email;
  return typeof email === "string" && email.trim().length > 0 ? email : null;
}

// ── Network sightings ──────────────────────────────────────────────────────

type HeaderBag = Record<string, string>;

function headersFromHookContext(ctx: unknown): HeaderBag {
  const c = ctx as {
    headers?: unknown;
    request?: { headers?: unknown } | null;
  } | null;
  const source = c?.headers ?? c?.request?.headers;
  const out: HeaderBag = {};
  if (!source) return out;
  if (typeof (source as Headers).forEach === "function") {
    (source as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (typeof source === "object") {
    for (const [key, value] of Object.entries(source as object)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/**
 * Client IP, country header and user agent for a Better Auth hook call. The
 * IP comes from the platform resolver (`resolveClientIp`, the same header
 * precedence Better Auth's own rate limiter is configured with) and ONLY
 * from the request: sessions no longer store an IP. The session row's
 * `userAgent` is the fallback when the hook context carries no headers.
 */
export function networkContextFromHook(
  ctx: unknown,
  fallback?: { userAgent?: unknown },
): {
  clientIp: string | null;
  countryHeader: string | null;
  userAgent: string | null;
} {
  const headers = headersFromHookContext(ctx);
  const fallbackUa =
    typeof fallback?.userAgent === "string" && fallback.userAgent
      ? fallback.userAgent
      : null;
  // Client-writable values are clipped here so an oversized header degrades
  // to "no match" in core instead of failing input validation.
  const clip = (value: string | null, max: number) =>
    value === null ? null : value.slice(0, max);
  return {
    clientIp: clip(resolveTrustedClientIp(headers), 256),
    countryHeader: clip(headers["cf-ipcountry"] ?? null, 16),
    userAgent: clip(headers["user-agent"] ?? fallbackUa, 4096),
  };
}

export type SightingHookDeps = RecordNetworkSightingDeps & {
  logger: LoggerPort;
  reportError?: ReporterPort;
  /** The Human linked to an AuthUser right now, or null. */
  loadHumanIdForAuthUser(authUserId: string): Promise<string | null>;
};

/**
 * Record a sighting from a Better Auth hook. NEVER throws: a sighting is
 * evidence for staff, not a gate, so a failure (including the humanId read)
 * is logged at ERROR and reported, and sign-up / sign-in carries on.
 */
export async function recordSightingFromHook(
  deps: SightingHookDeps,
  input: {
    authUserId: string;
    humanId?: string | null;
    kind: "SIGN_UP" | "SIGN_IN";
    ctx: unknown;
    fallback?: { userAgent?: unknown };
  },
): Promise<RecordNetworkSightingOutcome> {
  try {
    const humanId =
      input.humanId !== undefined
        ? input.humanId
        : await deps.loadHumanIdForAuthUser(input.authUserId);
    return await recordNetworkSighting(deps, {
      authUserId: input.authUserId,
      humanId,
      kind: input.kind,
      ...networkContextFromHook(input.ctx, input.fallback),
    });
  } catch (err) {
    deps.logger.error("auth.network_sighting.hook_failed", {
      kind: input.kind,
      authUserId: input.authUserId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { area: "auth", op: "network_sighting_hook", kind: input.kind },
        extra: { authUserId: input.authUserId },
      });
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return "failed";
  }
}
