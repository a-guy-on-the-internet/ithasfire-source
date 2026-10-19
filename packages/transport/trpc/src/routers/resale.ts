import { TRPCError } from "@trpc/server";

import {
  createResaleListing,
  createResaleListingInputSchema,
  createResaleListingOutputSchema,
  estimateResaleListing,
  estimateResaleListingInputSchema,
  estimateResaleListingOutputSchema,
  cancelResaleListing,
  cancelResaleListingInputSchema,
  cancelResaleListingOutputSchema,
  listMyResaleListings,
  listMyResaleListingsInputSchema,
  listMyResaleListingsOutputSchema,
  listEventResaleListings,
  listEventResaleListingsInputSchema,
  listEventResaleListingsOutputSchema,
  getResaleListing,
  getResaleListingInputSchema,
  getResaleListingOutputSchema,
  createResaleCheckout,
  createResaleCheckoutInputSchema,
  createResaleCheckoutOutputSchema,
} from "@th/core/use-cases/resale";

import { getFeatureGates } from "@th/core/use-cases/features";
import { actorHoldsEventEditRole } from "@th/core/lib/event-edit-rights";
import { ORG_ANY_ROLE } from "@th/core/lib/rbac";

import { fullEventReadDenialByEventId } from "../event-read-access";
import { optionalProcedure, verifiedEmailProcedure } from "../init";
import type { Ctx } from "../context";
import { toTrpcError } from "../utils";

/**
 * Server-side enforcement of the `resale` feature gate for the WRITE
 * procedures (create a listing / start a resale checkout). The UI is dark
 * when the gate is off, but these endpoints move money and must not remain
 * callable directly. Mirrors the transport-level gate precedent
 * (`ctx.enableBuyTickets === false` in orders.createCheckout), except the
 * `resale` gate is default-OFF and admin-togglable, so we resolve the full
 * gate (DB override ?? env `ENABLE_RESALE` ?? false) via the same
 * `getFeatureGates` use case the features router serves — fail-closed on a
 * settings-read failure (falls back to env default, off unless explicitly
 * enabled).
 *
 * READ procedures (listEventListings, getListing, listMyListings) and
 * cancelListing (a write, but owner-scoped and strictly exposure-reducing)
 * are deliberately NOT gated, so a seller whose ticket is stuck LISTED after
 * the gate flips off is never API-blocked from exiting. NOTE: while the gate
 * is off there is currently NO UI that reaches these — /sell notFound()s and
 * OrderDetail hides its resell affordances — so the escape hatch is API-only.
 * If the gate is ever enabled in prod and later re-disabled, add a read-only
 * cancel path (e.g. a "Cancel listing" action on LISTED tickets in
 * OrderDetail) before flipping it off.
 *
 * History (2026-09-30): until the seller-credit fix, finalize never credited
 * the resale SELLER — the event's RESALE terms lines split the whole ask, so
 * the organiser was credited the seller's proceeds and the seller got $0 with
 * their original item already `transferred`. The fix
 * (`resolve-resale-seller-split.ts`) writes the seller's snapshot share as
 * their own split. Do not enable this gate on any deploy built before it.
 */
async function ensureResaleEnabled(ctx: Ctx): Promise<void> {
  const gates = await getFeatureGates({
    enableResale: ctx.enableResale,
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  if (!gates.resale) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Resale is currently disabled",
    });
  }
}

/**
 * Read gate for an event's resale listings (owner ruling 2026-10-13: a
 * PASSWORD / APPLICATION event's resale listings are hidden from viewers who
 * haven't been let in).
 *
 * Two passes, in this order:
 *
 *  1. The event's owner, in ANY role, checked FIRST: a member of the owning
 *     org, or the human owner or one of their delegates. The org admin resale
 *     page (`/admin/[slug]/resale`) lists the owner's events to every org role
 *     (`events.listMine`, ORG_ANY_ROLE), while the gate bypass covers only
 *     edit roles. A human owner's VIEWER / FINANCE / SCANNER delegates pass
 *     too, on purpose: a delegate sees what an org member with the same role
 *     sees. It runs before the gate because the gate read answers
 *     EVENT_NOT_FOUND for an event that is not publicly readable (a banned
 *     owner, a draft), which would leave a non-editing member's admin page
 *     failing to load. It reveals nothing to anyone else: a viewer who is not
 *     the owner falls through to step 2 and gets exactly its answer, whether
 *     or not the event exists.
 *  2. The event page's full-read gate (`fullEventReadDenialByEventId`:
 *     bypass, durable unlock, password cookie, application or invite grant),
 *     read once. A refused viewer gets the gate's own refusal
 *     (`event_password_required` / `event_application_required`).
 *
 * Holding a ticket is NOT being let in: a buyer who got a ticket through
 * resale and never unlocked fails this, as on the event page.
 */
