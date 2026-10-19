import type { TxRepos } from "@th/ports/repos";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import {
  hasActiveVenueConfirmationStamp,
  isVenueOwnedEvent,
  type VenueConfirmationEventFields,
} from "../../lib/venue-confirmation";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import { requirePlaceBookingAuthority } from "../booking-requests/_shared/place-access";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { findBookingThreadForEvent } from "../events/_shared/booking-event-ledger";
import {
  ensureLoadedPlaceAccessible,
  type PlaceAccessOwner,
} from "../events/_shared/place-access";
import type {
  BookingHoldNotificationIntent,
  BookingHoldStaffRecipientHint,
} from "./_shared/booking-hold-intents";
import { todayInZone } from "./_shared/booking-hold-lapse";
import {
  assertLineSetCovered,
  lineKeyOf,
  lineKeysOf,
  lockLines,
  sortLineKeys,
  type HoldLineKey,
} from "./_shared/hold-line";
import { settleLine } from "./_shared/settle-lapsed-holds";
import { resolveStaffRecipientOrgId } from "./_shared/staff-recipient-org";
import { takeLine } from "./_shared/take-line";

// ─────────────────────────────────────────────────────────────────────────────
// FR-018 — a date is TAKEN when an event on that calendar becomes PUBLISHED.
//
// Called INSIDE the transaction that publishes (or moves, or expands) the
// event, AFTER its status/date write — the caller writes the event row first
// (which is also the row lock), then this takes the provenance request's
// booking lock, then the lines — so the holds and the event can never
// disagree about who has the night, and the lock order matches Cancel
// booking's (event row → booking lock → lines; see the LOCK ORDER note in
// `settleHeldDatesForPublishedEvent`). For every date the event occupies on
// its calendar — startsAt's place-local day plus each SCHEDULED occurrence
// day — the line is locked (global order), settled (lapsed challenges expire
// first), then TAKEN (take-line.ts):
//
//   - an OPEN challenge on another hold → HOLD_LINE_HAS_OPEN_CHALLENGE, the
//     caller's tx rolls back and the publish is refused;
//   - the event's provenance booking request has a live hold on the line →
//     that hold is CONFIRMED, exactly as on Confirm (siblings
//     SIBLING_CONFIRMED, competitors CONFIRMED_OTHER, ledger + intents);
//   - otherwise every live hold → RELEASED (EVENT_SCHEDULED); each act and
//     the request's assignee are told.
//
// Drafts never get here (the callers gate on PUBLISHED). An event with no
// calendar is outside the holds world: nothing is read, nothing is written.
// A released hold is terminal (FR-019): moving the event later restores
// nothing — the venue places new holds.
//
// ONLY A VENUE-OWNED OR VENUE-CONFIRMED EVENT TAKES A LINE (booking-holds
// spec, locked 2026-09-07; venue-confirmation spec "Unconfirmed events block
// nothing and mean nothing"). `settleHeldDatesForEvent` derives that through
// `lib/venue-confirmation` (the one derivation) BEFORE any access check and
// before a single hold is read: an unconfirmed third-party publish settles
// nothing and never throws — the venue's later confirmation
// (`confirmVenueEvent`) is what takes the line, through this same helper.
// ─────────────────────────────────────────────────────────────────────────────

export type SettleHeldDatesForPublishedEventArgs = {
  eventId: string;
  calendarId: string;
  /** ISO `YYYY-MM-DD` place-local days the event occupies on `calendarId`. */
  occupiedDates: readonly string[];
  /** The booking request the event came out of (agreement → request), or null. */
  provenanceRequestId: string | null;
  now: Date;
  /** Resolved IANA zone of the place (see `resolveBookingTimezone`). */
  placeTz: string;
  /** Null when machine-caused (a scheduled job): no hint, null ledger actor. */
  actorHumanId: string | null;
};

export type SettleHeldDatesForPublishedEventResult = {
  /** The provenance request's holds this call CONFIRMED (at most one per line). */
  confirmed: BookingHoldRecord[];
  /** Every hold this call released (any reason). */
  released: BookingHoldRecord[];
  intents: BookingHoldNotificationIntent[];
};

const isLive = (hold: Pick<BookingHoldRecord, "status">) =>
  (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status);

/**
 * Take every occupied line for the event. Pure line mechanics: the caller
 * has already resolved the calendar, the zone, the dates and the provenance
 * (see {@link settleHeldDatesForEvent} for the one that does that).
 */
