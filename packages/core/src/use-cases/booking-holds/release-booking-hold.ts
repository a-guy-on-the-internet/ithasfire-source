import { z } from "zod";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import {
  actorActsForParty,
  listPlaceBookerGrants,
} from "../booking-requests/_shared/place-access";
import { sameGrantee } from "../place-booking-grants/_shared/grant-context";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldStaffRecipientHint,
} from "./_shared/booking-hold-intents";
import {
  bookerBookingHoldOutputSchema,
  bookingHoldOutputSchema,
  holdActorViewSchema,
  loadStaffHoldContext,
  requireHold,
  requireRequestlessHoldPlace,
  staffRecipientHintFor,
  toBookerBookingHoldOutput,
  toBookingHoldOutput,
  type BookingHoldDeps,
} from "./_shared/hold-context";
import {
  requestlessHoldNotificationIntentSchema,
  type RequestlessHoldNotificationIntent,
} from "./_shared/requestless-hold-intents";
import {
  recordMovers,
  releaseHoldCas,
  renumberLine,
} from "./_shared/hold-line";
import { settleLine } from "./_shared/settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// releaseBookingHold: manual release. The line moves up; the released act
// and every mover are notified. Idempotent on an already-RELEASED hold; a
// CONFIRMED hold cannot be released (cancel the event instead).
//
// WHO (holds-without-a-request H11 / FR-007):
//   - STAFF (`loadStaffHoldContext`) release ANY hold, every owner kind;
//   - a BOOKER releases ITS OWN holds: the actor may act for the hold's
//     holder under an active grant covering the hold's calendar
//     (`listPlaceBookerGrants` with `as` = the holder, plan item i). Holder
//     identity is what "own" means; the gate never answers with another
//     party's grant. A booker is refused every other hold by the staff gate
//     (a grantee is not staff, FR-002).
// The booker arm is tried first, so an actor who is both the hold's booker
// and staff releases as the booker (staff are told, not the booker itself).
//
// A request-less hold has no thread and no act: its release writes the audit
// row (H20). FR-013 notices: staff release a booker's hold → the booker
// (`requestless_hold.released`, by staff); a booker releases its own → staff
// (by booker). A place hold released by staff tells nobody (staff did it).
//
// OWN, UNDER THE LOCK: the booker arm's "own" is re-read on the hold row
// under the line lock, after the settle. A revoke that kept the hold as the
// place's (`convertBookerHoldToPlace`, under the same line lock) leaves its
// status alone, so a status CAS alone would let the former booker release a
// hold that is now the place's; the re-read refuses it with the gate's code.
//
// THE REPLY BY WHO ACTED (H17): staff get the staff view of the hold and the
// renumbered line; a booker gets its own hold in the booker view
// (`bookerBookingHoldOutputSchema`: no staff id, no request id) and no line.
// `toReleaseBookingHoldWire` builds the wire shape from `viewer`.
// ─────────────────────────────────────────────────────────────────────────────

export const releaseBookingHoldInputSchema = z
  .object({ actorHumanId: z.uuid(), holdId: z.uuid() })
  .strict();

export const releaseBookingHoldOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    line: z.array(bookingHoldOutputSchema),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    /** FR-013 notices for a request-less hold (server-side only). */
    requestlessIntents: z.array(requestlessHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
    /** Who released: shapes the wire reply (H17). Server-side only. */
    viewer: holdActorViewSchema,
  })
  .strict();

/**
 * What transport puts on the wire: the intents, routing hint and viewer stay
 * server-side. `hold` is the staff view for staff and the booker view for a
 * booker; a booker's `line` is always empty. Build it with
 * {@link toReleaseBookingHoldWire}.
 */
export const releaseBookingHoldWireOutputSchema = z
  .object({
    hold: z.union([bookingHoldOutputSchema, bookerBookingHoldOutputSchema]),
    line: z.array(bookingHoldOutputSchema),
  })
  .strict();

export type ReleaseBookingHoldInput = z.infer<
  typeof releaseBookingHoldInputSchema
>;
export type ReleaseBookingHoldOutput = z.infer<
  typeof releaseBookingHoldOutputSchema
>;
export type ReleaseBookingHoldWireOutput = z.infer<
  typeof releaseBookingHoldWireOutputSchema
>;
export type ReleaseBookingHoldDeps = BookingHoldDeps;

/** The internal output → the wire shape for whoever released (never a spread). */
export function toReleaseBookingHoldWire(
  output: ReleaseBookingHoldOutput,
): ReleaseBookingHoldWireOutput {
  return releaseBookingHoldWireOutputSchema.parse(
    output.viewer === "booker"
      ? { hold: toBookerBookingHoldOutput(output.hold), line: [] }
      : { hold: output.hold, line: output.line },
  );
}

