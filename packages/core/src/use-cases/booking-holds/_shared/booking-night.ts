import { DateTime } from "luxon";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import {
  DEFAULT_BOOKING_START_HOUR,
  parseBookingWallClock,
  parsePreferredDateEntry,
  type BookingWallClock,
} from "../../booking-agreements/_shared/pitch-seed";
import { isLiveBookingEvent } from "../../booking-agreements/_shared/booking-event-liveness";
import {
  isVenueOwnedEvent,
  type VenueConfirmationPlaceOwnerFields,
} from "../../../lib/venue-confirmation";
import { isHoldLapsed, todayInZone } from "./booking-hold-lapse";
import { lineKeyOf, type HoldLineKey } from "./hold-line";

// ─────────────────────────────────────────────────────────────────────────────
// THE NIGHT — booking-the-night (docs/specs/2026-09-25) N1 / N3 / N5 / N6.
//
// Terms carry an INSTANT (`Agreement.proposedDate`); a hold line is keyed on
// a place-local CALENDAR DAY. Everything that asks "which night do these
// terms book?" goes through `bookingNightOf`, so the send check (FR-002),
// the agree (FR-001) and the terms send (FR-003) can never disagree.
//
// A booking night IS the place-local calendar day the show starts on — the
// same day every other line consumer uses: hold placement, the lapse rule
// (`todayInZone`), and publish-time settling
// (settle-held-dates-for-published-event.ts). There is deliberately no
// "after midnight belongs to the night before" shift here: if this rule and
// publish settling disagreed, publishing would take a DIFFERENT line than the
// agree booked and release unrelated acts' holds for good. A show at 00:30 on
// Saturday books Saturday's line.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The place-local calendar day (`YYYY-MM-DD`) a show starting at `instant`
 * books — `todayInZone`, the line consumers' one definition of a day (Luxon
 * zone conversion + `toISODate`, never hour arithmetic, so DST cannot move it).
 */
export function bookingNightOf(instant: Date, placeTz: string): string {
  return todayInZone(instant, placeTz);
}

/**
 * The instant a show on `night` starts, at `clock` (else the calendar's
 * default start, else 19:00), in `placeTz` — always ON that calendar day, so
 * `bookingNightOf` of the result is `night` again. Null for an impossible day.
 */
export function anchorBookingNight(
  night: string,
  placeTz: string,
  clock: BookingWallClock | null,
  calendarDefaultStartTime: string | null,
): Date | null {
  const day = DateTime.fromISO(night, { zone: placeTz });
  if (!day.isValid) return null;
  const time = clock ??
    parseBookingWallClock(calendarDefaultStartTime) ?? {
      hour: DEFAULT_BOOKING_START_HOUR,
      minute: 0,
    };
  const start = day.set({
    hour: time.hour,
    minute: time.minute,
    second: 0,
    millisecond: 0,
  });
  return start.toJSDate();
}

// ─────────────────────────────────────────────────────────────────────────────
// N6 — is this night free for this request?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the line says about one request taking one night.
 *
 *   free   — nobody else is ahead of this request and no other party has
 *            booked it. `ownHold` is this request's hold on the line (live or
 *            already CONFIRMED), or null when it holds nothing there.
 *   taken  — `booked`: another party's CONFIRMED hold is on the line;
 *            `ahead`: another party's live hold is ahead of this request's
 *            (or anywhere in the line, when this request holds nothing there).
 *            `head` is the hold to point at: the confirmed one, or the
 *            line's position-1 hold (the one a challenge targets).
 *
 * "Another party" is any hold whose `bookingRequestId` is not this request's
 * — including a hold with no request at all (holds-without-a-request,
 * docs/specs/2026-09-30, not built): it is never ours.
 */
export type NightAssessment =
  | { kind: "free"; ownHold: BookingHoldRecord | null }
  | {
      kind: "taken";
      reason: "booked" | "ahead";
      head: BookingHoldRecord;
      /** Whether `head` can be challenged right now (line-level rule only). */
      challengeable: boolean;
    };