export async function settleHeldDatesForPublishedEvent(
  tx: TxRepos,
  args: SettleHeldDatesForPublishedEventArgs,
): Promise<SettleHeldDatesForPublishedEventResult> {
  const { eventId, calendarId, now, placeTz, actorHumanId } = args;
  const eventKeys: HoldLineKey[] = sortLineKeys(
    new Map(
      args.occupiedDates.map((date) => [date, { calendarId, date }]),
    ).values(),
  );
  if (eventKeys.length === 0) {
    return { confirmed: [], released: [], intents: [] };
  }

  // LOCK ORDER: every line this tx may touch — the event's own lines and
  // every line a SIBLING of the provenance request sits in (a win releases
  // them) — locked up front in the global sorted order, before any read a
  // write depends on. The sibling set comes from a pre-lock read, so it is
  // re-read under the locks and the tx gives up (HOLD_LINE_CHANGED, the
  // client retries) if a hold landed on a NEW line in between.
  const requestId = args.provenanceRequestId;
  // The provenance request's BOOKING lock first (booking-the-night P2c,
  // review W1): this can CONFIRM that request's hold — book its night — so it
  // serializes with everything else that books, un-books or closes the
  // request (Withdraw, Close request, Cancel booking, the takes). Every
  // caller has already written the event row, so the order is event row →
  // booking lock → lines: Cancel booking's order (cancelEvent's row first),
  // and the takes / exits take no event row. No cycle.
  if (requestId) {
    await tx.bookingHolds.lockRequestBooking(requestId);
  }
  const preLockRequestHolds = requestId
    ? (await tx.bookingHolds.listForRequest(requestId)).filter(isLive)
    : [];
  const lockedKeys = sortLineKeys(
    new Map(
      [...eventKeys, ...lineKeysOf(preLockRequestHolds)].map((key) => [
        `${key.calendarId}|${key.date}`,
        key,
      ]),
    ).values(),
  );
  await lockLines(tx, lockedKeys);
  const requestHolds = requestId
    ? (await tx.bookingHolds.listForRequest(requestId)).filter(isLive)
    : [];
  assertLineSetCovered(lockedKeys, requestHolds);

  // A SIBLING is the request's hold on a line the event does NOT occupy. Its
  // holds on the event's OTHER lines are not siblings: each is this loop's
  // winner when its own line comes up (an event on two dates confirms both),
  // so releasing them as SIBLING_CONFIRMED on the first line would leave the
  // second line with nothing to confirm.
  const eventLineKeys = new Set(eventKeys.map(lineKeyOf));
  const siblingHolds = requestHolds.filter(
    (h) => !eventLineKeys.has(lineKeyOf(h)),
  );

  const confirmed: BookingHoldRecord[] = [];
  const released: BookingHoldRecord[] = [];
  const intents: BookingHoldNotificationIntent[] = [];

  for (const key of eventKeys) {
    const settled = await settleLine(tx, { ...key, now, placeTz });
    intents.push(...settled.intents);
    const line = settled.line;
    if (line.length === 0) continue;

    // Own request wins: its live hold on THIS line (re-read from the settled
    // line, so a hold the settle just released is not a winner).
    // Request holds only: a request-less hold on the line is released like
    // any other non-winner (audit only, H20) until FR-009's request-less
    // winner rule lands (plan step 7).
    const own = requestId
      ? (line.find(
          (h) => h.ownerKind === "REQUEST" && h.bookingRequestId === requestId,
        ) ?? null)
      : null;

    const taken = await takeLine(
      tx,
      own
        ? {
            key,
            line,
            winner: {
              hold: own,
              // Siblings as of NOW: one released on an earlier line of this
              // same loop is no longer live.
              requestHolds: siblingHolds.filter(
                (h) => !released.some((r) => r.id === h.id),
              ),
            },
            now,
            actorHumanId,
          }
        : {
            key,
            line,
            winner: null,
            releaseReason: "EVENT_SCHEDULED",
            now,
            actorHumanId,
          },
    );
    released.push(...taken.released);
    intents.push(...taken.intents);

    if (taken.confirmed) {
      confirmed.push(taken.confirmed);
    }
    // The winner is always `own`, a request hold; the narrow is for the type.
    if (taken.confirmed?.ownerKind === "REQUEST") {
      // The event already exists, so — unlike Confirm's pre-mint entry —
      // the ledger can name it.
      await appendBookingSystemEntry(tx, {
        bookingRequestId: taken.confirmed.bookingRequestId,
        kind: "booking_hold.confirmed",
        data: { holdId: taken.confirmed.id, eventId },
        actorHumanId,
      });
    }
  }

  if (confirmed.length > 0 || released.length > 0) {
    await tx.audit.log({
      entity: "event",
      entityId: eventId,
      action: "event.held_dates_settled",
      data: {
        actorHumanId,
        calendarId,
        dates: eventKeys.map((k) => k.date),
        confirmedHoldIds: confirmed.map((h) => h.id),
        releasedHoldIds: released.map((h) => h.id),
      },
      at: now,
    });
  }

  return { confirmed, released, intents };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook-site entry: resolves everything the line mechanics need from the
// event row, then takes the lines. This is what publish / save / recurrence
// call.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whose edit access to the calendar's place is re-asserted before a hold is
 * written. An OWNED event names its owner — the save path deliberately skips
 * its place gate on a same-place edit, so without this a revoked org could
 * move its event onto a date and take another org's holds. An ownerless
 * COMMUNITY listing has no owner relation to the place, so the ACTOR is held
 * to the venue booking-authority bar (`requirePlaceBookingAuthority`:
 * owner / edit-role member; never a booking grantee) instead.
 */
export type HeldDatesOwner = PlaceAccessOwner | { kind: "community" };

/** The event row's owner, for the hook sites that only have the row. */
export function heldDatesOwnerOf(
  event: Pick<EventRecord, "orgId" | "humanId">,
): HeldDatesOwner {
  if (event.orgId) return { kind: "org", orgId: event.orgId };
  if (event.humanId) return { kind: "human", humanId: event.humanId };
  return { kind: "community" };
}

export type SettleHeldDatesForEventArgs = {
  /**
   * The event as it will be once this tx commits: id, calendar, start, and
   * the owner + venue-confirmation columns the take-a-line gate reads
   * (`isVenueConfirmed`). Hook sites hand in the full row.
   */
  event: Pick<EventRecord, "id" | "startsAt"> &
    VenueConfirmationEventFields & {
      calendarId?: string | null;
    };
  now: Date;
  /** Null when machine-caused (a scheduled job): no hint, null ledger actor. */
  actorHumanId: string | null;
  /**
   * Re-checked against the place before any hold is touched (see
   * {@link HeldDatesOwner}). Skipped when `actorHumanId` is null: a job acts
   * as the platform, and the access it would re-check is nobody's.
   */
  owner: HeldDatesOwner;
  /**
   * The booking request whose live hold on the line WINS (own request wins).
   * `undefined` (the publish / save hook sites) = derive it from the event's
   * booking thread (agreement → request). `confirmVenueEvent` passes the
   * request it is confirming explicitly: an event-first request has no
   * agreement to walk, and its hold must still be the winner. `null` = no
   * provenance (every live hold is released).
   */
  provenanceRequestId?: string | null;
};

export type SettleHeldDatesForEventResult =
  SettleHeldDatesForPublishedEventResult & {
    /** FR-016 routing for the staff intents; null when nothing was owed. */
    staffRecipientHint: BookingHoldStaffRecipientHint | null;
  };

const NO_OP: SettleHeldDatesForEventResult = {
  confirmed: [],
  released: [],
  intents: [],
  staffRecipientHint: null,
};

/**
 * Every place-local day the event occupies on its calendar: startsAt's day
 * plus each SCHEDULED occurrence's day. Deduplicated, sorted.
 */
export async function occupiedDatesForEvent(
  tx: Pick<TxRepos, "eventDates">,
  event: Pick<EventRecord, "id" | "startsAt">,
  placeTz: string,
): Promise<string[]> {
  const days = new Set<string>([todayInZone(event.startsAt, placeTz)]);
  const occurrences = await tx.eventDates.listByEvent({
    eventId: event.id,
    statuses: ["SCHEDULED"],
  });
  for (const occurrence of occurrences) {
    days.add(todayInZone(occurrence.startsAt, placeTz));
  }
  return [...days].sort();
}

export async function settleHeldDatesForEvent(
  tx: TxRepos,
  args: SettleHeldDatesForEventArgs,
): Promise<SettleHeldDatesForEventResult> {
  const calendarId = args.event.calendarId ?? null;
  // No calendar → outside the holds world. Not a single read.
  if (!calendarId) return NO_OP;

  const calendar = await tx.calendars.findById(calendarId);
  if (!calendar) return NO_OP;
  const place = await tx.places.getById(calendar.placeId);
  if (!place) return NO_OP;

  // THE GATE (booking-holds spec, 2026-09-07): only a venue-owned or
  // venue-confirmed event takes a line. Derived through `lib/venue-
  // confirmation` — never re-derived here — and evaluated BEFORE the access
  // check and before any hold is read, so an unconfirmed third-party publish
  // is a clean no-op: it neither blocks the venue's holds nor throws at the
  // owner (who, by construction, holds no venue authority to be checked
  // against). The line is taken when the venue confirms the event.
  const venueOwned = isVenueOwnedEvent(args.event, place);
  const venueConfirmed =
    venueOwned || hasActiveVenueConfirmationStamp(args.event);
  if (!venueConfirmed) return NO_OP;

  // Access gate, BEFORE a single hold is read: taking a line is a write to
  // the venue's calendar, and an edit that reached here may not have
  // re-checked the place (same-place save). Three shapes:
  //   · a VENUE-OWNED event: the owner's own place access, with the save
  //     path's errors (PLACE_NOT_FOUND / PLACE_NOT_ACTIVE) — a revoked owner
  //     stops being venue-owned and lands in the no-op above, so what is
  //     left to refuse here is a place that is no longer ACTIVE;
  //   · a venue-CONFIRMED third-party event: the owner has no place access by
  //     definition; the venue's stamp IS the authority to take the line, so
  //     only the place's liveness is asserted;
  //   · an ownerless COMMUNITY listing (stamped — an unstamped one never gets
  //     here): the ACTOR is held to the hold use cases' staff gate
  //     (NOT_RESOURCE_OWNER / INSUFFICIENT_ROLE). A booking grantee is not
  //     staff (holds-without-a-request FR-002): its own events are owned by
  //     the grantee and take the confirmed-third-party branch above.
  // Unconditional on purpose — gating only "when there is something to take"
  // would race a hold placed after the check.
  if (args.actorHumanId !== null) {
    if (args.owner.kind === "community") {
      await requirePlaceBookingAuthority(tx, place, args.actorHumanId);
    } else if (venueOwned) {
      ensureLoadedPlaceAccessible(place, args.owner);
    } else if (place.status !== "ACTIVE") {
      throw fail("PLACE_NOT_ACTIVE");
    }
  }
  const placeTz = resolveBookingTimezone(place.timezone);

  const occupiedDates = await occupiedDatesForEvent(tx, args.event, placeTz);
  // Provenance: the caller's explicit request (confirmVenueEvent), else the
  // event's booking thread.
  const thread =
    args.provenanceRequestId === undefined
      ? await findBookingThreadForEvent(tx, args.event.id)
      : null;
  const provenanceRequestId =
    args.provenanceRequestId === undefined
      ? (thread?.bookingRequest.id ?? null)
      : args.provenanceRequestId;
  const provenanceAssigneeHumanId =
    args.provenanceRequestId === undefined
      ? (thread?.bookingRequest.assigneeHumanId ?? null)
      : provenanceRequestId
        ? ((await tx.bookingRequests.getById(provenanceRequestId))
            ?.assigneeHumanId ?? null)
        : null;

  const result = await settleHeldDatesForPublishedEvent(tx, {
    eventId: args.event.id,
    calendarId,
    occupiedDates,
    provenanceRequestId,
    now: args.now,
    placeTz,
    actorHumanId: args.actorHumanId,
  });
  if (result.intents.length === 0 || args.actorHumanId === null) {
    return { ...result, staffRecipientHint: null };
  }

  // FR-016 routing hint — same resolution as the hold use cases (see
  // `resolveStaffRecipientOrgId`). `placedByHumanId` is nominal: the
  // dispatcher routes STAFF intents from each intent's own `staff` block.
  return {
    ...result,
    staffRecipientHint: {
      assigneeHumanId: provenanceAssigneeHumanId,
      placedByHumanId: args.actorHumanId,
      orgId: await resolveStaffRecipientOrgId(
        tx.authz,
        place,
        args.actorHumanId,
      ),
      placeId: place.id,
    },
  };
}
