/**
 * WHO counts as an ACTIVE holder for the holder-address gate
 * (`resolveHolderAddress`'s `activeHolder` input). One module so every holder
 * surface asks the same question the same way (H2 / M1, 2026-09-25).
 *
 * The gate itself cannot decide this: it has no order, ticket, RSVP or signup
 * in hand. What it CAN do is refuse the address to anyone the surface does
 * not vouch for, and it does: `activeHolder` is a required input and anything
 * but `true` locks a gated address (`notHolder`).
 *
 * Why it matters: before this, the order page checked only "is this your
 * order". A checkout writes a PENDING order before payment, so an unpaid
 * checkout, a self-refund, a ticket transferred away, or a pending resale all
 * kept printing the street once the reveal passed. A volunteer whose
 * application was still PENDING (or REJECTED, or WITHDRAWN) got it too.
 */

import type { Repos } from "@th/ports/repos";
import type { EventDateStatus } from "@th/types";
import type { EventStatus } from "@th/types/repos/events";

/**
 * Order statuses whose buyer may see the address: paid and not fully
 * refunded. DISPUTED stays in: the buyer still holds the ticket while the
 * bank decides, and the dispute evidence names the address only when the
 * buyer would see it. PENDING / PROCESSING (not paid), REFUNDED and
 * CANCELLED are out.
 */
export const ACTIVE_HOLDER_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "SUCCEEDED",
  "PART_REFUNDED",
  "DISPUTED",
]);

export function isActiveHolderOrderStatus(
  status: string | null | undefined,
): boolean {
  return typeof status === "string" && ACTIVE_HOLDER_ORDER_STATUSES.has(status);
}

/**
 * Ticket statuses that still admit their owner. The SAME set the tickets
 * adapter gates `hasActiveTicketForEvent` / `activeTicketHolderHumanIds` on
 * (VALID | SCANNED | LISTED): a ticket listed for resale is still its owner's
 * until it sells.
 */
export const ACTIVE_TICKET_STATUSES: ReadonlySet<string> = new Set([
  "VALID",
  "SCANNED",
  "LISTED",
]);

export function isActiveTicketStatus(
  status: string | null | undefined,
): boolean {
  return typeof status === "string" && ACTIVE_TICKET_STATUSES.has(status);
}

/**
 * Volunteer signup statuses that may receive the address: accepted
 * (APPROVED) or already at the door (CHECKED_IN). PENDING, REJECTED,
 * WITHDRAWN, NO_SHOW and anything added later get none: the gate fails
 * closed on an unrecognised status.
 */
export const ADDRESS_ELIGIBLE_VOLUNTEER_STATUSES: ReadonlySet<string> = new Set(
  ["APPROVED", "CHECKED_IN"],
);

export function volunteerMayReceiveAddress(
  status: string | null | undefined,
): boolean {
  return (
    typeof status === "string" &&
    ADDRESS_ELIGIBLE_VOLUNTEER_STATUSES.has(status)
  );
}

/**
 * The status half of an RSVP-er's claim to the street, for a surface that
 * already holds the RSVP row (list-my-rsvps, the RSVP reminders) and so
 * needs no existence read. The RSVP confirmation is sent only for a PUBLISHED
 * event and a SCHEDULED night, so its own guards already apply this rule. `viewerHoldsLiveRsvp` asks the
 * same question for a viewer it has to look up.
 *
 * The event's status must be on `RSVP_RELEASING_STATUSES` (DRAFT, PUBLISHED,
 * COMPLETED). Everything else releases nothing, and so does an unknown or
 * missing status: the rule fails closed.
 *
 * - A CANCELLED event releases nothing: cancelling the event keeps the RSVP
 *   rows, while its ticket holders lose the street with their refunded or
 *   invalidated tickets ("like holders", owner ruling Q16, 2026-10-17).
 * - An ARCHIVED event releases nothing either. Archiving a cancelled event
 *   (CANCELLED -> ARCHIVED) keeps the RSVP rows and must not hand the street
 *   back, and archiving a PUBLISHED community listing directly counts as
 *   cancelling it (owner ruling 2026-10-16: its RSVP-ers get event.cancelled).
 * - A per-night RSVP (`dateStatus` given) counts only on a SCHEDULED night:
 *   a called-off night keeps its RSVP rows, and those are not attendance.
 *   An unknown night status fails closed.
 */
export const RSVP_RELEASING_STATUSES: ReadonlySet<EventStatus> =
  new Set<EventStatus>(["DRAFT", "PUBLISHED", "COMPLETED"]);

export function rsvpMayReceiveAddress(args: {
  eventStatus: EventStatus | null | undefined;
  dateStatus?: EventDateStatus;
}): boolean {
  if (args.eventStatus == null) return false;
  if (!RSVP_RELEASING_STATUSES.has(args.eventStatus)) return false;
  if (args.dateStatus !== undefined && args.dateStatus !== "SCHEDULED") {
    return false;
  }
  return true;
}

/**
 * Whether the viewer holds a LIVE RSVP for the event: an RSVP-er counts as a
 * ticket holder for `resolveHolderAddress`'s `activeHolder` (arrival-areas
 * owner rulings Q4 and Q16, 2026-10-17: "like holders"). The one predicate
 * for every viewer-facing RSVP check: the event page's street
 * (`getEventSeo`) and its arrival areas (`resolveEventAreaAccess`).
 * list-my-rsvps and the reminders start from the RSVP row they are about, so
 * the row exists; they ask the status half of this test through
 * `rsvpMayReceiveAddress`, the same check this function makes.
 *
 * Cancelling an RSVP DELETES the row, and an RSVP has no other state. For a
 * recurring listing's per-night RSVP: a row on a SCHEDULED night (a
 * called-off night keeps its RSVP rows, and those are not attendance). An
 * RSVP for a past SCHEDULED night keeps counting on purpose, as a ticket
 * does after its show.
 *
 * The event's status must be on `RSVP_RELEASING_STATUSES` (DRAFT, PUBLISHED,
 * COMPLETED; the rule `rsvpMayReceiveAddress` documents). A CANCELLED or
 * ARCHIVED event releases nothing to RSVP-ers ("like holders": a cancelled
 * event's tickets are refunded or invalidated, so its holders lose the
 * street, and archiving keeps the RSVP rows). The status check lives here,
 * and no row is read for an event off the list.
 *
 * `known.eventRsvpExists`: a caller that has already read
 * `eventRsvps.existsForUser` for this viewer and event passes the answer
 * instead of paying for the same read twice.
 */
export async function viewerHoldsLiveRsvp(
  repos: Pick<Repos, "eventRsvps" | "eventDateRsvps">,
  event: { id: string; status: EventStatus },
  humanId: string,
  known: { eventRsvpExists?: boolean } = {},
): Promise<boolean> {
  if (!rsvpMayReceiveAddress({ eventStatus: event.status })) return false;
  const eventId = event.id;
  const eventRsvpExists =
    known.eventRsvpExists ?? (await repos.eventRsvps.existsForUser({ eventId, humanId }));
  if (eventRsvpExists) return true;
  return repos.eventDateRsvps.existsForUserOnEvent({
    eventId,
    humanId,
    dateStatus: "SCHEDULED",
  });
}
