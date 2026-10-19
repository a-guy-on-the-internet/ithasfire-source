import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  confirmVenueEvent,
  confirmVenueEventByEventInputSchema,
  confirmVenueEventByRequestInputSchema,
  confirmVenueEventWireOutputSchema,
  withdrawVenueConfirmation,
  withdrawVenueConfirmationInputSchema,
  withdrawVenueConfirmationWireOutputSchema,
} from "@th/core/use-cases/events";

import { makeEventHoldIntentsNotifier } from "../booking-hold-notifier";
import { authedProcedure } from "../init";
import { toTrpcError } from "../utils";
import { makeVenueConfirmationIntentsNotifier } from "../venue-confirmation-notifier";

// ─────────────────────────────────────────────────────────────────────────────
// venueConfirmation.* (venue-confirmation-and-booking-intents spec,
// docs/specs/2026-08-27 "Confirmation lives on the Event", transport).
//
// Thin per the transport rule: the authority gate (place owner / org
// edit-role; never a booking grantee), the request-place
// match, idempotency and the ledger all live in the use cases. This layer
// does exactly three things:
//   1. injects `actorHumanId` from ctx (omitted from every client input);
//   2. fires the notification INTENTS post-commit through two swallowed hooks
//      (`makeVenueConfirmationIntentsNotifier` for the owner's "confirmed"
//      notice; `makeEventHoldIntentsNotifier` for the booking-hold intents a
//      confirmation owes when it TOOK THE LINE, exactly as
//      `events.publishEvent` does — a notify outage never fails a committed
//      confirmation);
//   3. strips every intent + the routing hint from the wire — the
//      `.output()` schemas are core's `*WireOutputSchema`s, which `.omit()`
//      them.
//
// `confirm` accepts core's two input shapes (by event, or by booking request
// with an optional `ownerOverride`), each minus the ctx-injected actor.
// ─────────────────────────────────────────────────────────────────────────────

const confirmInput = z.union([
  confirmVenueEventByEventInputSchema.omit({ actorHumanId: true }),
  confirmVenueEventByRequestInputSchema.omit({ actorHumanId: true }),
]);
const withdrawInput = withdrawVenueConfirmationInputSchema.omit({
  actorHumanId: true,
});

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

export const venueConfirmationRouter = {
  /**
   * Venue side: vouch for THIS event at THIS place — by event id (the
   * request an optional link), or by an EVENT-FIRST booking request (its
   * origin event; any other request is refused
   * VENUE_CONFIRMATION_NOT_FOR_REQUESTS, booking-the-night FR-011). Stamps the confirmation (clearing any
   * withdrawal), takes the line when the event is already published on a
   * calendar, and links the request. Idempotent on an already-confirmed
   * event (`alreadyConfirmed: true`, no write, no notification).
   */
  confirm: authedProcedure
    .input(confirmInput)
    .output(confirmVenueEventWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeVenueConfirmationIntentsNotifier(ctx);
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof confirmVenueEvent>[0];

      let result;
      try {
        result = await confirmVenueEvent(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({ output: result, eventId: result.event.eventId });
      await notifyHoldIntents({
        output: {
          holdNotificationIntents: result.holdNotificationIntents,
          staffRecipientHint: result.staffRecipientHint,
        },
        actorHumanId,
      });
      return confirmVenueEventWireOutputSchema.parse(result);
    }),

  /**
   * Venue side: take the vouch back with a reason. The event keeps its
   * `placeId`, drops to address-only and stops blocking; the owner is told
   * the reason. Also valid on a never-confirmed event ("not mine"). Refused
   * on a venue-owned event (confirmed by construction → CONFLICT).
   * Idempotent on the same reason (`alreadyWithdrawn: true`).
   */
  withdraw: authedProcedure
    .input(withdrawInput)
    .output(withdrawVenueConfirmationWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyIntents = makeVenueConfirmationIntentsNotifier(ctx);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof withdrawVenueConfirmation>[0];

      let result;
      try {
        result = await withdrawVenueConfirmation(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyIntents({ output: result, eventId: input.eventId });
      return withdrawVenueConfirmationWireOutputSchema.parse(result);
    }),
};

export type VenueConfirmationRouter = typeof venueConfirmationRouter;
