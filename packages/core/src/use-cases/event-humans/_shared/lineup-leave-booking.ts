import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestActRecord,
  BookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import type { EventStatus } from "@th/ports/repos/events";

import { isUpcomingLiveBookingShow } from "../../booking-agreements/_shared/booking-event-liveness";

// ─────────────────────────────────────────────────────────────────────────────
// "Leaving this lineup also gives up your spot on the booking" — the ONE rule,
// shared by `leaveEventLineup` (which does it) and `listMyLineups` (which
// says so before you confirm).
//
// Owner rulings 2026-09-30 / 2026-10-01: a person who takes themselves off a
// lineup PASSES their act on the booking the show came from — but ONLY while
// the show is upcoming and alive. Once it has started (`startsAt <= now`) or
// is CANCELLED / ARCHIVED, leaving is lineup credit only: the booking record
// is history and is left alone. "Alive" is the booking flow's own predicate
// (`isLiveBookingEvent`) and "started" is the late join's cut-off
// (`findLateJoinTarget`: `startsAt <= now` attaches nothing).
//
// The act: the person's OWN TAGGED act on that bill (read by owner key),
// PENDING or CONFIRMED. A hand-attached person has none; the sender's SELF
// row is never answerable; a passed (DECLINED) or sender-removed act is
// already off the bill.
// ─────────────────────────────────────────────────────────────────────────────

/** The show is upcoming and not dead for booking purposes (lives beside `isLiveBookingEvent`). */
export { isUpcomingLiveBookingShow };

/** A tagged act that has not passed — what a leave would pass. */
export function isPassableAct(
  act: Pick<BookingRequestActRecord, "source" | "confirmation"> | null,
): boolean {
  return (
    act !== null &&
    act.source === "TAGGED" &&
    (act.confirmation === "PENDING" || act.confirmation === "CONFIRMED")
  );
}

/**
 * Batch form for a page of lineups: the event ids (of `events`) where this
 * person leaving WOULD pass their act. At most THREE reads for the whole
 * page, and none when no event on it is an upcoming live show: agreements
 * by linked event (finalized link first, as `findByLinkedEventId`), their
 * requests (TO_VENUE only — the only direction with a bill), the bills.
 */
export async function listEventsWhereLeavePassesAct(
  repos: Pick<Repos, "agreements" | "bookingRequests">,
  humanId: string,
  events: ReadonlyArray<{ eventId: string; status: EventStatus; startsAt: Date }>,
  now: Date,
): Promise<Set<string>> {
  const out = new Set<string>();
  const candidates = [
    ...new Set(
      events
        .filter((event) => isUpcomingLiveBookingShow(event, now))
        .map((event) => event.eventId),
    ),
  ];
  if (candidates.length === 0) return out;

  const agreements = await repos.agreements.findManyByLinkedEventIds(candidates);
  // Finalized link first, then the draft anchor — the single read's order.
  const agreementByEvent = new Map<string, string>();
  for (const eventId of candidates) {
    const agreement =
      agreements.find((a) => a.eventId === eventId) ??
      agreements.find((a) => a.draftEventId === eventId);
    if (agreement) agreementByEvent.set(eventId, agreement.id);
  }
  if (agreementByEvent.size === 0) return out;

  const requests = (
    await repos.bookingRequests.findManyByAgreementIds([
      ...new Set(agreementByEvent.values()),
    ])
  ).filter((request) => request.direction === "TO_VENUE");
  if (requests.length === 0) return out;
  const requestByAgreement = new Map<string, BookingRequestRecord>(
    requests.flatMap((request) =>
      request.agreementId ? [[request.agreementId, request] as const] : [],
    ),
  );

  const passableRequestIds = new Set(
    (
      await repos.bookingRequests.listActsForRequests(
        requests.map((request) => request.id),
      )
    )
      .filter(
        (act) =>
          act.actOwnerType === "human" &&
          act.actOwnerId === humanId &&
          isPassableAct(act),
      )
      .map((act) => act.bookingRequestId),
  );

  for (const [eventId, agreementId] of agreementByEvent) {
    const request = requestByAgreement.get(agreementId);
    if (request && passableRequestIds.has(request.id)) out.add(eventId);
  }
  return out;
}
