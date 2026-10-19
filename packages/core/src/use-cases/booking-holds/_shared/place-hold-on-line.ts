import { DateTime } from "luxon";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BookerBookingHoldRecord,
  BookingHoldHolder,
  PlaceBookingHoldRecord,
  RequestBookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import type { ToVenueBookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail, isAppError } from "@th/errors";

import { resolveBookingTimezone } from "../../booking-agreements/_shared/pitch-seed";
import {
  requirePlaceBookingAuthority,
  type PlaceBookingAuthorityResult,
} from "../../booking-requests/_shared/place-access";
import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";
import type { BookingHoldNotificationIntent } from "./booking-hold-intents";
import { todayInZone } from "./booking-hold-lapse";
import { failBookingCancelled, isBookingCancelled } from "./booking-night";
import {
  requirePlace,
  requireRequest,
  requireToVenueRequest,
} from "./hold-context";
import { nextLinePosition, rethrowHoldLineConflict } from "./hold-line";
import { settleLine } from "./settle-lapsed-holds";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE placement path (FR-002), shared by `placeBookingHold` (single date)
// and `placeBookingHolds` (batch): the up-front resolve/gate, the per-date
// date rules, and the in-transaction line body.
//
// Both entry points resolve ONCE (the batch, once for the whole call) and
// then run `placeHoldOnLine` per date, each inside its own `repos.tx()`.
// Forking this logic would let the two paths drift on the things that
// actually matter: the line lock, the settle-before-count precondition, the
// CONFIRMED-winner refusal, position = the back of the line
// (`nextLinePosition`: max + 1, never a count), the ledger entry and the
// audit row. Request-less holds (holds-without-a-request FR-005) share the
// same in-transaction body through `placeRequestlessHoldOnLine` below.
//
// `spaceId` is deliberately NOT an input: the line is keyed on
// (calendarId, date) and neither SQL partial unique mentions a space, so a
// hold never reserved a room. The column stays (nullable) for history; new
// rows write null and the room is chosen at confirm, on the draft event.
// ─────────────────────────────────────────────────────────────────────────────

/** Statuses a hold can be placed against — anything not terminal. */
export const HOLDABLE_REQUEST_STATUSES = [
  "PENDING",
  "VIEWED",
  "ACCEPTED",
] as const;

export type HoldPlacementContext = {
  request: ToVenueBookingRequestRecord;
  place: PlaceRecord;
  ownership: PlaceBookingAuthorityResult;
  placeTz: string;
  /** The verified calendar id — proven to belong to the request's place. */
  calendarId: string;
};

/**
 * Load + gate everything a placement depends on, ONCE: the request is
 * TO_VENUE and still open, the actor holds an edit role on (or directly owns)
 * the request's place — STAFF only: a booking grantee does not place holds
 * for an act's request (holds-without-a-request FR-002; its own BOOKER holds
 * are FR-005's) — and the calendar is THAT place's — a structural
 * same-place assert via `listByPlace`, since a foreign calendarId simply is
 * not in the list.
 */
export async function resolveHoldPlacementContext(
  repos: Repos,
  args: {
    bookingRequestId: string;
    calendarId: string;
    actorHumanId: string;
    now: Date;
  },
): Promise<HoldPlacementContext> {
  const request = requireToVenueRequest(
    await requireRequest(repos, args.bookingRequestId),
  );
  if (
    !(HOLDABLE_REQUEST_STATUSES as readonly string[]).includes(request.status)
  ) {
    throw fail("INVALID_STATUS", {
      message: "booking_request_closed",
      meta: { bookingRequestId: request.id, status: request.status },
    });
  }

  const place = await requirePlace(repos, request.placeId);
  const ownership = await requirePlaceBookingAuthority(
    repos,
    place,
    args.actorHumanId,
  );

  const calendars = await repos.calendars.listByPlace(place.id);
  const calendar = calendars.find((c) => c.id === args.calendarId) ?? null;
  if (!calendar) {
    throw fail("CALENDAR_NOT_FOUND");
  }

  // A cancelled booking takes no new holds (booking-the-night FR-009): the
  // request stays ACCEPTED as history, closed for holds. Read-only here so
  // a batch is refused whole; re-checked under the request's booking lock
  // in `placeHoldOnLine`.
  if (isBookingCancelled(await repos.bookingHolds.listForRequest(request.id))) {
    failBookingCancelled();
  }

  return {
    request,
    place,
    ownership,
    placeTz: resolveBookingTimezone(place.timezone),
    calendarId: calendar.id,
  };
}