export function assessNight(args: {
  /** The LIVE line, position order, with lapses already settled or filtered. */
  line: readonly BookingHoldRecord[];
  /** The line's CONFIRMED rows (at most one, by the DB's partial unique). */
  confirmed: readonly BookingHoldRecord[];
  bookingRequestId: string;
}): NightAssessment {
  const { line, confirmed, bookingRequestId } = args;
  // A request-less hold is never this request's (holds-without-a-request).
  const isOurs = (h: BookingHoldRecord) =>
    h.ownerKind === "REQUEST" && h.bookingRequestId === bookingRequestId;

  const otherBooked = confirmed.find((h) => !isOurs(h));
  if (otherBooked) {
    return {
      kind: "taken",
      reason: "booked",
      head: otherBooked,
      challengeable: false,
    };
  }
  const ownBooked = confirmed.find(isOurs);
  if (ownBooked) {
    return { kind: "free", ownHold: ownBooked };
  }

  const own = line.find(isOurs) ?? null;
  const someoneAhead = line.some(
    (h) => !isOurs(h) && (own === null || h.position < own.position),
  );
  if (someoneAhead) {
    const head = line[0]!;
    return {
      kind: "taken",
      reason: "ahead",
      head,
      challengeable: isLineHeadChallengeable(line),
    };
  }
  return { kind: "free", ownHold: own };
}

/**
 * The line-level half of `challengeBookingHold`'s rules: the position-1 hold
 * is ACTIVE and no challenge is open anywhere in the line. The other half —
 * someone behind is READY to book the night (N20 / FR-015) — is
 * `findReadyBehind` (night-readiness.ts), which needs the line's terms; the
 * thread strip's `lineHeads` folds both. NIGHT_TAKEN's `challengeable` meta
 * stays this line-level half only (the send's own N6 read has no terms):
 * the challenge itself re-checks readiness and refuses NO_ACT_READY.
 */
export function isLineHeadChallengeable(
  line: readonly BookingHoldRecord[],
): boolean {
  const head = line[0];
  return (
    head !== undefined &&
    head.status === "ACTIVE" &&
    !line.some((h) => h.status === "CHALLENGED")
  );
}

/** A live line read with every lapsed row projected out (no writes). */
export function withoutLapsed(
  line: readonly BookingHoldRecord[],
  now: Date,
  placeTz: string,
): BookingHoldRecord[] {
  return line.filter((h) => isHoldLapsed(h, now, placeTz) === null);
}

/**
 * NIGHT_TAKEN — VENUE SIDE ONLY. Its meta names another party's hold (the one
 * the venue can challenge), which an act must never see (booking-holds
 * FR-013); the sender's agree path refuses with NIGHT_NO_LONGER_AVAILABLE,
 * which carries nothing.
 *
 * `position` is the position of the hold in the way (1 for a live line);
 * `aheadHoldId` is that hold's id when it is a live hold (null when the night
 * is already booked — a confirmed hold cannot be challenged); `booked` says
 * which of the two it is.
 */