async function ensureEventResaleListingsReadAccess(
  ctx: Ctx,
  eventId: string,
): Promise<void> {
  if (ctx.actorHumanId) {
    const event = await ctx.repos.events.getById(eventId);
    if (
      event &&
      (await actorHoldsEventEditRole(
        ctx.repos.authz,
        event,
        ctx.actorHumanId,
        ORG_ANY_ROLE,
      ))
    ) {
      return;
    }
  }
  const denial = await fullEventReadDenialByEventId(ctx, eventId);
  if (denial) throw denial;
}

// ── Omit actorHumanId for authed procedures ────────────────────────────────
const createListingInput = createResaleListingInputSchema.omit({
  actorHumanId: true,
});
const estimateListingInput = estimateResaleListingInputSchema.omit({
  actorHumanId: true,
});
const cancelListingInput = cancelResaleListingInputSchema.omit({
  actorHumanId: true,
});
const listMyInput = listMyResaleListingsInputSchema.omit({
  actorHumanId: true,
});
// The viewer comes from the session, never the client.
const getListingInput = getResaleListingInputSchema.omit({
  viewerHumanId: true,
});
const createCheckoutInput = createResaleCheckoutInputSchema.omit({
  actorHumanId: true,
  // Internal-only server-observed client IP / user agent for acceptance
  // evidence (Order stamps + AcceptanceRecord ledger rows).
  requestIp: true,
  requestUserAgent: true,
});

export const resaleRouter = {
  // ── Seller flow ────────────────────────────────────────────────────────

  createListing: verifiedEmailProcedure
    .input(createListingInput)
    .output(createResaleListingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ensureResaleEnabled(ctx);

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? undefined,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createResaleListing>[0];

      try {
        return await createResaleListing(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The seller form's numbers for one ticket at one asking price: the share
   * to the people who put on the night, what the seller receives, what the
   * buyer pays before processing and tax, the original price, and the
   * highest ask that fits the cap (organiser-resale-share FR-002, FR-008,
   * NFR-002). Priced by the functions `createListing` charges with. Gated
   * with the writes: it exists only to make a listing.
   */
  estimateListing: verifiedEmailProcedure
    .input(estimateListingInput)
    .output(estimateResaleListingOutputSchema)
    .query(async ({ ctx, input }) => {
      await ensureResaleEnabled(ctx);

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      try {
        return await estimateResaleListing(
          { repos: ctx.repos },
          { ...input, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  cancelListing: verifiedEmailProcedure
    .input(cancelListingInput)
    .output(cancelResaleListingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof cancelResaleListing>[0];

      try {
        return await cancelResaleListing(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  listMyListings: verifiedEmailProcedure
    .input(listMyInput)
    .output(listMyResaleListingsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listMyResaleListings>[0];

      try {
        return await listMyResaleListings(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Buyer flow ─────────────────────────────────────────────────────────

  /**
   * An event's ACTIVE resale listings, for the event page section and the
   * owner's admin resale page. Behind the event's gate
   * (`ensureEventResaleListingsReadAccess`). `optionalProcedure`, not
   * `publicProcedure`, so a signed-in viewer's durable unlock and an owner
   * member's role count (a public procedure never resolves the session).
   */
  listEventListings: optionalProcedure
    .input(listEventResaleListingsInputSchema)
    .output(listEventResaleListingsOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listEventResaleListings>[0];

      try {
        await ensureEventResaleListingsReadAccess(ctx, input.eventId);
        return await listEventResaleListings(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * One listing by id: the direct listing link (/events/resale/[listingId])
   * a holder shares to pass a ticket on. The event's PASSWORD / APPLICATION
   * gate is DELIBERATELY NOT applied, owner ruling 2026-10-13 ("Link works";
   * "A resale ticket pass should pass from holder to holder"): whoever has
   * the link may read an on-sale listing, let in or not, and `createCheckout`
   * below takes no gate check either. Do not add the event gate here;
   * `listEventListings` is the gated read.
   *
   * What the use case does enforce (`getResaleListing`): to anyone but the
   * seller, only ACTIVE / HELD listings (SOLD to its buyer) of an event that
   * exists and is not a draft, cancelled or RSVP-only (a banned owner's event
   * included, as checkout sells it), without the seller's or ticket's id.
   * `optionalProcedure` so the seller and the buyer are recognised.
   */
  getListing: optionalProcedure
    .input(getListingInput)
    .output(getResaleListingOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getResaleListing>[0];

      try {
        return await getResaleListing(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  createCheckout: verifiedEmailProcedure
    .input(createCheckoutInput)
    .output(createResaleCheckoutOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ensureResaleEnabled(ctx);

      if (ctx.enableBuyTickets === false) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Ticket purchasing is currently disabled",
        });
      }

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Last-chance admission-tax lookup when the event was never stamped at
        // publish time. Self-heals the event; non-blocking.
        taxRateLookup: ctx.taxRateLookup ?? null,
        // The tax resolver's deliberate swallows report through this. Without
        // it they are invisible — and one of them decides what the buyer pays.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createResaleCheckout>[0];

      try {
        return await createResaleCheckout(deps, {
          ...input,
          actorHumanId,
          requestIp: ctx.clientIp,
          requestUserAgent: ctx.userAgent,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

export type ResaleRouter = typeof resaleRouter;