/** Field-level date rules the schema cannot express (place-local "today"). */
export const HOLD_DATE_ISSUES = [
  "invalid_calendar_date",
  "hold_date_in_past",
] as const;

export type HoldDateIssue = (typeof HOLD_DATE_ISSUES)[number];

/**
 * A real calendar day, not in the past (place-local). FR-010 would kill a
 * past-dated hold on the very next read anyway; refusing up front says so.
 * Returns the issue instead of throwing, so the batch path can record it per
 * date and keep going.
 */
export function checkHoldDate(
  date: string,
  now: Date,
  placeTz: string,
): HoldDateIssue | null {
  if (!DateTime.fromISO(date, { zone: placeTz }).isValid) {
    return "invalid_calendar_date";
  }
  if (date < todayInZone(now, placeTz)) {
    return "hold_date_in_past";
  }
  return null;
}

/** The adapter's live-unique conflict: this request is already in this line. */
export function isHoldExistsConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_exists"
  );
}

export function isHoldLineAlreadyConfirmed(error: unknown): boolean {
  return isAppError(error) && error.code === "HOLD_LINE_ALREADY_CONFIRMED";
}

export type PlaceHoldOnLineArgs = {
  request: Pick<ToVenueBookingRequestRecord, "id" | "placeId">;
  calendarId: string;
  date: string;
  now: Date;
  placeTz: string;
  actorHumanId: string;
};

export type PlaceHoldOnLineResult = {
  /** Placed for `request`: always a request hold. */
  hold: RequestBookingHoldRecord;
  /**
   * The intents the LINE owed as a side effect (lapse settlement + the
   * move-ups it caused). The `hold.placed` / `hold.placed_batch` intent for
   * the new row is the CALLER's to emit — the batch folds N placements into
   * one digest, so it cannot be minted here.
   */
  intents: BookingHoldNotificationIntent[];
};

/**
 * The line half every placement shares, inside the caller's transaction:
 * the line's advisory lock is taken and its lapses settled BEFORE it is
 * counted (`settleLine` does both), so the position handed out is the one
 * the holder will actually see; then a line with a CONFIRMED winner is
 * refused. Returns the fresh live line and the intents the settle owed.
 */
async function openLineForPlacement(
  tx: TxRepos,
  args: {
    calendarId: string;
    date: string;
    now: Date;
    placeTz: string;
    /** Extra refusal meta (the request id on a request placement). */
    meta?: Record<string, unknown>;
  },
): Promise<{
  line: Awaited<ReturnType<typeof settleLine>>["line"];
  intents: BookingHoldNotificationIntent[];
}> {
  const { calendarId, date, now, placeTz } = args;
  const { line, intents } = await settleLine(tx, {
    calendarId,
    date,
    now,
    placeTz,
  });

  // A line with a CONFIRMED winner is over: the night went to someone else
  // and a new hold on it could never be confirmed (the DB's
  // one-CONFIRMED-per-line unique). Say so instead of queueing a hold that
  // only ever ends as lost_date.
  const confirmed = await tx.bookingHolds.listLine({
    calendarId,
    date,
    statuses: ["CONFIRMED"],
  });
  if (confirmed.length > 0) {
    throw fail("HOLD_LINE_ALREADY_CONFIRMED", {
      meta: {
        ...args.meta,
        calendarId,
        date,
        confirmedHoldId: confirmed[0]!.id,
      },
    });
  }
  return { line, intents };
}

/**
 * Place ONE hold at the end of one calendar+date line, inside the caller's
 * transaction. Precondition: `resolveHoldPlacementContext` has already gated
 * the actor and proved the calendar belongs to the request's place.
 */