export async function releaseBookingHold(
  deps: ReleaseBookingHoldDeps,
  rawInput: unknown,
): Promise<ReleaseBookingHoldOutput> {
  const input = parseInput(releaseBookingHoldInputSchema, rawInput);
  const now = deps.clock.now();
  const ctx = await loadReleaseContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
    now,
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
      if (row) await requireStillOwn(tx, ctx, row, input.actorHumanId);
      if (row?.status === "RELEASED") {
        return { hold: row, line, released: false, intents };
      }
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
    }
    // The booker arm's "own", on the row read under the line lock.
    await requireStillOwn(tx, ctx, fresh, input.actorHumanId);

    const released = await releaseHoldCas(tx, fresh, { reason: "MANUAL", now });
    if (!released) {
      throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: fresh.id } });
    }

    const bookingRequestId =
      released.ownerKind === "REQUEST" ? released.bookingRequestId : null;
    if (bookingRequestId !== null) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId,
        kind: "booking_hold.released",
        // Only staff reach a REQUEST hold (the booker arm is BOOKER-only).
        data: { holdId: released.id, reason: "MANUAL", by: "staff" },
        actorHumanId: input.actorHumanId,
      });
    }

    const { line: renumbered, moved } = await renumberLine(tx, key);
    // A booker is stamped on no other request's thread (H17).
    const moverIntents = await recordMovers(
      tx,
      moved,
      ctx.by === "booker"
        ? { humanId: input.actorHumanId, kind: "booker" }
        : { humanId: input.actorHumanId, kind: "staff" },
      now,
    );

    await tx.audit.log({
      entity: "booking_hold",
      entityId: released.id,
      action: "booking_hold.released",
      data: {
        actorHumanId: input.actorHumanId,
        ownerKind: released.ownerKind,
        bookingRequestId,
        reason: "MANUAL",
        by: ctx.by,
      },
      at: now,
    });

    return {
      hold: released,
      line: renumbered,
      released: true,
      intents: [
        ...intents,
        ...(bookingRequestId !== null
          ? [
              {
                kind: "hold.released" as const,
                bookingRequestId,
                holdId: released.id,
                audience: "act" as const,
                date: released.date,
                reason: "MANUAL" as const,
              },
            ]
          : []),
        ...moverIntents,
      ],
    };
  });

  deps.logger?.info("booking_holds.released", {
    holdId: outcome.hold.id,
    actorHumanId: input.actorHumanId,
    by: ctx.by,
  });

  return releaseBookingHoldOutputSchema.parse({
    hold: toBookingHoldOutput(outcome.hold, now, ctx.placeTz),
    line: outcome.line.map((h) => toBookingHoldOutput(h, now, ctx.placeTz)),
    notificationIntents: outcome.intents,
    requestlessIntents: outcome.released
      ? requestlessReleaseIntents(outcome.hold, ctx)
      : [],
    staffRecipientHint: ctx.staffRecipientHint,
    viewer: ctx.by,
  });
}

/**
 * The booker arm, re-checked on a row read under the line lock: still a
 * BOOKER hold, still the same holder, and the actor still acts for that
 * holder (an org editor demoted, a delegation withdrawn since the gate). A
 * revoke that kept it as the place's (or anything else that moved it off the
 * booker) refuses with the gate's code, as if the booker gate had failed.
 * Staff release any kind.
 */
async function requireStillOwn(
  tx: TxRepos,
  ctx: ReleaseContext,
  row: BookingHoldRecord,
  actorHumanId: string,
): Promise<void> {
  if (ctx.by !== "booker" || ctx.hold.ownerKind !== "BOOKER") return;
  if (
    row.ownerKind === "BOOKER" &&
    sameGrantee(row.holder, ctx.hold.holder) &&
    (await actorActsForParty(tx, actorHumanId, row.holder))
  ) {
    return;
  }
  throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } });
}

type ReleaseContext = {
  hold: BookingHoldRecord;
  placeId: string;
  placeTz: string;
  staffRecipientHint: BookingHoldStaffRecipientHint;
  by: "staff" | "booker";
};

/**
 * The booker arm (a BOOKER hold whose holder the actor acts for under an
 * active grant on the hold's calendar), else the staff gate.
 */
async function loadReleaseContext(
  repos: Repos,
  holdId: string,
  actorHumanId: string,
  now: Date,
): Promise<ReleaseContext> {
  const hold = await requireHold(repos, holdId);
  if (hold.ownerKind === "BOOKER") {
    const place = await requireRequestlessHoldPlace(repos, hold);
    const own = await listPlaceBookerGrants(repos, place, actorHumanId, {
      calendarId: hold.calendarId,
      now,
      as: hold.holder,
    });
    if (own.length > 0) {
      return {
        hold,
        placeId: place.id,
        placeTz: resolveBookingTimezone(place.timezone),
        // The booker is not staff: staff routing starts at the grant's giver.
        staffRecipientHint: staffRecipientHintFor({
          hold: { placedByHumanId: own[0]!.grant.grantedByHumanId },
          request: null,
          place,
          ownership: null,
        }),
        by: "booker",
      };
    }
  }
  const staff = await loadStaffHoldContext(repos, holdId, actorHumanId);
  return {
    hold: staff.hold,
    placeId: staff.place.id,
    placeTz: staff.placeTz,
    staffRecipientHint: staff.staffRecipientHint,
    by: "staff",
  };
}

/** FR-013: who hears of a request-less release, by who released it. */
function requestlessReleaseIntents(
  hold: BookingHoldRecord,
  ctx: ReleaseContext,
): RequestlessHoldNotificationIntent[] {
  if (hold.ownerKind !== "BOOKER") return [];
  const base = {
    kind: "requestless_hold.released" as const,
    holdId: hold.id,
    placeId: ctx.placeId,
    calendarId: hold.calendarId,
    date: hold.date,
    reason: "MANUAL" as const,
    by: ctx.by,
  };
  return ctx.by === "booker"
    ? [{ ...base, audience: "staff", staffHumanId: ctx.staffRecipientHint.placedByHumanId }]
    : [{ ...base, audience: "booker", party: hold.holder, staffHumanId: null }];
}
