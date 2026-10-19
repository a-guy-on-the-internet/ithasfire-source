import { z } from "zod";

import type { PlaceBookingHoldRecord } from "@th/ports/repos/booking-holds";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import {
  actorActsForParty,
  findPlaceBookingAuthority,
} from "../booking-requests/_shared/place-access";
import type { BookingHoldNotificationIntent } from "./_shared/booking-hold-intents";
import { bookingHoldNotificationIntentSchema } from "./_shared/booking-hold-intents";
import {
  actBookingHoldOutputSchema,
  requireHold,
  requirePlace,
  toActBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import {
  requestlessHoldNotificationIntentSchema,
  type RequestlessHoldNotificationIntent,
} from "./_shared/requestless-hold-intents";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// passNamedHold (holds-without-a-request FR-007, H7): the party a place hold
// names takes its name off. The holder columns clear; the hold keeps its
// position and status and stays the place's, unassigned; staff are told
// (in-app); an audit row is its history (H20).
//
// WHO: the named person, one of their edit-role delegates, or an edit-role
// member of the named org (`actorActsForParty`, the H2 rule). Anyone else,
// and any hold that is not a live PLACE hold naming someone the actor acts
// for, reads BOOKING_HOLD_NOT_FOUND — the same answer as a missing id, so
// the call is no oracle for which holds exist or whom they name.
//
// UNDER THE LINE LOCK: the line is settled first (a lapsed hold is not
// passed, it is gone), then the CAS clears the holder only while the row is
// still a live PLACE hold naming THAT party. Losing it to another pass (a
// double tap, a second editor of the org) is the idempotent outcome:
// `alreadyPassed: true`, nothing written, nobody told again.
// ─────────────────────────────────────────────────────────────────────────────

export const passNamedHoldInputSchema = z
  .object({ actorHumanId: z.uuid(), holdId: z.uuid() })
  .strict();

export const passNamedHoldOutputSchema = z
  .object({
    /** The named party's view of the hold (its own position only). */
    hold: actBookingHoldOutputSchema,
    /** True = it was already passed; nothing was written. */
    alreadyPassed: z.boolean(),
    // ── server-side only (stripped by the wire schema) ──
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    requestlessIntents: z.array(requestlessHoldNotificationIntentSchema),
  })
  .strict();

export const passNamedHoldWireOutputSchema = z.object(
  passNamedHoldOutputSchema.omit({
    notificationIntents: true,
    requestlessIntents: true,
  }).shape,
);

export type PassNamedHoldInput = z.infer<typeof passNamedHoldInputSchema>;
export type PassNamedHoldOutput = z.infer<typeof passNamedHoldOutputSchema>;
export type PassNamedHoldDeps = BookingHoldDeps;

export async function passNamedHold(
  deps: PassNamedHoldDeps,
  rawInput: unknown,
): Promise<PassNamedHoldOutput> {
  const input = parseInput(passNamedHoldInputSchema, rawInput);
  const now = deps.clock.now();
  const { repos } = deps;

  // The gate before anything else is read: a hold that names nobody the
  // actor acts for reads exactly like a missing one.
  const found = await repos.bookingHolds.getById(input.holdId);
  if (
    !found ||
    found.ownerKind !== "PLACE" ||
    found.holder === null ||
    !(await actorActsForParty(repos, input.actorHumanId, found.holder))
  ) {
    throw fail("BOOKING_HOLD_NOT_FOUND");
  }
  const named = found.holder;
  const calendar = await repos.calendars.findById(found.calendarId);
  if (!calendar) throw fail("BOOKING_HOLD_NOT_FOUND");
  const place = await requirePlace(repos, calendar.placeId);
  const placeTz = resolveBookingTimezone(place.timezone);
  const key = { calendarId: found.calendarId, date: found.date };
  // Who staff notices route to first. A place hold kept on a revoke was
  // placed by the booker: then the place's members, never a former booker.
  // Read before the write (the placer never changes), so nothing after the
  // commit can fail.
  const placerIsStaff =
    (await findPlaceBookingAuthority(repos, place, found.placedByHumanId)) !== null;

  type Outcome = {
    hold: PlaceBookingHoldRecord;
    alreadyPassed: boolean;
    intents: BookingHoldNotificationIntent[];
  };
  const outcome = await repos.tx(async (tx): Promise<Outcome> => {
    const { line, intents } = await settleLine(tx, { ...key, now, placeTz });
    const live = line.find((h) => h.id === found.id);
    if (!live || live.ownerKind !== "PLACE") {
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: found.id } });
    }
    const passed = await tx.bookingHolds.clearPlaceHolder({
      id: found.id,
      holder: named,
    });
    if (!passed) {
      // Lost the CAS: already passed by this party (idempotent), or the
      // hold now names someone else (then it is no longer the actor's).
      const row = await requireHold(tx, found.id);
      if (row.ownerKind === "PLACE" && row.holder === null) {
        return { hold: row, alreadyPassed: true, intents };
      }
      throw fail("BOOKING_HOLD_NOT_FOUND");
    }
    await tx.audit.log({
      entity: "booking_hold",
      entityId: passed.id,
      action: "booking_hold.passed",
      data: {
        actorHumanId: input.actorHumanId,
        ownerKind: "PLACE",
        holder: named,
        placeId: place.id,
        calendarId: passed.calendarId,
        date: passed.date,
        position: passed.position,
      },
      at: now,
    });
    return { hold: passed, alreadyPassed: false, intents };
  });

  const requestlessIntents: RequestlessHoldNotificationIntent[] =
    outcome.alreadyPassed
      ? []
      : [
          {
            kind: "requestless_hold.passed",
            audience: "staff",
            holdId: outcome.hold.id,
            placeId: place.id,
            calendarId: outcome.hold.calendarId,
            date: outcome.hold.date,
            position: outcome.hold.position,
            staffHumanId: placerIsStaff ? outcome.hold.placedByHumanId : null,
          },
        ];

  deps.logger?.info("booking_holds.passed", {
    holdId: outcome.hold.id,
    actorHumanId: input.actorHumanId,
    alreadyPassed: outcome.alreadyPassed,
  });

  return passNamedHoldOutputSchema.parse({
    hold: toActBookingHoldOutput(outcome.hold, now, placeTz),
    alreadyPassed: outcome.alreadyPassed,
    notificationIntents: outcome.intents,
    requestlessIntents,
  });
}
