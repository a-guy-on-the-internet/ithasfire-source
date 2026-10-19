import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import {
  appendBookingSystemEntry,
  BOOKING_REASON_MAX,
} from "../booking-requests/messages/_shared/system-entries";
import { mapEventMoved } from "./confirm-venue-event";
import {
  loadVenueConfirmationContext,
  toVenueConfirmationEventOutput,
  venueConfirmationEventSchema,
  venueConfirmationRecipientFor,
} from "./_shared/venue-confirmation-context";
import {
  venueConfirmationNotificationIntentSchema,
  type VenueConfirmationNotificationIntent,
} from "./_shared/venue-confirmation-intents";
import { markForSearchReindex } from "../search/search-reindex-marks";

// ─────────────────────────────────────────────────────────────────────────────
// withdrawVenueConfirmation — the venue takes its vouch back, with a reason
// (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27
// "Withdrawal").
//
// Same authority as confirm (the staff gate; never a grantee). Sets the withdrawn pair;
// `venueConfirmedAt` stays as history; the event KEEPS `placeId` (the
// organizer's intent and our data are preserved) and drops to address-only,
// stops blocking, and its owner is told the reason and may edit.
//
// VALID ON A NEVER-CONFIRMED EVENT: withdrawing what was never stamped
// records a DECLINE ("not mine") so the venue calendar stops re-prompting
// for it — the adapter lands the withdrawn pair with `venueConfirmedAt`
// still null, and every reader derives "not confirmed" the same way.
//
// REFUSED ON A VENUE-OWNED EVENT: it is confirmed by construction, so a
// withdrawal would be recorded and change nothing a reader sees — a lie in
// the ledger. `INVALID_STATUS: venue_owned_event`.
//
// IDEMPOTENT: already withdrawn with the SAME reason → `alreadyWithdrawn:
// true`, nothing appended, no intent. A NEW reason overwrites (the adapter
// re-stamps `withdrawnAt`) and is announced again.
//
// Any rental payment is untouched — refund is its own managed flow.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One reason cap for every booking reason field (booking-the-night FR-013):
 * 1000, the booking thread's own bound. An alias, not a second number.
 */
export const WITHDRAW_REASON_MAX = BOOKING_REASON_MAX;

export const withdrawVenueConfirmationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    /** The venue's own words — sanitized BEFORE the length bounds apply. */
    reason: plainTextMultilineRequired(WITHDRAW_REASON_MAX),
  })
  .strict();

export const withdrawVenueConfirmationOutputSchema = z
  .object({
    event: venueConfirmationEventSchema,
    /** True = no write happened; already withdrawn with this exact reason. */
    alreadyWithdrawn: z.boolean(),
    /** Owed post-commit; stripped from the wire (see the wire schema). */
    notificationIntents: z.array(venueConfirmationNotificationIntentSchema),
  })
  .strict();

/** What transport puts on the wire: the intents stay server-side. */
export const withdrawVenueConfirmationWireOutputSchema = z.object(
  withdrawVenueConfirmationOutputSchema.omit({ notificationIntents: true })
    .shape,
);

export type WithdrawVenueConfirmationInput = z.infer<
  typeof withdrawVenueConfirmationInputSchema
>;
export type WithdrawVenueConfirmationOutput = z.infer<
  typeof withdrawVenueConfirmationOutputSchema
>;
export type WithdrawVenueConfirmationWireOutput = z.infer<
  typeof withdrawVenueConfirmationWireOutputSchema
>;

export type WithdrawVenueConfirmationDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function withdrawVenueConfirmation(
  deps: WithdrawVenueConfirmationDeps,
  rawInput: unknown,
): Promise<WithdrawVenueConfirmationOutput> {
  const input = parseInput(withdrawVenueConfirmationInputSchema, rawInput);
  const now = deps.clock.now();
  const logger = deps.logger?.child({ useCase: "withdrawVenueConfirmation" });

  const { event, place, authority, venueOwned } =
    await loadVenueConfirmationContext(deps.repos, {
      eventId: input.eventId,
      actorHumanId: input.actorHumanId,
    });

  if (venueOwned) {
    // Spec `precondition_failed: venue_owned_event` — see the module header
    // and `event_has_no_place` in the shared loader for the code choice.
    throw fail("INVALID_STATUS", {
      message: "venue_owned_event",
      meta: { eventId: event.id, placeId: place.id },
    });
  }

  if (
    (event.venueConfirmationWithdrawnAt ?? null) !== null &&
    event.venueConfirmationWithdrawnReason === input.reason
  ) {
    logger?.info("events.venue_confirmation.already_withdrawn", {
      eventId: event.id,
      placeId: place.id,
      actorHumanId: input.actorHumanId,
    });
    return withdrawVenueConfirmationOutputSchema.parse({
      event: toVenueConfirmationEventOutput(event, place),
      alreadyWithdrawn: true,
      notificationIntents: [],
    });
  }

  const wasStamped = (event.venueConfirmedAt ?? null) !== null;
  const linkedRequestId = event.venueConfirmationRequestId ?? null;

  const outcome = await deps.repos.tx(async (tx) => {
    // Re-read INSIDE the tx: the short-circuit above is a pre-tx read, and
    // two concurrent withdrawals with the same reason would otherwise both
    // append the ledger entry and the audit row.
    const fresh = await tx.events.getById(event.id);
    if (!fresh) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (
      (fresh.venueConfirmationWithdrawnAt ?? null) !== null &&
      fresh.venueConfirmationWithdrawnReason === input.reason
    ) {
      return { already: true as const, event: fresh };
    }
    // Same CAS as confirm: the withdrawal is the AUTHORIZED place taking its
    // word back, never another venue's.
    let withdrawn;
    try {
      withdrawn = await tx.events.withdrawVenueConfirmation({
        eventId: event.id,
        placeId: place.id,
        reason: input.reason,
        at: now,
      });
    } catch (err) {
      throw mapEventMoved(err, event.id, place.id);
    }
    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "event.place_confirmation_withdrawn",
      data: {
        actorHumanId: input.actorHumanId,
        placeId: place.id,
        bookingRequestId: linkedRequestId,
        via: authority.via,
        reason: input.reason,
        // A withdrawal of a never-stamped event is a decline ("not mine").
        declined: !wasStamped,
      },
      at: now,
    });
    if (linkedRequestId) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: linkedRequestId,
        kind: "booking_event.place_confirmation_withdrawn",
        data: { eventId: event.id, reason: input.reason },
        actorHumanId: input.actorHumanId,
      });
    }
    // The event document stops naming the venue.
    if (withdrawn.status === "PUBLISHED") {
      await markForSearchReindex(tx, [{ kind: "event", id: event.id }], now);
    }
    return { already: false as const, event: withdrawn };
  });

  if (outcome.already) {
    logger?.info("events.venue_confirmation.already_withdrawn", {
      eventId: event.id,
      placeId: place.id,
      actorHumanId: input.actorHumanId,
      raced: true,
    });
    return withdrawVenueConfirmationOutputSchema.parse({
      event: toVenueConfirmationEventOutput(outcome.event, place),
      alreadyWithdrawn: true,
      notificationIntents: [],
    });
  }
  const updated = outcome.event;

  const intents: VenueConfirmationNotificationIntent[] = [];
  const recipient = venueConfirmationRecipientFor(event);
  if (recipient) {
    intents.push({
      kind: "event.place_confirmation_withdrawn",
      eventId: event.id,
      placeId: place.id,
      bookingRequestId: linkedRequestId,
      recipient,
      at: updated.venueConfirmationWithdrawnAt ?? now,
      reason: input.reason,
    });
  }

  logger?.info("events.venue_confirmation.withdrawn", {
    eventId: event.id,
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    via: authority.via,
    bookingRequestId: linkedRequestId,
    declined: !wasStamped,
    intentCount: intents.length,
  });

  return withdrawVenueConfirmationOutputSchema.parse({
    event: toVenueConfirmationEventOutput(updated, place),
    alreadyWithdrawn: false,
    notificationIntents: intents,
  });
}
