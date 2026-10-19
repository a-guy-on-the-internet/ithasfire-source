import type { Ctx } from "./context";
import { hasEventUnlockCookie } from "./event-unlock-cookie";

/**
 * True when the request carries no identity at all: no bearer/session token,
 * no API key, no resolved actor, no upstream auth claims.
 *
 * This is the gate for handing a procedure a shared result cache
 * (`ctx.publicDiscoveryCache`). It is deliberately stricter than "the use case
 * does not read the viewer today": a signed-in caller always goes to the
 * database, so a later change that makes a cached read viewer-dependent
 * (saved/hearted flags, member-only events) cannot leak one person's answer to
 * the next — only anonymous answers are ever stored, and only anonymous
 * requests ever read them.
 *
 * An invalid or expired token still counts as NOT anonymous, and so does any
 * gate cookie (`hasEventUnlockCookie`): a password unlock (`th_eu_*`), an
 * application grant (`th_ea_*`) or an invite grant (`th_ei_*`). That caller
 * may see a gated event's details. Both cost a cache miss, never a leak. Other cookies
 * (theme, consent) carry no entitlement and do not count.
 */
export const isAnonymousRequest = (
  ctx: Pick<Ctx, "authToken" | "apiKey" | "actorHumanId" | "auth"> &
    Partial<Pick<Ctx, "cookieHeader">>,
): boolean =>
  !ctx.authToken &&
  !ctx.apiKey &&
  !ctx.actorHumanId &&
  !ctx.auth?.userId &&
  !ctx.auth?.sessionId &&
  !ctx.auth?.token &&
  !hasEventUnlockCookie(ctx.cookieHeader ?? null);

/** The shared discovery cache for this request, or undefined if it must not use one. */
export const publicDiscoveryCacheFor = (
  ctx: Pick<
    Ctx,
    "authToken" | "apiKey" | "actorHumanId" | "auth" | "publicDiscoveryCache"
  > &
    Partial<Pick<Ctx, "cookieHeader">>,
) =>
  ctx.publicDiscoveryCache && isAnonymousRequest(ctx)
    ? ctx.publicDiscoveryCache
    : undefined;
