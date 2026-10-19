import type { TxRepos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { isLiveBookingEvent } from "../../booking-agreements/create-event-from-agreement";

// ─────────────────────────────────────────────────────────────────────────────
// "Has an event been minted from this request?" — the line after which the
// bill stops being the booking's business and the lineup becomes the EVENT's
// (lineup-booking-requests v2, FR-006). Consent answers
// (`confirm/declineBookingRequestAct`) and the invite read ask it; the mint
// (`createEventFromAgreement`) is the thing that makes it true.
//
// The traversal is the one the inbox stage rail uses (list-booking-requests
// `resolveBookingStages`), in the same precedence:
//   · `originEventId` — an event-first request is ABOUT the event it came
//     from (those carry no bill today, but if one ever does, its lineup is
//     that event's);
//   · `Agreement.eventId` — the finalized link, whatever the event's status:
//     a finalized booking's show is the show, even cancelled;
//   · `Agreement.draftEventId` — the pre-finalize anchor, counted only while
//     the draft is LIVE (`isLiveBookingEvent`). A cancelled / archived draft
//     is exactly the case `createEventFromAgreement` mints over again, and a
//     re-mint reads the bill again — so a dead draft must not freeze it.
// ─────────────────────────────────────────────────────────────────────────────

export type BillEventRequestFields = Pick<
  BookingRequestRecord,
  "agreementId" | "originEventId"
>;

/**
 * The event id this request's bill has flowed (or will flow) into, or null
 * when no live event has been minted from it yet. Pass the TX bag when the
 * answer gates a write (after `bookingRequests.lockBill`), so the read and
 * the write see the same committed state.
 */
export async function findBookingEventForBill(
  repos: Pick<TxRepos, "agreements" | "events">,
  request: BillEventRequestFields,
): Promise<string | null> {
  if (request.originEventId) return request.originEventId;
  if (!request.agreementId) return null;

  const agreement = await repos.agreements.getById(request.agreementId);
  if (!agreement) return null;
  if (agreement.eventId) return agreement.eventId;
  if (!agreement.draftEventId) return null;

  const draft = await repos.events.getById(agreement.draftEventId);
  return isLiveBookingEvent(draft) ? draft.id : null;
}

/**
 * Is this human ACTUALLY on the lineup of the event minted from the request?
 * The line after which an artist's "no" becomes the event editor's call
 * (`judgeActAnswer`): being CONFIRMED on the bill is not enough — an act
 * that confirmed after the mint was never attached, and one the editor took
 * off the lineup is no longer on it; both may still withdraw. One lineup
 * read, and only when an event exists. Pass the TX bag when the answer gates
 * a write (after `bookingRequests.lockBill`).
 */
export async function isHumanOnBookingEventLineup(
  repos: Pick<TxRepos, "agreements" | "events" | "eventHumans">,
  request: BillEventRequestFields,
  humanId: string,
): Promise<boolean> {
  return isActOnBookingEventLineup(repos, request, {
    ownerType: "human",
    ownerId: humanId,
  });
}

/**
 * The other direction: the TO_VENUE booking request whose bill flowed into
 * this event, or null when the event did not come out of a booking with a
 * bill. THE LINK: event → Agreement (`findByLinkedEventId` — the finalized
 * link first, then the pre-finalize draft anchor the mint stamps) → the
 * request whose `agreementId` is that agreement (`findByAgreementId`). There
 * is no `Event.agreementId`. Only TO_VENUE requests carry a bill (NFR-004).
 * Read by the lineup suggestions and by a person leaving the lineup.
 */
export async function findBillRequestForEvent(
  repos: Pick<TxRepos, "agreements" | "bookingRequests">,
  eventId: string,
): Promise<BookingRequestRecord | null> {
  const agreement = await repos.agreements.findByLinkedEventId(eventId);
  if (!agreement) return null;
  const request = await repos.bookingRequests.findByAgreementId(agreement.id);
  return request && request.direction === "TO_VENUE" ? request : null;
}

/** A platform act's identity on a lineup: a person, or (v3 L18) a group. */
export type LineupActOwner = {
  ownerType: "human" | "organization";
  ownerId: string;
};

/**
 * {@link isHumanOnBookingEventLineup} for any platform act — a tagged GROUP
 * (v3 L17/L18) is on the lineup when a row carries its `orgId`. Same single
 * lineup read, same "only when an event exists".
 */
export async function isActOnBookingEventLineup(
  repos: Pick<TxRepos, "agreements" | "events" | "eventHumans">,
  request: BillEventRequestFields,
  owner: LineupActOwner,
): Promise<boolean> {
  const eventId = await findBookingEventForBill(repos, request);
  if (!eventId) return false;
  const lineup = await repos.eventHumans.listByEvent(eventId);
  return lineup.some((row) => lineupRowIsAct(row, owner));
}

/** Does this lineup row BE this act? By `humanId` for a person, `orgId` for a group. */
export function lineupRowIsAct(
  row: { humanId: string | null; orgId?: string | null },
  owner: LineupActOwner,
): boolean {
  return owner.ownerType === "human"
    ? row.humanId === owner.ownerId
    : (row.orgId ?? null) === owner.ownerId;
}