export function failNightTaken(
  assessment: Extract<NightAssessment, { kind: "taken" }>,
  date: string,
): never {
  throw fail("NIGHT_TAKEN", {
    meta: {
      date,
      position: assessment.head.position,
      aheadHoldId: assessment.reason === "ahead" ? assessment.head.id : null,
      booked: assessment.reason === "booked",
      challengeable: assessment.challengeable,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Which line do these terms book?
// ─────────────────────────────────────────────────────────────────────────────

const isLiveOrConfirmed = (h: BookingHoldRecord) =>
  h.status === "CONFIRMED" ||
  (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(h.status);

/**
 * The calendar the terms' night is booked on. An Agreement has no calendar of
 * its own, so: this request's hold on that night (a CONFIRMED one first, then
 * one on the request's routed calendar, then the lowest position) → the
 * request's routed calendar → the place's default calendar. Null when the
 * place has no calendar at all.
 */
export async function resolveNightCalendarId(
  repos: Pick<Repos, "bookingHolds" | "calendars">,
  args: {
    request: Pick<BookingRequestRecord, "id" | "calendarId">;
    placeId: string;
    night: string;
  },
): Promise<string | null> {
  const onNight = (await repos.bookingHolds.listForRequest(args.request.id))
    .filter((h) => h.date === args.night && isLiveOrConfirmed(h))
    .sort(
      (a, b) =>
        Number(b.status === "CONFIRMED") - Number(a.status === "CONFIRMED") ||
        Number(b.calendarId === args.request.calendarId) -
          Number(a.calendarId === args.request.calendarId) ||
        a.position - b.position,
    );
  if (onNight[0]) return onNight[0].calendarId;
  return resolvePlaceCalendarId(repos, {
    request: args.request,
    placeId: args.placeId,
  });
}

/**
 * The calendar a request's event lands on when no hold names one: its routed
 * calendar when that really is one of this place's, else the place's default
 * — exactly the mint's own routing + fallback (`listByPlace`, then
 * `isDefault`), so a line checked with this is the line the event lands on.
 */
export async function resolvePlaceCalendarId(
  repos: Pick<Repos, "calendars">,
  args: {
    request: Pick<BookingRequestRecord, "calendarId">;
    placeId: string;
  },
): Promise<string | null> {
  const calendars = await repos.calendars.listByPlace(args.placeId);
  const routed = args.request.calendarId
    ? calendars.find((calendar) => calendar.id === args.request.calendarId)
    : undefined;
  return (
    routed?.id ?? calendars.find((calendar) => calendar.isDefault)?.id ?? null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The booking's event must sit on the booked night (NFR-001)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a booking path will hand back instead of minting (spec N11; owner
 * rulings 2026-10-01, both of them):
 *   - `event` — the LIVE event: the finalized link (`Agreement.eventId`),
 *     else a LIVE draft anchor (`draftEventId`), else — event-first — the
 *     LIVE origin event (`BookingRequest.originEventId`);
 *   - `none` — nothing yet: the mint will create the event on the night;
 *   - `origin_gone` — EVENT-FIRST, and the origin event is cancelled,
 *     archived or deleted. ALWAYS refused, whatever else anchors the request
 *     (no exception for a leftover legacy draft or a finalized link): the
 *     night is not booked, and no path mints a fresh event in its place;
 *   - `linked_gone` — the terms were FINALIZED against an event that is now
 *     cancelled or archived (or deleted under a stale read). Refused too: a
 *     finalized link is the money link, so it is never replaced by a mint,
 *     and handing back a dead event would book a night for nothing.
 * Every booking path refuses both `*_gone` kinds before the line moves, and
 * the event-first link refuses them too — one rule.
 */
export type BookingEventResolution =
  | { kind: "event"; event: EventRecord }
  | { kind: "none" }
  | { kind: "origin_gone"; originEventId: string }
  | { kind: "linked_gone"; eventId: string };

/** Works on the root repos or inside a transaction. */
export async function resolveBookingEvent(
  repos: Pick<Repos, "events">,
  args: {
    agreement: Pick<AgreementRecord, "eventId" | "draftEventId"> | null;
    request: Pick<BookingRequestRecord, "originEventId">;
  },
): Promise<BookingEventResolution> {
  return resolveBookingEventWith((id) => repos.events.getById(id), args);
}

/**
 * {@link resolveBookingEvent}'s rule over any event lookup — the inbox list
 * runs it over the events it already batch-read, so the venue's buttons are
 * gated on exactly the resolution the booking paths refuse with. A lookup
 * that answers null is a missing event (gone), as from the repo.
 */
export async function resolveBookingEventWith(
  getEvent: (id: string) => Promise<EventRecord | null>,
  args: {
    agreement: Pick<AgreementRecord, "eventId" | "draftEventId"> | null;
    request: Pick<BookingRequestRecord, "originEventId">;
  },
): Promise<BookingEventResolution> {
  const repos = { events: { getById: getEvent } };
  // Event-first: the origin IS the request's event. Dead → refused, before
  // anything else is looked at (owner ruling 2026-10-01: no carve-out).
  const origin = args.request.originEventId
    ? await repos.events.getById(args.request.originEventId)
    : null;
  if (args.request.originEventId && !isLiveBookingEvent(origin)) {
    return { kind: "origin_gone", originEventId: args.request.originEventId };
  }
  if (args.agreement?.eventId) {
    const finalized = await repos.events.getById(args.agreement.eventId);
    return isLiveBookingEvent(finalized)
      ? { kind: "event", event: finalized }
      : { kind: "linked_gone", eventId: args.agreement.eventId };
  }
  if (args.agreement?.draftEventId) {
    const draft = await repos.events.getById(args.agreement.draftEventId);
    if (isLiveBookingEvent(draft)) return { kind: "event", event: draft };
  }
  if (origin) return { kind: "event", event: origin };
  return { kind: "none" };
}

/**
 * EVERY live event this booking points at, not just the one a resolver would
 * pick: the event-first origin, the finalized link and the legacy draft
 * anchor, de-duplicated, in that order. A booking normally has one; when it
 * has more (an origin A live while the terms were finalized to B, or a
 * leftover draft D beside A), "the booking's event" is ambiguous — a path that
 * cancels one would leave the other live on a freed night, so Cancel booking
 * refuses (`failBookingHasMultipleEvents`) before any money moves. Works on
 * the root repos or inside a transaction.
 */
export async function listLiveBookingEvents(
  repos: Pick<Repos, "events">,
  args: {
    agreement: Pick<AgreementRecord, "eventId" | "draftEventId"> | null;
    request: Pick<BookingRequestRecord, "originEventId">;
  },
): Promise<EventRecord[]> {
  const ids = [
    args.request.originEventId ?? null,
    args.agreement?.eventId ?? null,
    args.agreement?.draftEventId ?? null,
  ].filter((id, i, all): id is string => id !== null && all.indexOf(id) === i);
  const live: EventRecord[] = [];
  for (const id of ids) {
    const event = await repos.events.getById(id);
    if (isLiveBookingEvent(event)) live.push(event);
  }
  return live;
}

/**
 * Which party of a request OWNS one of the booking's events (booking-the-night
 * P2c, review round 3 W1): the VENUE side when the owner is one of the
 * place's owners (`isVenueOwnedEvent`), the SENDER when the owner is the
 * request's sender pair (its human, or its org), else NEITHER — a third
 * party's event, which no booking path may link, cancel or refund.
 */
export function bookingEventOwningSide(
  event: Pick<EventRecord, "orgId" | "humanId">,
  place: VenueConfirmationPlaceOwnerFields,
  request: Pick<BookingRequestRecord, "performerOwnerType" | "performerOwnerId">,
): "venue" | "sender" | "neither" {
  if (isVenueOwnedEvent(event, place)) return "venue";
  const ownerType = request.performerOwnerType;
  const ownerId = request.performerOwnerId;
  if (ownerType === "organization" && ownerId !== null && event.orgId === ownerId) {
    return "sender";
  }
  if (ownerType === "human" && ownerId !== null && event.humanId === ownerId) {
    return "sender";
  }
  return "neither";
}

/**
 * EVENT_OWNER_NOT_BOOKING_PARTY — the event belongs to neither the venue side
 * nor the sender pair. Venue side with the agreement and the event; sender
 * side bare.
 */
export function failEventOwnerNotBookingParty(args: {
  side: "venue" | "sender";
  agreementId: string | null;
  eventId: string;
}): never {
  if (args.side === "sender") throw fail("EVENT_OWNER_NOT_BOOKING_PARTY");
  throw fail("EVENT_OWNER_NOT_BOOKING_PARTY", {
    meta: { agreementId: args.agreementId, eventId: args.eventId },
  });
}

/**
 * BOOKING_HAS_MULTIPLE_EVENTS — venue side with the booking and the ids;
 * sender side bare (an act never learns the venue's event ids).
 */
export function failBookingHasMultipleEvents(args: {
  side: "venue" | "sender";
  bookingRequestId: string;
  eventIds: readonly string[];
}): never {
  if (args.side === "sender") throw fail("BOOKING_HAS_MULTIPLE_EVENTS");
  throw fail("BOOKING_HAS_MULTIPLE_EVENTS", {
    meta: {
      bookingRequestId: args.bookingRequestId,
      eventIds: [...args.eventIds],
    },
  });
}

/**
 * The venue-side refusal of a gone event-first origin — the same refusal
 * the link itself raises (`create-event-from-agreement` → `linkOriginEvent`).
 */
export function failOriginGone(args: {
  agreementId: string | null;
  originEventId: string;
}): never {
  throw fail("INVALID_STATUS", {
    message: "event_first_origin_not_live",
    meta: { agreementId: args.agreementId, eventId: args.originEventId },
  });
}

/** The venue-side refusal of a finalized link to a dead event. */
export function failLinkedGone(args: {
  agreementId: string | null;
  eventId: string;
}): never {
  throw fail("INVALID_STATUS", {
    message: "linked_event_not_live",
    meta: { agreementId: args.agreementId, eventId: args.eventId },
  });
}

/**
 * Refuse a booking whose event is gone (see {@link BookingEventResolution}):
 *   - venue side: INVALID_STATUS `event_first_origin_not_live` /
 *     `linked_event_not_live`, with the event;
 *   - sender side, NO meta: EVENT_FIRST_ORIGIN_GONE / LINKED_EVENT_NOT_LIVE.
 * Narrows the resolution to `event | none`.
 */
export function assertBookingEventLive(
  resolved: BookingEventResolution,
  args: { side: "venue" | "sender"; agreementId: string | null },
): asserts resolved is Extract<BookingEventResolution, { kind: "event" | "none" }> {
  if (resolved.kind === "origin_gone") {
    if (args.side === "sender") throw fail("EVENT_FIRST_ORIGIN_GONE");
    failOriginGone({
      agreementId: args.agreementId,
      originEventId: resolved.originEventId,
    });
  }
  if (resolved.kind === "linked_gone") {
    if (args.side === "sender") throw fail("LINKED_EVENT_NOT_LIVE");
    failLinkedGone({ agreementId: args.agreementId, eventId: resolved.eventId });
  }
}

/**
 * Refuse a booking whose event is gone ({@link assertBookingEventLive}) or
 * not on the night's LINE — its day, and (when both are known) its calendar:
 *   - another day — venue side: HOLD_DATE_MISMATCHES_EVENT with the event
 *     and both days; sender side, NO meta: EVENT_ON_ANOTHER_NIGHT;
 *   - the right day on another calendar (P2b review carry d) — venue side:
 *     EVENT_ON_ANOTHER_CALENDAR with the event and both calendars; sender
 *     side, NO meta: EVENT_ON_ANOTHER_NIGHT (an act never learns the venue's
 *     calendar structure, booking-holds FR-013).
 * A line is (calendar, day): booking line (Y, D) while the event sits on
 * calendar X would leave the CONFIRMED hold on one line and the show on
 * another — publish-time settling, the admin overlay and the next booking of
 * (X, D) would all read the night as free. So the calendars must match;
 * the event is not moved, the venue moves it or books the night on its
 * calendar. Skipped when the event has no calendar (a pre-hierarchy row) or
 * the caller has no line yet (`calendarId` null / omitted).
 * No-op when there is no event yet, or it sits on the line.
 */
export function assertBookingEventOnNight(
  resolved: BookingEventResolution,
  args: {
    night: string;
    placeTz: string;
    side: "venue" | "sender";
    agreementId: string | null;
    /** The line's calendar; null / omitted = the day alone is checked. */
    calendarId?: string | null;
  },
): void {
  assertBookingEventLive(resolved, args);
  if (resolved.kind === "none") return;
  const { event } = resolved;
  const eventDate = todayInZone(event.startsAt, args.placeTz);
  if (eventDate !== args.night) {
    if (args.side === "sender") {
      throw fail("EVENT_ON_ANOTHER_NIGHT");
    }
    throw fail("HOLD_DATE_MISMATCHES_EVENT", {
      meta: {
        agreementId: args.agreementId,
        eventId: event.id,
        eventDate,
        holdDate: args.night,
      },
    });
  }
  const eventCalendarId = event.calendarId ?? null;
  if (
    args.calendarId &&
    eventCalendarId !== null &&
    eventCalendarId !== args.calendarId
  ) {
    if (args.side === "sender") {
      throw fail("EVENT_ON_ANOTHER_NIGHT");
    }
    throw fail("EVENT_ON_ANOTHER_CALENDAR", {
      meta: {
        agreementId: args.agreementId,
        eventId: event.id,
        eventCalendarId,
        lineCalendarId: args.calendarId,
        date: args.night,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A cancelled booking (booking-the-night FR-009, N13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when this request's booking was cancelled: one of its holds left the
 * line as BOOKING_CANCELLED (only Cancel booking writes that reason). Derived
 * from the rows, never a stored flag. Such a request stays ACCEPTED as
 * history but is CLOSED for new holds, and its night is never booked again —
 * placement, every take and the exits refuse it (BOOKING_CANCELLED). Callers
 * read `requestHolds` under the request's booking lock.
 */
export function isBookingCancelled(
  requestHolds: readonly Pick<BookingHoldRecord, "status" | "releasedReason">[],
): boolean {
  return requestHolds.some(
    (h) => h.status === "RELEASED" && h.releasedReason === "BOOKING_CANCELLED",
  );
}

/** BOOKING_CANCELLED — no meta on either side (the thread already says so). */
export function failBookingCancelled(): never {
  throw fail("BOOKING_CANCELLED");
}

// ─────────────────────────────────────────────────────────────────────────────
// One booked night per request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This request's CONFIRMED hold on any line OTHER than `key`, or null. A
 * request books one night (runs of nights are out of scope, N17): once a
 * night is booked, booking another one would leave two CONFIRMED holds and an
 * event on only one of them. Callers read `requestHolds` under the locks.
 */
export function otherBookedNight(
  requestHolds: readonly BookingHoldRecord[],
  key: HoldLineKey,
): BookingHoldRecord | null {
  return (
    requestHolds.find(
      (h) => h.status === "CONFIRMED" && lineKeyOf(h) !== lineKeyOf(key),
    ) ?? null
  );
}

/**
 * BOOKING_ALREADY_HAS_NIGHT — no meta on either side: the venue's thread
 * already shows the booked night, and the sender's refusal must carry nothing.
 */
export function failBookingAlreadyHasNight(): never {
  throw fail("BOOKING_ALREADY_HAS_NIGHT");
}

// ─────────────────────────────────────────────────────────────────────────────
// N3 — a night the pitch asked for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when `night` is one the request asked for: the day of one of its
 * preferred dates, or (RENT / USE) a night inside its requested window.
 */
export function isAskedForNight(
  request: Pick<
    BookingRequestRecord,
    "preferredDates" | "requestedStartsAt" | "requestedEndsAt"
  >,
  night: string,
  placeTz: string,
): boolean {
  const preferred = (request.preferredDates ?? []).some(
    (entry) => parsePreferredDateEntry(entry)?.date === night,
  );
  if (preferred) return true;
  if (request.requestedStartsAt && request.requestedEndsAt) {
    const first = bookingNightOf(request.requestedStartsAt, placeTz);
    const last = bookingNightOf(request.requestedEndsAt, placeTz);
    // Lexical order on ISO days is chronological.
    return night >= first && night <= (last < first ? first : last);
  }
  return false;
}

/** DATE_NOT_ASKED_FOR, with the hold and night for the venue's UI. */
export function failDateNotAskedFor(holdId: string, date: string): never {
  throw fail("DATE_NOT_ASKED_FOR", { meta: { holdId, date } });
}

/**
 * The night the venue's "Send terms" defaults to (FR-003): the night this
 * request has already booked, else the earliest night it holds at position 1,
 * else the first night it asked for (its
 * first preferred date, or for RENT / USE the start of its window). Null when
 * the request names no night at all.
 */
export function defaultTermsNight(
  request: Pick<
    BookingRequestRecord,
    "preferredDates" | "requestedStartsAt"
  >,
  requestHolds: readonly BookingHoldRecord[],
  now: Date,
  placeTz: string,
): string | null {
  // A night this request already booked is THE night (one per request).
  const booked = requestHolds.find((h) => h.status === "CONFIRMED");
  if (booked) return booked.date;
  const firstInLine = requestHolds
    .filter(
      (h) =>
        (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(h.status) &&
        h.position === 1 &&
        isHoldLapsed(h, now, placeTz) === null,
    )
    .map((h) => h.date)
    .sort()[0];
  if (firstInLine) return firstInLine;
  const firstPreferred = (request.preferredDates ?? [])
    .map((entry) => parsePreferredDateEntry(entry)?.date ?? null)
    .find((date): date is string => date !== null);
  if (firstPreferred) return firstPreferred;
  return request.requestedStartsAt
    ? bookingNightOf(request.requestedStartsAt, placeTz)
    : null;
}

/** The act's named time on `night`, from a `YYYY-MM-DDTHH:MM` preferred entry. */
export function namedTimeOnNight(
  request: Pick<BookingRequestRecord, "preferredDates">,
  night: string,
): BookingWallClock | null {
  for (const entry of request.preferredDates ?? []) {
    const parts = parsePreferredDateEntry(entry);
    if (parts?.date === night && parts.time) return parts.time;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The send's night check, in the send's own transaction (FR-002, N6)
// ─────────────────────────────────────────────────────────────────────────────

/** The line request-linked terms would book (see `sendBookingAgreementForReview`). */
export type TermsNightCheck = {
  key: HoldLineKey;
  bookingRequestId: string;
  placeTz: string;
  agreementId: string;
  /** The `proposedDate` `key.date` was derived from (re-checked under the lock). */
  expectedProposedDate: Date;
};

/**
 * Takes the night's line lock, re-reads the terms (still DRAFT, still the
 * instant the night came from — else the send's own CAS-loser conflict),
 * then refuses BOOKING_ALREADY_HAS_NIGHT when
 * the request booked another night, and NIGHT_TAKEN (venue side) when another
 * party is ahead on, or has booked, this one. Lapses are projected out, never
 * written, so a refused send writes nothing.
 */
export async function assertTermsNightFreeInTx(
  tx: TxRepos,
  check: TermsNightCheck,
  now: Date,
): Promise<void> {
  await tx.bookingHolds.lockLine(check.key);
  // The terms must still name the instant the night was derived from: a
  // concurrent book-without-terms may have moved a DRAFT header onto the
  // night it booked (review W3). Same conflict shape as a lost send CAS.
  const fresh = await tx.agreements.getById(check.agreementId);
  if (
    !fresh ||
    fresh.status !== "DRAFT" ||
    fresh.proposedDate?.getTime() !== check.expectedProposedDate.getTime()
  ) {
    throw { code: "conflict", message: "agreement_status_changed" } as const;
  }
  // One booked night per request: terms for another night than the one this
  // request already booked could only ever book a second night.
  if (
    otherBookedNight(
      await tx.bookingHolds.listForRequest(check.bookingRequestId),
      check.key,
    )
  ) {
    failBookingAlreadyHasNight();
  }
  // Sequential: one interactive transaction, one connection.
  const live = await tx.bookingHolds.listLine(check.key);
  const confirmed = await tx.bookingHolds.listLine({
    ...check.key,
    statuses: ["CONFIRMED"],
  });
  const night = assessNight({
    line: withoutLapsed(live, now, check.placeTz),
    confirmed,
    bookingRequestId: check.bookingRequestId,
  });
  if (night.kind === "taken") {
    failNightTaken(night, check.key.date);
  }
}
