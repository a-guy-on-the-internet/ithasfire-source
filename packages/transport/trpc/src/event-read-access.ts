import { getEventGateState } from "@th/core/use-cases/events";

import type { Ctx } from "./context";
import {
  readEventApplicationGrantCookie,
  readEventInviteGrantCookie,
  verifyEventUnlockCookie,
} from "./event-unlock-cookie";

/**
 * Full-read gate for public event payloads (extracted from routers/events.ts
 * so every public read surface — SEO/body/ticket-type reads AND the
 * suggestion propose-mode hydration — enforces the SAME password/application
 * gate). Gate-failing viewers get the sibling procedures' exact collapse:
 * `{ code: "forbidden", message: "event_password_required" |
 * "event_application_required" }`.
 *
 * Anonymous grants, one per gate type and never crossed:
 *  - PASSWORD: the signed `th_eu_<eventId>` cookie (signature + expiry only —
 *    a password unlock has nothing server-side to revoke).
 *  - APPLICATION: the signed `th_ea_<eventId>` grant. Its signature is checked
 *    here; its `{ submissionId, approvedAtMs }` goes to core, which requires
 *    that submission to belong to this event and still be APPROVED under the
 *    same approval (`viewerHasApplicationGrant`).
 *    A password cookie never satisfies an APPLICATION gate and the grant never
 *    satisfies a PASSWORD gate.
 *  - EITHER gate: the signed `th_ei_<eventId>` invite grant (gated-event
 *    invite links). Its signature is checked here; its `{ inviteId, expMs }`
 *    goes to core, which requires the invite to belong to this event, the
 *    event to be gated, live and not over, and a PERSONAL invite to be
 *    unrevoked (`viewerHasInviteGrant`, `invites/invite-grant.ts`).
 */
export async function ensureFullEventReadAccessByEventId(
  ctx: Ctx,
  eventId: string,
): Promise<void> {
  const denial = await fullEventReadDenialByEventId(ctx, eventId);
  if (denial) throw denial;
}

/**
 * Non-throwing form of {@link ensureFullEventReadAccessByEventId}: the SAME
 * decision (one implementation, `fullEventReadDenialByEventId`), answered as a
 * boolean. `false` means only "this viewer fails the gate". Everything else
 * the gate read can raise (EVENT_NOT_FOUND for an event the viewer may not
 * read at all, a repo failure) still throws, so a caller can never mistake a
 * failed read for a denial.
 *
 * For a read that has a truthful empty answer to give a gate-failing viewer.
 * A caller that returns event data must keep using `ensure*`.
 */
export async function hasFullEventReadAccessByEventId(
  ctx: Ctx,
  eventId: string,
): Promise<boolean> {
  return (await fullEventReadDenialByEventId(ctx, eventId)) === null;
}

export type FullEventReadDenial = {
  readonly code: "forbidden";
  readonly message: "event_password_required" | "event_application_required";
};

/**
 * The one full-read gate decision: `null` when the viewer may read, otherwise
 * the exact error value `ensureFullEventReadAccessByEventId` throws.
 * Exported for a caller that adds its own pass ahead of the gate and throws
 * the denial itself (`resale.listEventListings`), so the gate is read once.
 */
export async function fullEventReadDenialByEventId(
  ctx: Ctx,
  eventId: string,
): Promise<FullEventReadDenial | null> {
  const gateState = await getEventGateState(
    {
      repos: ctx.repos,
      authz: ctx.authz,
      clock: ctx.clock,
      logger: ctx.logger,
      reportError: ctx.reportError ?? undefined,
    },
    {
      eventId,
      viewerHumanId: ctx.actorHumanId ?? null,
      applicationGrant: readEventApplicationGrantCookie(ctx, eventId),
      inviteGrant: readEventInviteGrantCookie(ctx, eventId),
    },
  );

  if (
    gateState.gateType === "NONE" ||
    gateState.viewerCanBypass ||
    gateState.viewerIsUnlocked ||
    gateState.viewerHasApplicationGrant ||
    gateState.viewerHasInviteGrant ||
    (gateState.gateType === "PASSWORD" && verifyEventUnlockCookie(ctx, eventId))
  ) {
    return null;
  }

  return {
    code: "forbidden",
    message:
      gateState.gateType === "PASSWORD"
        ? "event_password_required"
        : "event_application_required",
  } as const;
}

/**
 * Slug variant. An unresolvable or redirecting slug returns without a gate
 * check — callers that go on to READ via the same slug reject redirects
 * themselves (e.g. getEventSeo throws EVENT_SLUG_REDIRECT). Callers that
 * FOLLOW redirects must resolve the slug first and use
 * {@link ensureFullEventReadAccessByEventId} instead, or the redirect
 * early-return becomes a gate bypass.
 */
export async function ensureFullEventReadAccessBySlug(
  ctx: Ctx,
  slug: string,
): Promise<void> {
  const resolution = await ctx.repos.events.resolveBySlug(slug);
  if (!resolution || resolution.redirect) return;
  await ensureFullEventReadAccessByEventId(ctx, resolution.eventId);
}
