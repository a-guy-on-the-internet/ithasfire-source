import type { TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";

import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";

// ─────────────────────────────────────────────────────────────────────────────
// The EVENT leg of the booking timeline — "the booking request is the timeline
// of the event."
//
// "…then we get to see the event get created or modified and it gets logged
// into that booking request." The event use cases (save / publish / cancel /
// complete) have no idea they are touching a booked show, so this module is
// the bridge: look the thread up through the reverse link and append the
// entry — inside the transition's OWN transaction, so the entry and the row
// it describes commit together.
//
// Four emitters live here, one per transition that changes what a
// counterparty is entitled to know:
//   · `appendBookingEventModifiedEntry`  — save path (diff-gated, see below)
//   · `appendBookingEventPublishedEntry` — `publishEvent`
//   · `appendBookingEventCancelledEntry` — `cancelEvent`
//   · `appendBookingEventCompletedEntry` — `completeEvent` (+ FULFILLED)
// All four are SILENT for an event that never came from a booking: no throw,
// no write, no touch on any other event.
//
// COST ON A NORMAL SAVE. The lookup is skipped entirely unless something in the
// tracked set actually changed, which already rules out every CREATE (nothing
// to diff against) and every no-op save. When it does run it is
// `agreements.findByLinkedEventId` — ONE unique-index probe on
// `Agreement.eventId` for a finalized booking, TWO for a pre-finalize draft
// (the `draftEventId` fallback runs only on a miss; port contract) — plus ONE
// unique-index probe on `BookingRequest.agreementId` when an agreement is
// found. So an ordinary event that never came from a booking costs 2 indexed
// point lookups on a changing save and ZERO on everything else. No scans, no
// loops. The reverse lookup is reused rather than reinvented: there is no
// `Event.agreementId` column to read.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fields a booking counterparty is entitled to see move.
 *
 * NARROWED FROM THE STEP-1 PLACEHOLDER. `changedFields` is bounded free text in
 * the ledger schema only because the save surface was unknown then; this is the
 * real, closed set, derived from what `finalizeSaveEvent` can actually change:
 *
 *   - `title`      — what the show is called;
 *   - `startsAt` / `endsAt` — the date/time, the thing a booking IS;
 *   - `location`   — the venue link (`placeId`) or the address row
 *                    (`savedLocationId`) it hangs off;
 *   - `calendar` / `space` — the venue-hierarchy placement (which programming
 *                    stream, which physical room);
 *   - `timezone`   — changes every wall-clock the other side reads.
 *
 * DELIBERATELY ABSENT: `status` (the save path re-persists
 * `existingEvent.status` verbatim — publish/cancel/archive are their own use
 * cases and are not this surface) and capacity (no capacity field exists on the
 * event save at all; it lives on ticket types). Adding either here without the
 * transition that produces it would put a field on the ledger nothing can ever
 * set.
 */
export const BOOKING_TRACKED_EVENT_FIELDS = [
  "title",
  "startsAt",
  "endsAt",
  "location",
  "calendar",
  "space",
  "timezone",
] as const;

export type BookingTrackedEventField =
  (typeof BOOKING_TRACKED_EVENT_FIELDS)[number];

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * Which tracked fields this save actually moved. Empty array = a no-op save,
 * which must write NOTHING (a ledger that logs "the event was modified" every
 * time somebody opens and closes the editor is noise, not history).
 *
 * `spaceId` / `calendarId` are OPTIONAL on `EventRecord` ("absent reads as
 * null" — the port doc), so both sides are normalized with `?? null` before
 * comparing; a projection that omits the key can never masquerade as a clear.
 *
 * CALLERS: `next.savedLocationId` must be the value the row ends the save
 * with, NOT `upsertDraft`'s return value — those disagree on every freeform
 * save. `appendBookingEventModifiedEntry` takes it as an explicit argument for
 * exactly that reason; see its `nextSavedLocationId` doc.
 */
export function diffBookingTrackedEventFields(
  previous: EventRecord,
  next: EventRecord,
): BookingTrackedEventField[] {
  const changed: BookingTrackedEventField[] = [];

  if (previous.title !== next.title) changed.push("title");
  if (!sameInstant(previous.startsAt, next.startsAt)) changed.push("startsAt");
  if (!sameInstant(previous.endsAt, next.endsAt)) changed.push("endsAt");
  if (
    previous.placeId !== next.placeId ||
    previous.savedLocationId !== next.savedLocationId
  ) {
    changed.push("location");
  }
  if ((previous.calendarId ?? null) !== (next.calendarId ?? null)) {
    changed.push("calendar");
  }
  if ((previous.spaceId ?? null) !== (next.spaceId ?? null)) {
    changed.push("space");
  }
  if (previous.timezone !== next.timezone) changed.push("timezone");

  return changed;
}

/**
 * Append `booking_event.modified` to the ledger of the booking request this
 * event traces back to, when there is one and when something tracked changed.
 *
 * MUST be called from inside the save's own `repos.tx()` — same rule as every
 * other emitter (`appendBookingSystemEntry`'s doc): the entry and the event row
 * it describes commit or roll back together.
 *
 * `previousStartsAt` / `nextStartsAt` are always both populated when the start
 * moved and both null otherwise, because "moved from Fri 8pm to Sat 9pm" is the
 * one change the copy renders as a before/after.
 *
 * `nextSavedLocationId` IS REQUIRED, and is not a duplicate of
 * `next.savedLocationId` — see its own doc below.
 */
export async function appendBookingEventModifiedEntry(
  tx: TxRepos,
  args: {
    previous: EventRecord;
    /**
     * The row the save just persisted — `EventsRepo.upsertDraft`'s return
     * value, which the save path never re-reads.
     */
    next: EventRecord;
    /**
     * The event's savedLocationId AFTER the whole save, not the value on
     * `next`. These differ, and silently: on a freeform-address save the
     * adapter's update path resets `savedLocationId` to null in its base
     * `data` and only re-sets it for `location.kind === "saved-location"`, so
     * `next.savedLocationId` comes back NULL for freeform. The real link is
     * applied AFTERWARDS by `tx.events.linkSavedLocation`, which does not
     * refresh `next`.
     *
     * Reading `next.savedLocationId` therefore made the diff report
     * `"location"` on EVERY save of a freeform-located booked event — the
     * previous save's SavedLocation vs a null that only means "not selected
     * back". A parameter rather than a spread at the call site on purpose: the
     * coupling is stated in the signature, so it survives a refactor that
     * would happily drop an inline `{ ...created, savedLocationId }` object.
     * The tax stamp immediately above the call site compensates for the same
     * staleness the same way (`freeformSavedLocationId ?? created.savedLocationId`).
     */
    nextSavedLocationId: string | null;
    actorHumanId: string;
    /**
     * The thread to record on when the event has NO agreement thread
     * (`findBookingThreadForEvent` misses) — place-address-withholding N1.
     * The save passes the booking request a venue CONFIRMATION came from
     * (`venueConfirmationRequestId`) only when a third party moved that
     * confirmed show earlier than the date the venue vouched for, so the
     * venue sees the move on the request it answered. Null / absent = no
     * fallback (the long-standing behaviour). Ignored for a request at
     * another place than the event's.
     */
    fallbackBookingRequestId?: string | null;
  },
): Promise<void> {
  const next: EventRecord = {
    ...args.next,
    savedLocationId: args.nextSavedLocationId,
  };
  const changedFields = diffBookingTrackedEventFields(args.previous, next);
  // Diff FIRST: a no-op save must not write an entry, and must not pay for the
  // reverse lookup either.
  if (changedFields.length === 0) return;

  const thread = await findBookingThreadForEvent(tx, next.id);
  const bookingRequestId =
    thread?.bookingRequest.id ??
    (await fallbackThreadRequestId(tx, next, args.fallbackBookingRequestId));
  if (!bookingRequestId) return;

  const startMoved = changedFields.includes("startsAt");

  await appendBookingSystemEntry(tx, {
    bookingRequestId,
    kind: "booking_event.modified",
    data: {
      eventId: next.id,
      changedFields,
      // ISO STRINGS, never Dates — `systemData` is a Json column (see the
      // schema doc): a Date validates on write and fails on read.
      previousStartsAt: startMoved
        ? args.previous.startsAt.toISOString()
        : null,
      nextStartsAt: startMoved ? next.startsAt.toISOString() : null,
    },
    actorHumanId: args.actorHumanId,
  });
}

/**
 * The fallback thread for {@link appendBookingEventModifiedEntry}: the named
 * booking request, when it still exists AND is about the event's own place
 * (a stale id from another venue must never receive this venue's entry).
 */
async function fallbackThreadRequestId(
  tx: Pick<TxRepos, "bookingRequests">,
  event: Pick<EventRecord, "placeId">,
  requestId: string | null | undefined,
): Promise<string | null> {
  if (!requestId || !event.placeId) return null;
  const request = await tx.bookingRequests.getById(requestId);
  return request && request.placeId === event.placeId ? request.id : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reverse lookup + lifecycle emitters.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingThreadForEvent = {
  agreement: AgreementRecord;
  bookingRequest: BookingRequestRecord;
};

/**
 * The booking thread an event traces back to, or null.
 *
 * There is no `Event.agreementId` column, so this walks the link backwards:
 * `Agreement.eventId` (unique; `draftEventId` fallback on a miss — port
 * contract) → `BookingRequest.agreementId` (unique). At most three indexed
 * point lookups, no scans. Null on either miss: an event that never came
 * from a booking (the common case), or an agreement minted outside the inbox
 * with no thread behind it.
 *
 * Reads through `tx` so callers inside a transaction see their own writes and
 * the agreement they act on is the one that commits with them.
 */
export async function findBookingThreadForEvent(
  tx: Pick<TxRepos, "agreements" | "bookingRequests">,
  eventId: string,
): Promise<BookingThreadForEvent | null> {
  const agreement = await tx.agreements.findByLinkedEventId(eventId);
  if (!agreement) return null;

  const bookingRequest = await tx.bookingRequests.findByAgreementId(
    agreement.id,
  );
  if (!bookingRequest) return null;

  return { agreement, bookingRequest };
}

/** ISO string for the Json column, or null when the record carries no usable start. */
function isoOrNull(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
}

/**
 * `booking_event.published` — the show is live and selling. Call from inside
 * `publishEvent`'s own `repos.tx()`, after `tx.events.publish`.
 */
export async function appendBookingEventPublishedEntry(
  tx: TxRepos,
  args: { event: Pick<EventRecord, "id" | "startsAt">; actorHumanId: string },
): Promise<void> {
  const thread = await findBookingThreadForEvent(tx, args.event.id);
  if (!thread) return;

  await appendBookingSystemEntry(tx, {
    bookingRequestId: thread.bookingRequest.id,
    kind: "booking_event.published",
    data: { eventId: args.event.id, startsAt: isoOrNull(args.event.startsAt) },
    actorHumanId: args.actorHumanId,
  });
}

/**
 * `booking_event.cancelled` — the arc ends. Call from inside `cancelEvent`'s
 * own `repos.tx()`, after `tx.events.cancel`. The agreement's status is NOT
 * touched here: `Agreement.CANCELLED` is a negotiation outcome with its own
 * (unbuilt) transition, and inferring it from an event cancel would put a
 * status on the row nothing else can explain.
 */
export async function appendBookingEventCancelledEntry(
  tx: TxRepos,
  args: { eventId: string; actorHumanId: string },
): Promise<void> {
  const thread = await findBookingThreadForEvent(tx, args.eventId);
  if (!thread) return;

  await appendBookingSystemEntry(tx, {
    bookingRequestId: thread.bookingRequest.id,
    kind: "booking_event.cancelled",
    data: { eventId: args.eventId },
    actorHumanId: args.actorHumanId,
  });
}

/**
 * `booking_event.completed`, then — when the agreement is ACCEPTED AND
 * FINALIZED onto this event (`agreement.eventId === eventId`, never the
 * `draftEventId` anchor) — ACCEPTED → FULFILLED plus
 * `booking_agreement.fulfilled`. Call from inside `completeEvent`'s own
 * `repos.tx()`, after `tx.events.complete`.
 *
 * WHY "EVENT COMPLETED" IS THE FULFILLED TRIGGER. Money is settled per PAYEE
 * on the ledger, not per event, so there is no "this event's money cleared"
 * moment to hang FULFILLED on — and there never will be one that a single
 * event can own. What the two parties actually agreed to was a SHOW; the show
 * happening is the honest, observable point at which the agreement was
 * fulfilled. This is the ONLY writer of `AgreementStatus.FULFILLED`.
 *
 * ORDER IS LOAD-BEARING: the event entry is appended before the agreement
 * entry so the thread reads cause → effect. (Both share the tx's
 * `createdAt`; the ledger's `[createdAt asc, id asc]` order then falls
 * through to id, so the order is best-effort — the same caveat
 * `booking_agreement.drafted` documents.)
 *
 * CAS, not a blind write: `updateStatus({ expectedFrom: ["ACCEPTED"] })`
 * throws `conflict` on a 0-match, which rolls the whole complete back. That
 * is the wanted outcome — the agreement moved under us (a concurrent
 * cancel/dispute), and completing the event over it would record an
 * agreement state the ledger contradicts. The caller retries and re-reads.
 * An agreement in any state other than ACCEPTED (already FULFILLED on a
 * replay, DECLINED, CANCELLED, …), or one reached only through its draft
 * anchor, is left alone: only the event entry is written.
 */
export async function appendBookingEventCompletedEntry(
  tx: TxRepos,
  args: { eventId: string; actorHumanId: string; now: Date },
): Promise<void> {
  const thread = await findBookingThreadForEvent(tx, args.eventId);
  if (!thread) return;

  await appendBookingSystemEntry(tx, {
    bookingRequestId: thread.bookingRequest.id,
    kind: "booking_event.completed",
    data: { eventId: args.eventId },
    actorHumanId: args.actorHumanId,
  });

  // FULFILLED REQUIRES THE FINALIZED LINK, not just ACCEPTED. The reverse
  // lookup also resolves through the DRAFT ANCHOR (`draftEventId`, port
  // contract), which is the state a booked event spends most of its life
  // in: minted as a DRAFT under the anchor with `eventId` still NULL while
  // finalize stays blocked on payout readiness. An anchored-but-unlinked
  // draft can still reach COMPLETED: a VENUE-owned draft publishes without
  // finalize (publish auto-provisions default terms), and a requester-owned
  // one — refused at publish with BOOKING_TERMS_NOT_FINALIZED until
  // finalized — is only ever completed once the link exists anyway. Writing
  // FULFILLED off the draft anchor would leave a dead row:
  // createEventFromAgreement throws AGREEMENT_NOT_ACCEPTED, finalize's
  // `expectedFrom: ["ACCEPTED"]` never matches, reopen refuses, and
  // NegotiationBar shows a read-only notice on terms nobody activated. So:
  // the show is recorded regardless; the agreement is fulfilled only when it
  // was actually finalized onto THIS event (`eventId`, never the anchor).
  if (
    thread.agreement.status !== "ACCEPTED" ||
    thread.agreement.eventId !== args.eventId
  ) {
    return;
  }

  await tx.agreements.updateStatus({
    id: thread.agreement.id,
    status: "FULFILLED",
    expectedFrom: ["ACCEPTED"],
    fulfilledAt: args.now,
  });

  await tx.audit.log({
    entity: "booking_agreement",
    entityId: thread.agreement.id,
    action: "booking_agreement.fulfilled",
    data: { actorHumanId: args.actorHumanId, eventId: args.eventId },
    at: args.now,
  });

  await appendBookingSystemEntry(tx, {
    bookingRequestId: thread.bookingRequest.id,
    kind: "booking_agreement.fulfilled",
    data: { agreementId: thread.agreement.id },
    actorHumanId: args.actorHumanId,
  });
}
