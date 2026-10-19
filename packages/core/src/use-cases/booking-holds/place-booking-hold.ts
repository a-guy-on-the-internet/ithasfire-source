import { z } from "zod";

import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
} from "./_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  failInvalidField,
  isoCalendarDateSchema,
  staffRecipientHintFor,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import { rethrowHoldLineConflict } from "./_shared/hold-line";
import {
  checkHoldDate,
  isHoldExistsConflict,
  placeHoldOnLine,
  resolveHoldPlacementContext,
} from "./_shared/place-hold-on-line";

// ─────────────────────────────────────────────────────────────────────────────
// placeBookingHold (FR-002): staff put a request at the END of the line for a
// calendar+date. Position is `line.length + 1` from ONE ordered read inside
// the tx (after settling lapses on that line), never arithmetic elsewhere.
//
// The resolve/gate and the in-tx line body both live in
// `_shared/place-hold-on-line.ts`, shared verbatim with `placeBookingHolds`
// (the batch entry point) — a divergence between the two would be a
// correctness bug on the line, not a cosmetic one.
//
// NO `spaceId`: the calendar owns the room. The line's two SQL partial
// uniques are keyed on (calendarId, date) and (bookingRequestId, calendarId,
// date) — a space never entered either, so a hold never reserved one. The
// room is chosen later, at confirm, on the draft event.
// ─────────────────────────────────────────────────────────────────────────────

export const placeBookingHoldInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    calendarId: z.uuid(),
    /** ISO `YYYY-MM-DD`, place-local (from preferredDates or typed). */
    date: isoCalendarDateSchema,
  })
  .strict();

export const placeBookingHoldOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const placeBookingHoldWireOutputSchema = z.object(
  placeBookingHoldOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type PlaceBookingHoldInput = z.infer<typeof placeBookingHoldInputSchema>;
export type PlaceBookingHoldOutput = z.infer<
  typeof placeBookingHoldOutputSchema
>;
export type PlaceBookingHoldWireOutput = z.infer<
  typeof placeBookingHoldWireOutputSchema
>;
export type PlaceBookingHoldDeps = BookingHoldDeps;

export async function placeBookingHold(
  deps: PlaceBookingHoldDeps,
  rawInput: unknown,
): Promise<PlaceBookingHoldOutput> {
  const input = parseInput(placeBookingHoldInputSchema, rawInput);
  const now = deps.clock.now();

  const { request, place, ownership, placeTz, calendarId } =
    await resolveHoldPlacementContext(deps.repos, {
      bookingRequestId: input.bookingRequestId,
      calendarId: input.calendarId,
      actorHumanId: input.actorHumanId,
      now,
    });

  const dateIssue = checkHoldDate(input.date, now, placeTz);
  if (dateIssue) {
    failInvalidField("date", dateIssue);
  }

  let outcome: {
    hold: Awaited<ReturnType<typeof deps.repos.bookingHolds.create>>;
    intents: BookingHoldNotificationIntent[];
  };
  try {
    outcome = await deps.repos.tx(async (tx) => {
      const placed = await placeHoldOnLine(tx, {
        request,
        calendarId,
        date: input.date,
        now,
        placeTz,
        actorHumanId: input.actorHumanId,
      });
      placed.intents.push({
        kind: "hold.placed",
        bookingRequestId: request.id,
        holdId: placed.hold.id,
        audience: "act",
        date: placed.hold.date,
        position: placed.hold.position,
      });
      return placed;
    });
  } catch (error) {
    // The (request, calendar, date) unique on LIVE rows: this request is
    // already in this line. A released date can be re-held with a fresh row.
    if (isHoldExistsConflict(error)) {
      throw fail("HOLD_ALREADY_PLACED", {
        meta: {
          bookingRequestId: request.id,
          calendarId,
          date: input.date,
        },
      });
    }
    // A deadlock/serialization failure the adapter folded into line_changed.
    rethrowHoldLineConflict(error, { calendarId, date: input.date });
  }

  deps.logger?.info("booking_holds.placed", {
    holdId: outcome.hold.id,
    bookingRequestId: request.id,
    calendarId,
    date: input.date,
    position: outcome.hold.position,
    actorHumanId: input.actorHumanId,
  });

  return placeBookingHoldOutputSchema.parse({
    hold: toBookingHoldOutput(outcome.hold, now, placeTz),
    notificationIntents: outcome.intents,
    staffRecipientHint: staffRecipientHintFor({
      hold: outcome.hold,
      request,
      place,
      ownership,
    }),
  });
}
