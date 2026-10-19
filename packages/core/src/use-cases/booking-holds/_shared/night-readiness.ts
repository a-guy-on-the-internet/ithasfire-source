import type { TxRepos } from "@th/ports/repos";
import type {
  BookingHoldLineEntry,
  BookingHoldLineKey,
  BookingHoldLineTerms,
  BookingHoldRecord,
} from "@th/ports/repos/booking-holds";
import type { AgreementStatus } from "@th/ports/repos/agreements";

import { resolveBookingTimezone } from "../../booking-agreements/_shared/pitch-seed";
import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";

// `todayInZone` IS `bookingNightOf` (booking-night.ts) — imported from the
// lapse module directly so hold-line.ts can use this file without a cycle.
import { isHoldLapsed, todayInZone } from "./booking-hold-lapse";

// ─────────────────────────────────────────────────────────────────────────────
// IS SOMEONE READY TO BOOK THIS NIGHT? — booking-the-night N20 / FR-015, and
// the readiness half of holds-without-a-request H12 (owner ruling 2026-10-01:
// ONE function both specs call).
//
// The venue may challenge the hold at 1st on a night only when a LIVE hold
// BEHIND it on the same line (calendar + place-local day) is ready to book:
//
//   (a) a REQUEST's hold is ready when that request's terms (its Agreement)
//       are DRAFT or later — DRAFT, PROPOSED, COUNTERED or ACCEPTED, never
//       DECLINED / CANCELLED / EXPIRED, nor the post-show FULFILLED /
//       DISPUTED — and their `proposedDate` falls on the hold's night, as the
//       place reads its calendar (`bookingNightOf` / `todayInZone`, the one day rule every
//       line consumer uses). "Ready" means drafted, not sent: N6 still stops
//       terms being SENT while another act is ahead.
//   (b) a hold with NO request — an outside booker's, or the place's own —
//       is ready by its existence: its owner challenges in order to make the
//       event (owner ruling 2026-10-01).
//
// `holdOwnerKindOf` reads the hold's owner kind (holds-without-a-request
// FR-001 / FR-006), so a BOOKER or PLACE hold behind the 1st counts as ready.
//
// LEAKS: the answer names another party's hold. Only the VENUE side may ever
// see which hold is ready (`findReadyBehind`'s return value); the act at 1st
// hold learns only that "another act is ready" (the N20 notice copy).
// ─────────────────────────────────────────────────────────────────────────────

/** Who owns a hold (holds-without-a-request: request | outside booker | place). */
export type HoldOwnerKind = "request" | "booker" | "place";

/** The owner kind of a hold, read from its `ownerKind` (FR-001). */
export function holdOwnerKindOf(
  hold: Pick<BookingHoldRecord, "ownerKind">,
): HoldOwnerKind {
  switch (hold.ownerKind) {
    case "REQUEST":
      return "request";
    case "BOOKER":
      return "booker";
    case "PLACE":
      return "place";
    default: {
      const never: never = hold.ownerKind;
      return never;
    }
  }
}

/** Terms statuses that count as "ready" (DRAFT or later, still in play). */
export const READY_TERMS_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "COUNTERED",
  "ACCEPTED",
] as const satisfies readonly AgreementStatus[];

/**
 * THE rule, on one hold's facts (pure). `terms` is the owning request's
 * Agreement (null when it has none); `night` the hold's place-local day.
 */
export function isOwnerReadyToBook(args: {
  ownerKind: HoldOwnerKind;
  terms: Pick<BookingHoldLineTerms, "status" | "proposedDate"> | null;
  night: string;
  placeTz: string;
}): boolean {
  switch (args.ownerKind) {
    case "booker":
    case "place":
      // (b) An outside booker or the place holds to make the event.
      return true;
    case "request": {
      // (a) Drafted (or later) terms dated this night.
      const { terms } = args;
      if (!terms || !terms.proposedDate) return false;
      if (
        !(READY_TERMS_STATUSES as readonly string[]).includes(terms.status)
      ) {
        return false;
      }
      return todayInZone(terms.proposedDate, args.placeTz) === args.night;
    }
    default: {
      const never: never = args.ownerKind;
      return never;
    }
  }
}

/**
 * The request's terms are AGREED for this night (ACCEPTED, dated `night` the
 * way the place reads its calendar) — booking-the-night P2d-2 (review W3).
 * Such a request needs booking (Create event), not a challenge, and Keep
 * has nothing left to agree: both refuse TERMS_AGREED_FOR_THIS_NIGHT.
 */
