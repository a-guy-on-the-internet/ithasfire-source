import { TRPCError } from "@trpc/server";
import type { ApiKeyScope, AuthNErrorCode } from "@th/ports/authn";
import { rateLimitIpBucket } from "@th/core/lib/security/rate-limit-ip-bucket";
import {
  STAFF_KEY_REQUESTER_ROLES,
  hasStaffRoleIn,
  isOrgKeyAdmin,
} from "@th/core/use-cases/api-keys/_shared/rules";
import { t } from "../trpc";
import type { Ctx } from "../context";
import { chargeFailedAttempt, consumeRateLimitOrAllow } from "../guard";
import { scopeAuthzToKey } from "./authz";
import { isKeyDenylisted } from "./denylist";
import { keyInputViolations } from "./input-guard";
import {
  SELF_RENEWAL_PATH,
  isSelfRenewalTag,
  keyTagProblems,
  type KeyAccessLevel,
} from "./meta";
import { scopeReposToKey } from "./repos";

/**
 * NFR-004: a PLATFORM_WIDE key's own bucket, per key, across every
 * procedure, enforced (not shadowed). Same fail-open posture as every other
 * limiter on the rate-limit port. The per-procedure floor still applies on
 * top, keyed on the IP because the call has no actor.
 */
export const PLATFORM_WIDE_KEY_RATE_LIMIT_MAX_REQUESTS = 60;
export const PLATFORM_WIDE_KEY_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Refused keys per client IP (IPv6 by /64). A refused key never reaches the
 * per-actor buckets, so without this a caller could guess keys at the floor
 * rate of every procedure. Charged, and enforced, only on a refusal: the key
 * is always resolved first, so a good key goes through even while its
 * address's bucket is spent (a shared NAT or office IP), and only a refused
 * key gets 429 instead of 401.
 *
 * Trade-off, accepted to keep valid keys unthrottled: key LOOKUPS per IP are
 * unbounded. This gate throws before the floor rate limit (`defaultRateLimit`,
 * guard.ts) runs, so a refused key never reaches it, and no bucket can stop a
 * lookup without first knowing the key is bad. A spent bucket only turns the
 * answer into 429. (Charging the floor's per-IP bucket here as well would add
 * nothing: it allows 240/min against this bucket's 30 per 10 min, and it too
 * would be charged only after the lookup. Session cookies are resolved before
 * the floor in the same way.)
 */
export const INVALID_KEY_MAX_ATTEMPTS = 30;
export const INVALID_KEY_WINDOW_SECONDS = 600;
export const invalidKeyBucket = (clientIp: string | null) =>
  `apikey:invalid:${rateLimitIpBucket(clientIp) ?? "unknown"}`;

const KEY_SCOPE_MESSAGE = "API_KEY_SCOPE";

const forbidden = (reason: string) =>
  new TRPCError({
    code: "FORBIDDEN",
    message: `${KEY_SCOPE_MESSAGE}: ${reason}`,
  });

const authNCode = (err: unknown): AuthNErrorCode | null => {
  if (err instanceof TRPCError) return null;
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code = (err as { code: unknown }).code;
  return code === "unauthorized" ||
    code === "invalid_input" ||
    code === "dependency_failed" ||
    code === "transient"
    ? code
    : null;
};

const requiredLevel = (
  type: "query" | "mutation" | "subscription",
  tagged: KeyAccessLevel,
): KeyAccessLevel =>
  type !== "query" || tagged === "READ_WRITE" ? "READ_WRITE" : "READ";

/**
 * The holder still qualifies for the key's subject, on the REAL authz port
 * (FR-006 c, R3, spec acceptance "demoting the holder ... makes their ORG
 * key fail on the next call"). Same rule as at request, approval and
 * collection (core `checkHolderEligibility`): ORG = a live OWNER / ADMIN of
 * the key's org; STAFF = a staff role in R28's set, through the port's
 * default probe, so the enrolled-second-factor rule applies when the port
 * enforces it. PERSONAL and PLATFORM_WIDE need no role.
 *
 * FOLLOW-UP: a STAFF holder refused only for want of a second factor gets
 * FORBIDDEN here. When session c9ec060d's `throwIfStaffSecondFactorRequired`
 * (guard.ts) and the port's `secondFactorRequired` flag land, probe
 * `ctx.authz.hasStaffRole` directly and raise SECOND_FACTOR_REQUIRED instead,
 * so the holder is told to enrol.
 */
