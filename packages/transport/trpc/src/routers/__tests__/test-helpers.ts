import { vi } from "vitest";

import { router } from "../../init";
import type { Ctx } from "../../context";
import { createTestLogger } from "@th/test-utils";
import { withConsumeMany, withPeek } from "@th/test-utils/fakes/rate-limit";

type AnyCtx = Ctx;

const hasOwn = <T extends object>(obj: T | undefined, key: keyof T): boolean =>
  !!obj && Object.prototype.hasOwnProperty.call(obj, key);

export const buildBaseCtx = (overrides?: Partial<AnyCtx>): AnyCtx => {
  const repos = hasOwn(overrides, "repos")
    ? (overrides!.repos as AnyCtx["repos"])
    : ({} as unknown as AnyCtx["repos"]);

  const fileStorage =
    overrides?.fileStorage ?? ({} as unknown as AnyCtx["fileStorage"]);
    const eventUnlockSecret =
      hasOwn(overrides, "eventUnlockSecret")
        ? (overrides!.eventUnlockSecret ?? null)
        : null;
  const payments =
    overrides?.payments ??
    ({
      createPaymentIntent: vi.fn(),
      refundPaymentIntent: vi.fn(),
      createTransfer: vi.fn(),
      getChargeIdForPaymentIntent: vi.fn(),
      getPaymentMethodType: vi.fn(),
    } as unknown as AnyCtx["payments"]);
  const authn =
    overrides?.authn ??
    ({
      ensureAuthedHuman: vi.fn(),
      ensureAuthedHumanFromApiKey: vi.fn(),
      getProviderUserId: vi.fn().mockResolvedValue({ providerUserId: null }),
    } as unknown as AnyCtx["authn"]);
  const authz =
    overrides?.authz ??
    ({
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as AnyCtx["authz"]);
  const idempotency =
    overrides?.idempotency ??
    ({
      begin: vi.fn(),
      get: vi.fn(),
      commit: vi.fn(),
      fail: vi.fn(),
    } as unknown as AnyCtx["idempotency"]);
  const clock =
    overrides?.clock ??
    ({
      now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
    } as unknown as AnyCtx["clock"]);
  const logger = hasOwn(overrides, "logger")
    ? (overrides!.logger as AnyCtx["logger"])
    : createTestLogger();
  const placeLayoutParser =
    overrides?.placeLayoutParser ??
    ({
      parse: vi.fn(),
    } as unknown as AnyCtx["placeLayoutParser"]);
  const placeLayoutStreaming =
    overrides?.placeLayoutStreaming ??
    ({
      publishPlaceLayoutReplaced: vi.fn(),
    } as unknown as AnyCtx["placeLayoutStreaming"]);
  const searchQuery =
    overrides?.searchQuery ??
    ({
      autocomplete: vi.fn(),
      search: vi.fn(),
      related: vi.fn(),
    } as unknown as AnyCtx["searchQuery"]);
  const searchPrompts =
    overrides?.searchPrompts ??
    ({
      listPrompts: vi.fn(),
    } as unknown as AnyCtx["searchPrompts"]);
  const multiSearch = hasOwn(overrides, "multiSearch")
    ? (overrides!.multiSearch as AnyCtx["multiSearch"])
    : null;
  const geo =
    overrides?.geo ??
    ({
      reverseGeocode: vi.fn(),
      forwardGeocode: vi.fn(),
    } as unknown as AnyCtx["geo"]);
  const notify =
    overrides?.notify ??
    (vi.fn(async () => ({ ok: true })) as unknown as AnyCtx["notify"]);
  // A `{ consume }`-only override gets a `consumeMany` that routes through its
  // `consume` (see `withConsumeMany`), added IN PLACE so callers that re-spread
  // the raw override (delegates.test) still see it. Without it
  // `defaultRateLimit` throws, fails open, and the default limits silently stop
  // being exercised. A fake with no `peek` gets one that reads every key as 0
  // (see `withPeek`), so the password-failure gate sees "no failures yet"
  // instead of throwing into its fail-open branch.
  const rateLimit = overrides?.rateLimit
    ? typeof overrides.rateLimit.consumeMany === "function"
      ? (withPeek(overrides.rateLimit) as AnyCtx["rateLimit"])
      : (withConsumeMany(overrides.rateLimit) as AnyCtx["rateLimit"])
    : (withConsumeMany({
        consume: vi.fn(async () => ({
          allowed: true,
          remaining: Number.POSITIVE_INFINITY,
          retryAfterSeconds: 0,
        })),
      }) as unknown as AnyCtx["rateLimit"]);

  return {
    repos,
    fileStorage,
    payments,
    authn,
    authz,
    idempotency,
    clock,
    logger,
    placeLayoutParser,
    placeLayoutStreaming,
    searchQuery,
    searchPrompts,
    multiSearch,
    geo,
    notify,
    rateLimit,
    eventUnlockSecret,
    // Optional ports — absent (undefined-ish) unless a test opts in, so
    // "not configured" guard paths stay testable.
    mailer: hasOwn(overrides, "mailer") ? (overrides!.mailer ?? null) : null,
    membershipBilling: hasOwn(overrides, "membershipBilling")
      ? (overrides!.membershipBilling ?? null)
      : null,
    taxRateLookup: hasOwn(overrides, "taxRateLookup")
      ? (overrides!.taxRateLookup ?? null)
      : null,
    // lat/lng → IANA zone. Absent by default so the "no port wired" degraded
    // answer (`{ timezone: null }`) stays testable; a test that wants a real
    // answer opts in with its own stub.
    timezoneLookup: hasOwn(overrides, "timezoneLookup")
      ? (overrides!.timezoneLookup ?? null)
      : null,
    notifyWithEmail: hasOwn(overrides, "notifyWithEmail")
      ? (overrides!.notifyWithEmail ?? null)
      : null,
    push: hasOwn(overrides, "push") ? (overrides!.push ?? null) : null,
    // Bot check. Absent by default ("not configured"); a test that exercises a
    // challenge opts in with its own `{ enabled, verify }` stub.
    turnstile: hasOwn(overrides, "turnstile")
      ? (overrides!.turnstile ?? null)
      : null,
    // Volunteer scan-token signer. Absent by default so the routers'
    // "not configured" PRECONDITION_FAILED guards stay testable; a test that
    // wants the mint/resolve path opts in with its own stub port.
    volunteerScanToken: hasOwn(overrides, "volunteerScanToken")
      ? (overrides!.volunteerScanToken ?? null)
      : null,
    publicAppUrl: hasOwn(overrides, "publicAppUrl")
      ? (overrides!.publicAppUrl ?? null)
      : null,
    auth: hasOwn(overrides, "auth")
      ? (overrides!.auth ?? null)
      : { userId: "user-1", sessionId: null, token: "token" },
    authToken: hasOwn(overrides, "authToken")
      ? (overrides!.authToken ?? null)
      : "token",
    apiKey: hasOwn(overrides, "apiKey") ? (overrides!.apiKey ?? null) : null,
    keyScope: overrides?.keyScope ?? null,
    keySelfRenewal: overrides?.keySelfRenewal ?? null,
    actorHumanId: hasOwn(overrides, "actorHumanId")
      ? (overrides!.actorHumanId ?? null)
      : "11111111-1111-4111-8111-111111111111",
    viewerLocation: hasOwn(overrides, "viewerLocation")
      ? (overrides!.viewerLocation ?? null)
      : null,
    clientIp: hasOwn(overrides, "clientIp")
      ? (overrides!.clientIp ?? null)
      : "203.0.113.44",
    userAgent: hasOwn(overrides, "userAgent")
      ? (overrides!.userAgent ?? null)
      : "vitest",
    cookieHeader: hasOwn(overrides, "cookieHeader")
      ? (overrides!.cookieHeader ?? null)
      : null,
    // Optional best-effort error reporter — absent unless a test opts in, so
    // "not wired" fallback paths (fail-open reporting) stay testable.
    reportError: hasOwn(overrides, "reportError")
      ? overrides!.reportError
      : undefined,
    // Machine translation port — absent unless a test opts in (unwired = no
    // suggestions).
    translator: hasOwn(overrides, "translator")
      ? (overrides!.translator ?? null)
      : null,
    // Env-driven feature-gate flags — absent (undefined) unless a test opts
    // in, so default-off gates (e.g. `resale`) stay testable in both states.
    enableResale: hasOwn(overrides, "enableResale")
      ? overrides!.enableResale
      : undefined,
    enableEntityPageEditor: hasOwn(overrides, "enableEntityPageEditor")
      ? overrides!.enableEntityPageEditor
      : undefined,
    enableHumanProfilesPublic: hasOwn(overrides, "enableHumanProfilesPublic")
      ? overrides!.enableHumanProfilesPublic
      : undefined,
    enableWaitlists: hasOwn(overrides, "enableWaitlists")
      ? overrides!.enableWaitlists
      : undefined,
  } satisfies AnyCtx;
};

type RouterOptions = Parameters<typeof router>[0];

export const createCaller = (
  routerDef: RouterOptions,
  overrides?: Partial<AnyCtx>,
) => {
  const ctx = buildBaseCtx(overrides);
  // NOTE: `routerDef` is already the full router definition. Spreading it can mangle
  // nested router objects (and makes it easy to accidentally test a different contract
  // than production).
  const testRouter = router(routerDef);
  const caller = testRouter.createCaller(ctx);
  return { caller: caller as any, ctx };
};

/** Input of `AuthZPort.hasStaffRole`, as far as the fakes below read it. */
type StaffProbeInput = {
  actorHumanId: string;
  requiredRoles: readonly string[];
  allowWithoutSecondFactor?: boolean;
};

/**
 * The roles `requireStaffSecondFactor` (guard.ts) asks the port about, with
 * the default probe, before a gated procedure runs. A test that pins a path
 * onto the middleware's list expects exactly this call.
 */
export const MIDDLEWARE_STAFF_PROBE = (actorHumanId: string) => ({
  actorHumanId,
  requiredRoles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER", "COMMUNITY_MODERATOR"],
});

/**
 * What `AuthZPort.hasStaffRole` answers for an actor who holds `held` and has
 * (or has not) enrolled a second factor. A holder with none is refused with
 * `secondFactorRequired`, unless the caller passes `allowWithoutSecondFactor`.
 * Mirrors `createDbAuthZAdapter` in `@th/adapters`.
 */
export const staffProbeAnswer = (
  actor: { held: readonly string[]; enrolled: boolean },
  input: Pick<StaffProbeInput, "requiredRoles" | "allowWithoutSecondFactor">,
): { allowed: boolean; secondFactorRequired?: true } => {
  if (!input.requiredRoles.some((role) => actor.held.includes(role))) {
    return { allowed: false };
  }
  if (input.allowWithoutSecondFactor || actor.enrolled) {
    return { allowed: true };
  }
  return { allowed: false, secondFactorRequired: true };
};

/** A `hasStaffRole` fake for one actor that answers as the port does. */
export const portHasStaffRole = (actor: {
  held: readonly string[];
  enrolled: boolean;
}) => vi.fn(async (input: StaffProbeInput) => staffProbeAnswer(actor, input));