export function areTermsAgreedForNight(
  terms: Pick<BookingHoldLineTerms, "status" | "proposedDate"> | null,
  night: string,
  placeTz: string,
): boolean {
  return (
    terms !== null &&
    terms.status === "ACCEPTED" &&
    terms.proposedDate !== null &&
    todayInZone(terms.proposedDate, placeTz) === night
  );
}

/** Is this line entry's owner ready to book its night? */
export function isReadyToBookNight(
  entry: BookingHoldLineEntry,
  placeTz: string,
): boolean {
  return isOwnerReadyToBook({
    ownerKind: holdOwnerKindOf(entry),
    terms: entry.terms,
    night: entry.date,
    placeTz,
  });
}

/**
 * The first LIVE, unlapsed hold BEHIND `target` (higher position, line order)
 * whose owner is ready to book the night — or null. `line` is the line read
 * with terms (`listLineWithTerms`); lapsed rows are projected out here, so
 * a read that did not settle the line first still answers truthfully.
 * VENUE-SIDE ONLY: the result names another party's hold.
 */
export function findReadyBehind(args: {
  line: readonly BookingHoldLineEntry[];
  target: Pick<BookingHoldRecord, "id" | "position">;
  now: Date;
  placeTz: string;
}): BookingHoldLineEntry | null {
  const { line, target, now, placeTz } = args;
  return (
    line.find(
      (entry) =>
        entry.id !== target.id &&
        entry.position > target.position &&
        isHoldLapsed(entry, now, placeTz) === null &&
        isReadyToBookNight(entry, placeTz),
    ) ?? null
  );
}

/**
 * {@link findReadyBehind} on a fresh line read. Inside a transaction the
 * caller holds the line lock (`settleLine`), so the membership read here is
 * the membership it then writes against: a ready hold released in a racing
 * transaction is either gone from this read or still live, never half-way.
 */
export async function findReadyBehindOnLine(
  repos: Pick<TxRepos, "bookingHolds">,
  args: {
    key: BookingHoldLineKey;
    target: Pick<BookingHoldRecord, "id" | "position">;
    now: Date;
    placeTz: string;
  },
): Promise<BookingHoldLineEntry | null> {
  const line = await repos.bookingHolds.listLineWithTerms(args.key);
  return findReadyBehind({
    line,
    target: args.target,
    now: args.now,
    placeTz: args.placeTz,
  });
}

/**
 * N20 / FR-015 "If the 1st-hold act releases or lapses, the ready act moves
 * to 1st hold and the venue gets a one-tap Send terms": when `hold` has just
 * moved UP to position 1 and its request's terms are ready for that night,
 * its thread gets the VENUE-INTERNAL `booking_hold.first_ready` entry.
 *
 * Called from `recordMovers` — the ONE place a move is recorded — so a
 * release, a lapse, a closure and a reorder all say it the same way. Runs in
 * the mover's transaction, under the line lock its caller already holds. The
 * terms are read FIRST and the place's zone only when they could be ready, so
 * a mover without terms costs one line read.
 */
export async function recordFirstReadyIfReady(
  tx: TxRepos,
  hold: BookingHoldRecord,
): Promise<boolean> {
  // A request-less hold has no thread to write to (holds-without-a-request
  // H20); the cue is about a request's terms.
  if (hold.ownerKind !== "REQUEST") return false;
  const entry = (
    await tx.bookingHolds.listLineWithTerms({
      calendarId: hold.calendarId,
      date: hold.date,
    })
  ).find((row) => row.id === hold.id);
  const terms = entry?.terms ?? null;
  if (
    !entry ||
    !terms ||
    !terms.proposedDate ||
    !(READY_TERMS_STATUSES as readonly string[]).includes(terms.status)
  ) {
    return false;
  }
  const calendar = await tx.calendars.findById(hold.calendarId);
  const place = calendar ? await tx.places.getById(calendar.placeId) : null;
  if (!place) return false;
  if (!isReadyToBookNight(entry, resolveBookingTimezone(place.timezone))) {
    return false;
  }
  await appendBookingSystemEntry(tx, {
    bookingRequestId: hold.bookingRequestId,
    kind: "booking_hold.first_ready",
    data: { holdId: hold.id, date: hold.date, agreementId: terms.agreementId },
    // Machine-noticed: the move's cause is on the `.reordered` entry beside it.
    actorHumanId: null,
  });
  return true;
}