export async function placeHoldOnLine(
  tx: TxRepos,
  args: PlaceHoldOnLineArgs,
): Promise<PlaceHoldOnLineResult> {
  const { request, calendarId, date, now, placeTz, actorHumanId } = args;

  // The request's booking lock BEFORE the line lock (the global order), then
  // the cancelled-booking refusal on rows read under it: a Cancel booking
  // that commits first is seen here; one that comes after sees this hold
  // and releases it with the rest.
  await tx.bookingHolds.lockRequestBooking(request.id);
  if (isBookingCancelled(await tx.bookingHolds.listForRequest(request.id))) {
    failBookingCancelled();
  }

  const { line, intents } = await openLineForPlacement(tx, {
    calendarId,
    date,
    now,
    placeTz,
    meta: { bookingRequestId: request.id },
  });

  const hold = await tx.bookingHolds.create({
    bookingRequestId: request.id,
    calendarId,
    // The calendar owns the room; a hold never reserved one (see header).
    spaceId: null,
    date,
    position: nextLinePosition(line),
    placedByHumanId: actorHumanId,
  });

  await appendBookingSystemEntry(tx, {
    bookingRequestId: request.id,
    kind: "booking_hold.placed",
    // No calendarId on the ledger line — it renders on the act's thread.
    data: { holdId: hold.id, date: hold.date, position: hold.position },
    actorHumanId,
  });

  await tx.audit.log({
    entity: "booking_hold",
    entityId: hold.id,
    action: "booking_hold.placed",
    data: {
      actorHumanId,
      bookingRequestId: request.id,
      placeId: request.placeId,
      calendarId: hold.calendarId,
      spaceId: hold.spaceId,
      date: hold.date,
      position: hold.position,
    },
    at: now,
  });

  return { hold, intents };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request-less placement (holds-without-a-request FR-005): the same line
// body, for a BOOKER hold riding its grant or the place's own hold. No
// request, so no request booking lock and no thread entry (H20): the audit
// row is the hold's history. The CALLER gates the actor and, for a BOOKER
// hold, has already locked and re-checked the grant row in this transaction
// (`lockSharedAtPlace`, hold-line.ts LOCKING: grant row before the line).
// ─────────────────────────────────────────────────────────────────────────────

/** The adapter's holder partial-unique conflict (one live hold per holder per line). */
export function isHoldHolderExistsConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_holder_exists"
  );
}

export type RequestlessHoldOwner =
  | { ownerKind: "BOOKER"; grantId: string; holder: BookingHoldHolder }
  | { ownerKind: "PLACE"; holder: BookingHoldHolder | null };

export type PlaceRequestlessHoldOnLineArgs = {
  placeId: string;
  calendarId: string;
  date: string;
  now: Date;
  placeTz: string;
  actorHumanId: string;
  owner: RequestlessHoldOwner;
  /** Sanitized + length-checked by the caller; PLACE holds only (FR-005). */
  note?: string | null;
};

export type PlaceRequestlessHoldOnLineResult = {
  hold: BookerBookingHoldRecord | PlaceBookingHoldRecord;
  /** What the line owed as a side effect (lapses settled, their move-ups). */
  intents: BookingHoldNotificationIntent[];
};

/**
 * Place ONE request-less hold at the back of one line, inside the caller's
 * transaction: settle-before-count, the CONFIRMED-winner refusal, position
 * max + 1, then the insert and its audit row. The holder partial uniques
 * surface as typed BOOKING_HOLD_HOLDER_EXISTS (the holder is already live in
 * this line); an unassigned PLACE hold is never limited.
 */
export async function placeRequestlessHoldOnLine(
  tx: TxRepos,
  args: PlaceRequestlessHoldOnLineArgs,
): Promise<PlaceRequestlessHoldOnLineResult> {
  const { calendarId, date, now, placeTz, actorHumanId, owner } = args;
  const { line, intents } = await openLineForPlacement(tx, {
    calendarId,
    date,
    now,
    placeTz,
    meta: { ownerKind: owner.ownerKind },
  });

  let hold: BookerBookingHoldRecord | PlaceBookingHoldRecord;
  try {
    hold = await tx.bookingHolds.createRequestless({
      ...owner,
      calendarId,
      // The calendar owns the room; a hold never reserved one (see header).
      spaceId: null,
      date,
      position: nextLinePosition(line),
      placedByHumanId: actorHumanId,
      note: owner.ownerKind === "PLACE" ? (args.note ?? null) : null,
      now,
    });
  } catch (error) {
    if (isHoldHolderExistsConflict(error)) {
      throw fail("BOOKING_HOLD_HOLDER_EXISTS", {
        meta: { calendarId, date, ownerKind: owner.ownerKind },
      });
    }
    rethrowHoldLineConflict(error, { calendarId, date });
  }

  await tx.audit.log({
    entity: "booking_hold",
    entityId: hold.id,
    action: "booking_hold.placed",
    data: {
      actorHumanId,
      ownerKind: hold.ownerKind,
      grantId: hold.ownerKind === "BOOKER" ? hold.grantId : null,
      holder: hold.holder,
      placeId: args.placeId,
      calendarId: hold.calendarId,
      date: hold.date,
      position: hold.position,
      // Whether an opening note was written, never its text (audit rows are
      // wider-read than the note's audience, H21).
      hasNote: hold.note !== null,
    },
    at: now,
  });

  return { hold, intents };
}