async function holderStillQualifies(
  ctx: Ctx,
  humanId: string,
  key: Extract<ApiKeyScope, { kind: "scoped" }>,
): Promise<boolean> {
  switch (key.subject) {
    case "ORG":
      return key.orgId !== null && isOrgKeyAdmin(ctx, humanId, key.orgId);
    case "STAFF":
      return hasStaffRoleIn(ctx, humanId, STAFF_KEY_REQUESTER_ROLES);
    case "PERSONAL":
    case "PLATFORM_WIDE":
      return true;
  }
}

/**
 * The API-key gate (scoped-api-keys spec FR-006, FR-007, FR-008, FR-009,
 * NFR-004). Chained in `init.ts` right after timing and BEFORE auth, in all
 * three procedure chains, so no procedure built from them can skip it. A
 * request without a key passes straight through (sessions are unaffected),
 * except to a `selfRenewal` procedure, which is key-only.
 *
 * For a request with a key, in this order:
 * 1. Resolve the key once (one query, NFR-003), always: a valid key is
 *    never throttled by the refused-key bucket. A refused key (unknown,
 *    revoked, expired, holder not ACTIVE, partial scope) is charged to the
 *    client IP's refused-key bucket and answered UNAUTHORIZED on every chain
 *    (TOO_MANY_REQUESTS once that bucket is spent): a key caller is never
 *    quietly downgraded to anonymous. A backend failure is NOT a refusal:
 *    `transient` is 503, anything else is rethrown (500).
 * 2. FR-008: a denylisted path is FORBIDDEN for every key, legacy included
 *    (R4: "session-only whatever the scope"), whatever the procedure's tag.
 *    The one exception is `apiKeys.renewSelf` under its `selfRenewal` tag.
 * 3. R34a: a guarded input field (`KEY_GUARDED_INPUT_FIELDS`, volunteer
 *    auto-approve) sent with anything but `false` is FORBIDDEN for every key.
 * 4. Legacy key (no subject): the holder's full session, as before.
 * 5. Scoped key: a PLATFORM_WIDE key spends its own bucket first. Then
 *    default deny: the procedure's `key` tag must be well formed (see
 *    `keyTagProblems`), list the key's subject, and need no more access
 *    than the key has (a mutation always needs READ_WRITE). The holder must
 *    still qualify for the subject on the live authz port. Then the authz
 *    port AND `repos.authz` (with every `repos.tx`) are narrowed to the key,
 *    and the holder becomes the actor, except for PLATFORM_WIDE, which runs
 *    with no actor (FR-007).
 *
 * `resolvesActor` is false on the public chain, which never sets an actor.
 */
