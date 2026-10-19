import { z } from "zod";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
} from "./_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  failInvalidField,
  loadStaffHoldContext,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import { casHoldRespondBy } from "./_shared/hold-line";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// extendBookingHoldChallenge (FR-005): push respondBy LATER while the hold is
// still CHALLENGED and the current deadline has not passed. A deadline that
// already lapsed is settled first (→ RELEASED/EXPIRED) and reported as
// BOOKING_HOLD_CHALLENGE_LAPSED. Idempotent on the same respondBy.
// ─────────────────────────────────────────────────────────────────────────────

export const extendBookingHoldChallengeInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    holdId: z.uuid(),
    respondBy: z.coerce.date(),
  })
  .strict();

export const extendBookingHoldChallengeOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const extendBookingHoldChallengeWireOutputSchema = z.object(
  extendBookingHoldChallengeOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type ExtendBookingHoldChallengeInput = z.infer<
  typeof extendBookingHoldChallengeInputSchema
>;
export type ExtendBookingHoldChallengeOutput = z.infer<
  typeof extendBookingHoldChallengeOutputSchema
>;
export type ExtendBookingHoldChallengeWireOutput = z.infer<
  typeof extendBookingHoldChallengeWireOutputSchema
>;
export type ExtendBookingHoldChallengeDeps = BookingHoldDeps;

export async function extendBookingHoldChallenge(
  deps: ExtendBookingHoldChallengeDeps,
  rawInput: unknown,
): Promise<ExtendBookingHoldChallengeOutput> {
  const input = parseInput(extendBookingHoldChallengeInputSchema, rawInput);
  const now = deps.clock.now();
  const ctx = await loadStaffHoldContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
  );
  const key = { calendarId: ctx.hold.calendarId, date: ctx.hold.date };

  const outcome = await deps.repos.tx(async (tx) => {
    const { line, intents } = await settleLine(tx, {
      ...key,
      now,
      placeTz: ctx.placeTz,
    });

    const fresh = line.find((h) => h.id === ctx.hold.id);
    if (!fresh) {
      const row = await tx.bookingHolds.getById(ctx.hold.id);
      if (row?.status === "RELEASED" && row.releasedReason === "EXPIRED") {
        throw fail("BOOKING_HOLD_CHALLENGE_LAPSED", {
          meta: { holdId: row.id },
        });
      }
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
    }
    if (fresh.status !== "CHALLENGED" || !fresh.respondBy) {
      throw fail("BOOKING_HOLD_NOT_CHALLENGED", { meta: { holdId: fresh.id } });
    }
    if (input.respondBy.getTime() === fresh.respondBy.getTime()) {
      return { hold: fresh, intents };
    }
    if (input.respondBy.getTime() < fresh.respondBy.getTime()) {
      failInvalidField("respondBy", "respond_by_not_later");
    }

    const extended = await casHoldRespondBy(tx, {
      id: fresh.id,
      respondBy: input.respondBy,
      expectedStatus: "CHALLENGED",
    });

    // Any owner kind (holds-without-a-request FR-006: extend is staff-only
    // and works on all three). A request-less hold has no thread and no act:
    // the audit row below is its history (H20).
    const bookingRequestId =
      extended.ownerKind === "REQUEST" ? extended.bookingRequestId : null;
    if (bookingRequestId !== null) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId,
        kind: "booking_hold.extended",
        data: { holdId: extended.id, respondBy: input.respondBy.toISOString() },
        actorHumanId: input.actorHumanId,
      });
    }

    await tx.audit.log({
      entity: "booking_hold",
      entityId: extended.id,
      action: "booking_hold.extended",
      data: {
        actorHumanId: input.actorHumanId,
        ownerKind: extended.ownerKind,
        bookingRequestId,
        previousRespondBy: fresh.respondBy,
        respondBy: input.respondBy,
      },
      at: now,
    });

    const owed: BookingHoldNotificationIntent[] =
      bookingRequestId !== null
        ? [
            {
              kind: "hold.challenge_extended",
              bookingRequestId,
              holdId: extended.id,
              audience: "act",
              date: extended.date,
              // Off the row, never a literal (see challenge-booking-hold).
              position: extended.position,
              respondBy: input.respondBy,
            },
          ]
        : [];
    // The act right behind the challenged hold, by line order (a
    // request-less hold there has no act to tell).
    const next = line[line.findIndex((h) => h.id === fresh.id) + 1];
    if (next && next.ownerKind === "REQUEST") {
      owed.push({
        kind: "hold.challenge_extended",
        bookingRequestId: next.bookingRequestId,
        holdId: next.id,
        audience: "act",
        date: next.date,
        position: next.position,
        respondBy: input.respondBy,
      });
    }

    return { hold: extended, intents: [...intents, ...owed] };
  });

  deps.logger?.info("booking_holds.challenge_extended", {
    holdId: outcome.hold.id,
    respondBy: input.respondBy.toISOString(),
    actorHumanId: input.actorHumanId,
  });

  return extendBookingHoldChallengeOutputSchema.parse({
    hold: toBookingHoldOutput(outcome.hold, now, ctx.placeTz),
    notificationIntents: outcome.intents,
    staffRecipientHint: ctx.staffRecipientHint,
  });
}