export function apiKeyGate(opts: { resolvesActor: boolean }) {
  return t.middleware(async ({ ctx, path, type, meta, next, getRawInput }) => {
    const tag = meta?.key;

    if (!ctx.apiKey) {
      if (isSelfRenewalTag(tag)) {
        throw forbidden("only an API key may call this procedure");
      }
      return next({ ctx: { ...ctx, keyScope: null, keySelfRenewal: null } });
    }

    const refusedBucket = invalidKeyBucket(ctx.clientIp);

    let humanId: string;
    let keyScope: ApiKeyScope;
    try {
      ({ humanId, keyScope } = await ctx.authn.ensureAuthedHumanFromApiKey({
        apiKey: ctx.apiKey,
      }));
    } catch (err) {
      const code = authNCode(err);
      if (code === "unauthorized" || code === "invalid_input") {
        // Throws TOO_MANY_REQUESTS (INVALID_ATTEMPTS_RATE_LIMITED) once the
        // address's bucket is spent; a 401 until then.
        await chargeFailedAttempt(ctx, {
          key: refusedBucket,
          maxRequests: INVALID_KEY_MAX_ATTEMPTS,
          windowSeconds: INVALID_KEY_WINDOW_SECONDS,
          message: "refused API keys from this address",
        });
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "unauthorized",
          cause: err,
        });
      }
      if (code === "transient") {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "API key check temporarily unavailable",
          cause: err,
        });
      }
      throw err;
    }
    const logger = ctx.logger.child({ apiKeyId: keyScope.keyId });

    const isSelfRenewal = isSelfRenewalTag(tag) && path === SELF_RENEWAL_PATH;
    if (isKeyDenylisted(path) && !isSelfRenewal) {
      throw forbidden("API keys cannot call this procedure");
    }
    // R34a: the raw input, before Zod parses it, so a field the procedure's
    // schema would strip or default is still seen as sent.
    const guarded = keyInputViolations(path, await getRawInput());
    if (guarded.length > 0) {
      throw forbidden(
        `API keys cannot set ${guarded.join(", ")} on this procedure`,
      );
    }

    // ── LEGACY KEY (no subject). Deleted at the FR-013 cutover (plan step
    // 10), with the legacy resolution path. Until then a legacy key is its
    // holder's session, as before this gate existed, minus the FR-008
    // denylist above. It has nothing to renew.
    if (keyScope.kind === "legacy") {
      if (isSelfRenewalTag(tag)) {
        throw forbidden("a key without a scope cannot renew itself");
      }
      return next({
        ctx: {
          ...ctx,
          logger,
          keyScope,
          keySelfRenewal: null,
          ...(opts.resolvesActor ? { actorHumanId: humanId } : {}),
        },
      });
    }
    // ── END LEGACY KEY

    const isPlatformWide = keyScope.subject === "PLATFORM_WIDE";
    if (isPlatformWide) {
      const result = await consumeRateLimitOrAllow(
        { ...ctx, logger },
        `apikey:platform-wide:${keyScope.keyId}`,
        PLATFORM_WIDE_KEY_RATE_LIMIT_MAX_REQUESTS,
        PLATFORM_WIDE_KEY_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!result.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Rate limit exceeded for this API key. Try again in ${result.retryAfterSeconds}s.`,
        });
      }
    }

    if (!tag) throw forbidden("this procedure does not accept API keys");
    if (
      keyTagProblems({ path, type, tag, isDenylisted: isKeyDenylisted })
        .length > 0
    ) {
      throw forbidden("this procedure's key tag is invalid");
    }

    if (!isSelfRenewal) {
      if (isSelfRenewalTag(tag)) {
        // Unreachable: keyTagProblems refuses selfRenewal off its path.
        throw forbidden("this procedure's key tag is invalid");
      }
      if (!tag.subjects.includes(keyScope.subject)) {
        throw forbidden(
          `this procedure does not accept ${keyScope.subject} keys`,
        );
      }
      if (
        requiredLevel(type, tag.level) === "READ_WRITE" &&
        keyScope.access !== "READ_WRITE"
      ) {
        throw forbidden("this procedure needs a read-write key");
      }
      // R19: read-only whatever the stored access says.
      if (isPlatformWide && type !== "query") {
        throw forbidden("a platform-wide key is read-only");
      }
    }
    if (keyScope.subject === "ORG" && !keyScope.orgId) {
      throw forbidden("an organization key without an organization");
    }

    // Live role, on the REAL port (ctx.authz is not narrowed yet).
    if (!(await holderStillQualifies(ctx, humanId, keyScope))) {
      throw forbidden("the key's holder no longer holds the role it needs");
    }

    return next({
      ctx: {
        ...ctx,
        logger,
        keyScope,
        keySelfRenewal: isSelfRenewal
          ? { keyId: keyScope.keyId, holderHumanId: humanId }
          : null,
        authz: scopeAuthzToKey(ctx.authz, keyScope),
        repos: scopeReposToKey(ctx.repos, keyScope),
        actorHumanId: opts.resolvesActor && !isPlatformWide ? humanId : null,
      } satisfies Ctx,
    });
  });
}
