import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { getBookingRequestSender } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { describeVenueConfirmationState } from "../../lib/venue-confirmation";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getEventProvenanceInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
  })
  .strict();

/**
 * Which link column anchored the agreement to the event. The venue reads these
 * very differently — a DRAFT_EVENT link means "minted from the booking but the
 * payout terms were never finalized onto it" — so the caller is told rather
 * than left to infer it from a field it cannot see.
 */
export const eventProvenanceLinkSchema = z.enum(["EVENT", "DRAFT_EVENT"]);

export const getEventProvenanceOutputSchema = z
  .object({
    agreement: z
      .object({
        id: z.string().uuid(),
        status: z.enum([
          "DRAFT",
          "PROPOSED",
          "COUNTERED",
          "ACCEPTED",
          "DECLINED",
          "CANCELLED",
          "FULFILLED",
          "EXPIRED",
          "DISPUTED",
        ]),
        linkedVia: eventProvenanceLinkSchema,
        /**
         * The agreed terms, read straight off the agreement row so the event
         * editor's read-only "Booking" panel and the agreement page can never
         * disagree. Same encodings as `getBookingAgreement` exposes them:
         * `Date | null` for the dates, integer cents or null for the
         * guarantee.
         */
        title: z.string(),
        proposedDate: z.date().nullable(),
        proposedEndDate: z.date().nullable(),
        guaranteeCents: z.number().int().nullable(),
        /**
         * How many payout lines the agreement's terms carry — enough for the
         * panel to say "3 payout lines" without shipping the lines
         * themselves (the agreement page owns that). 0 when the agreement has
         * no PayoutTerms yet (`payoutTermsId` null) — no read is made.
         */
        payoutLineCount: z.number().int().nonnegative(),
      })
      .strict()
      /**
       * NULL for an EVENT-FIRST event (venue-confirmation spec, "Two entry
       * paths, one request"): the builder's save created the booking
       * request the venue confirms, and no agreement exists until the venue
       * accepts. `bookingRequest` is the populated leg in that shape.
       */
      .nullable(),
    /**
     * The originating thread. Reached one of two ways — through the
     * agreement (request-first: `BookingRequest.agreementId`), or, when the
     * event has no agreement, by origin (event-first:
     * `BookingRequest.originEventId === eventId`). NULL when the agreement
     * exists but no booking request points at it — either the agreement was
     * authored outside the booking flow, or the request's `agreementId` was
     * SetNull'd when the agreement row it referenced was deleted. A normal
     * outcome, not a failure: the breadcrumb degrades to "this event has an
     * agreement" instead of vanishing entirely. Never null when `agreement`
     * is null (that shape is the top-level `null` instead).
     */
    bookingRequest: z
      .object({
        id: z.string().uuid(),
        status: z.enum([
          "PENDING",
          "VIEWED",
          "ACCEPTED",
          "DECLINED",
          "WITHDRAWN",
          "EXPIRED",
        ]),
        /**
         * TO_VENUE — an act pitched this venue; TO_PERFORMER — an organizer
         * asked this act. The sentence a UI renders differs by direction, so
         * it must not have to guess.
         */
        direction: z.enum(["TO_VENUE", "TO_PERFORMER"]),
        /**
         * The ACT's display name, resolved exactly the way
         * `listBookingRequests` resolves `performerDisplayName` — the
         * human/org name for an owned sender, the submitted `contactName` for
         * an anonymous embed inquiry — so the breadcrumb and the inbox never
         * disagree about who this is. Null when the owner no longer resolves
         * (or has no name), and null for a corrupt row (see the swallow in
         * `resolveSenderDisplayName`).
         *
         * DELIBERATELY NOT `actName`: that is pitch copy the sender typed, and
         * the inbox does not display it here either.
         */
        senderDisplayName: z.string().nullable(),
        /**
         * Thread recency. NOT "last message" — `appendBookingSystemEntry`
         * bumps this column for every SYSTEM ledger entry too, so merely
         * viewing the request or re-saving the event moves it. The one UI
         * that consumes it says "Last activity" for exactly that reason;
         * don't reword either side back to "message".
         */
        lastMessageAt: z.date().nullable(),
        // ── Venue-confirmation leg (event-first builder band) ──────────────
        // Read off the same request row for BOTH chains, so the agreement
        // breadcrumb and the builder band never disagree about the ask.
        /** What the request asks the venue for. */
        intent: z.enum(["PERFORM", "RENT", "USE"]),
        /**
         * The venue the request went to. Null for a TO_PERFORMER row (an
         * organizer asking an act — there is no venue side).
         */
        placeId: z.string().uuid().nullable(),
        /** Denormalized on the request row; null when it never had a venue. */
        placeName: z.string().nullable(),
        /**
         * The venue had not claimed its page when the request was sent, and
         * still has not (`parkedUnclaimedAt` set) — the builder says "we've
         * asked them to claim" instead of "sent for confirmation".
         */
        parked: z.boolean(),
      })
      .strict()
      .nullable(),
    /**
     * Where the venue's vouch for THIS event stands (venue-confirmation
     * spec, docs/specs/2026-08-27 "Requester's admin"). The editor's one
     * consumer renders "Confirmed by {place}. Finish the details and publish
     * when ready." on a REQUESTER-owned, confirmed event — so the payload
     * carries the state, whose event it is, and the place's name. `none` =
     * the event has no place (nothing to be confirmed at); `placeName` is
     * null when the place row is gone.
     */
    venueConfirmation: z
      .object({
        state: z.enum(["none", "confirmed", "withdrawn", "unconfirmed"]),
        ownerSide: z.enum(["place", "requester"]).nullable(),
        placeName: z.string().nullable(),
      })
      .strict(),
  })
  .strict()
  .nullable();

export type GetEventProvenanceInput = z.infer<
  typeof getEventProvenanceInputSchema
>;
export type GetEventProvenanceOutput = z.infer<
  typeof getEventProvenanceOutputSchema
>;
export type EventProvenanceLink = z.infer<typeof eventProvenanceLinkSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetEventProvenanceDeps = {
  /**
   * Full repo bag: the gate is the shared `ensureActorCanEditEvent`, which
   * takes `TxRepos` (= `Omit<Repos, "tx">`). Reusing the canonical helper is
   * worth the wider dep type — a hand-mirrored copy of the event-edit rule is
   * exactly how two surfaces drift apart on who may read what.
   */
  repos: Repos;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for this use case's two deliberate swallows: a
   * corrupt booking-request row (sender-invariant violation) degrading the
   * display name to null, and the cross-aggregate backstop dropping a
   * provenance chain that does not re-derive back to this event. Both are
   * invisible-by-design in the UI, which is precisely why they must be
   * visible to operators. Guarded at every call site — a throwing reporter
   * never changes the result.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Where did this event come from?" — the INVERSE of the booking chain.
 *
 * Forward, the chain is well travelled: a booking request is accepted
 * (`respondToBookingRequest` mints the `Agreement`), and the venue turns the
 * agreement into an event (`createEventFromAgreement` stamps
 * `Agreement.draftEventId`, then `finalizeBookingAgreement` stamps
 * `Agreement.eventId`). Backwards there was nothing: from an event you could
 * not reach the conversation that produced it, even though that thread stays
 * live and *is* the event's history.
 *
 * NOTE ON THE SCHEMA (it reads the other way round from how you'd guess):
 * `Event` carries NO `agreementId` column. The links live on the other side —
 * `Agreement.eventId` / `Agreement.draftEventId` (both unique, both
 * `onDelete: SetNull`) and `BookingRequest.agreementId` (unique,
 * `onDelete: SetNull`). So this read walks event → agreement → request via
 * two reverse lookups, and every hop is nullable.
 *
 * Returns NULL for the common case: most events were never booked through a
 * request, so there is neither an agreement anchored on them nor a request
 * that names them as origin. That is an ordinary answer, NOT a swallowed
 * failure — no report, no log noise.
 *
 * TWO CHAINS, ONE OUTPUT. Request-first (the venue accepted a pitch and
 * minted the event): event → agreement → request. Event-first (the builder
 * named a venue it does not own and the save created the request the venue
 * confirms — venue-confirmation spec, "Two entry paths, one request"):
 * event → request by `originEventId`, no agreement until the venue accepts.
 * The second is consulted ONLY when the first finds no agreement, so an
 * accepted event-first request (which by then has an agreement anchored on
 * the event) reads through the agreement like any other.
 *
 * AUTHORIZATION — mirrors the event admin read path exactly. The gate is the
 * shared `ensureActorCanEditEvent` (`_shared/ensure-actor-can-edit-event.ts`),
 * the same helper behind `getEventApplicationForm`,
 * `listEventApplicationSubmissions`, `updateEventSettings` and the rest of the
 * event admin surface: `ORG_EDIT_ROLES` membership for an org event, the owner
 * human for a human event, and COMMUNITY-stewardship listings refused
 * outright. Whoever may administer the event sees its provenance; nobody else
 * does. No new authorization rule is introduced here.
 *
 * PERFORMER-SIDE VISIBILITY IS DELIBERATELY OUT (known limit, not an
 * oversight). The booked act cannot read this. Three reasons: (1) they lose
 * nothing — the act already reaches the same thread through their sent list
 * (`listBookingRequests` scope "performer") and the agreement as a party
 * (`getBookingAgreement`); (2) the only surface this feeds is the event admin
 * editor, which the act cannot open at all, so an act-shaped grant here would
 * be a read path to nowhere; (3) the only event-side handle on "the act" is
 * the `EventHuman` lineup row, which is free-text-or-humanId and is EDITABLE
 * BY THE VENUE — making it an authz subject would let a venue grant or revoke
 * someone's read access by retyping a name. If an act-facing view is wanted
 * later, the right shape is an AGREEMENT-scoped read gated on agreement party,
 * not an event-scoped one.
 *
 * Query budget (bounded, no loops): the gate's `events.getById` +
 * `authz.getOrgMembership` (org events only), one
 * `agreements.findByLinkedEventId` (1–2 unique-index lookups — see its port
 * doc), one `bookingRequests.findByAgreementId` (or, with no agreement, one
 * `bookingRequests.findByOriginEventId` instead), at most ONE
 * `payoutTerms.listLines` (only when the agreement has a `payoutTermsId`),
 * at most ONE name lookup (`humans.getById` XOR `organizations.getById`)
 * for an owned sender, and ONE `places.getById` when the event has a place
 * (the venue-confirmation stance).
 */
export async function getEventProvenance(
  deps: GetEventProvenanceDeps,
  rawInput: unknown,
): Promise<GetEventProvenanceOutput> {
  const input = parseInput(getEventProvenanceInputSchema, rawInput);

  // GATE FIRST — before a single provenance row is read. Ordering is
  // load-bearing, not stylistic: the agreement and the booking request hang
  // off a DIFFERENT aggregate than the event, so any read that happens before
  // the event-edit check is a read an unauthorized actor caused.
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );

  const agreement = await deps.repos.agreements.findByLinkedEventId(event.id);
  if (!agreement) {
    return resolveEventFirstProvenance(deps, event);
  }

  const request = await deps.repos.bookingRequests.findByAgreementId(
    agreement.id,
  );

  // CROSS-AGGREGATE BACKSTOP — see `describeProvenanceMismatch`. A chain that
  // does not re-derive back to this event is dropped, never rendered.
  const mismatch = describeProvenanceMismatch(event, agreement, request);
  if (mismatch) {
    deps.logger?.error("events.provenance.foreign_chain_dropped", {
      eventId: event.id,
      agreementId: agreement.id,
      bookingRequestId: request?.id ?? null,
      reason: mismatch,
    });
    try {
      deps.reportError?.(new Error("events.provenance.foreign_chain_dropped"), {
        tags: { useCase: "getEventProvenance", step: "crossAggregateAssert" },
        extra: {
          eventId: event.id,
          eventOrgId: event.orgId ?? null,
          eventHumanId: event.humanId ?? null,
          eventPlaceId: event.placeId ?? null,
          agreementId: agreement.id,
          bookingRequestId: request?.id ?? null,
          reason: mismatch,
        },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // drop-the-foreign-chain backstop into a thrown error.
    }
    return null;
  }

  // NOT swallowed, on purpose — same rule as the name lookups below: a
  // lines read that throws means the store is unhealthy, and a confident
  // "0 payout lines" is worse than an error for a panel about money.
  const payoutLineCount = agreement.payoutTermsId
    ? (await deps.repos.payoutTerms.listLines(agreement.payoutTermsId)).length
    : 0;

  return getEventProvenanceOutputSchema.parse({
    agreement: {
      id: agreement.id,
      status: agreement.status,
      linkedVia: agreement.eventId === event.id ? "EVENT" : "DRAFT_EVENT",
      title: agreement.title,
      proposedDate: agreement.proposedDate,
      proposedEndDate: agreement.proposedEndDate,
      guaranteeCents: agreement.guaranteeCents,
      payoutLineCount,
    },
    bookingRequest: request ? await toBookingRequestLeg(deps, request) : null,
    venueConfirmation: await resolveVenueConfirmation(deps, event),
  });
}

/**
 * The event-first chain: no agreement, so look for the request the save
 * created for this event (`originEventId` is unique). Nothing found = the
 * common "never booked" null. Found = the request leg populated from that
 * row, `agreement` null, and the venue's stance derived exactly as for the
 * agreement chain — it is this read's whole reason to exist: the builder
 * band renders "Sent to {place} for confirmation" / "Confirmed by {place}"
 * on every later visit, not only from the save response.
 */
async function resolveEventFirstProvenance(
  deps: GetEventProvenanceDeps,
  event: EventRecord,
): Promise<GetEventProvenanceOutput> {
  const request = await deps.repos.bookingRequests.findByOriginEventId(
    event.id,
  );
  if (!request) {
    // The common case: this event never came from a booking.
    return null;
  }

  // CROSS-AGGREGATE BACKSTOP, event-first flavour — see
  // `describeOriginRequestMismatch`. Dropped, never rendered.
  const mismatch = describeOriginRequestMismatch(event, request);
  if (mismatch) {
    deps.logger?.error("events.provenance.foreign_origin_request_dropped", {
      eventId: event.id,
      bookingRequestId: request.id,
      reason: mismatch,
    });
    try {
      deps.reportError?.(
        new Error("events.provenance.foreign_origin_request_dropped"),
        {
          tags: { useCase: "getEventProvenance", step: "originRequestAssert" },
          extra: {
            eventId: event.id,
            eventOrgId: event.orgId ?? null,
            eventHumanId: event.humanId ?? null,
            bookingRequestId: request.id,
            requestOriginEventId: request.originEventId,
            requestOwnerType: request.performerOwnerType,
            requestOwnerId: request.performerOwnerId,
            reason: mismatch,
          },
        },
      );
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // drop-the-foreign-request backstop into a thrown error.
    }
    return null;
  }

  return getEventProvenanceOutputSchema.parse({
    agreement: null,
    bookingRequest: await toBookingRequestLeg(deps, request),
    venueConfirmation: await resolveVenueConfirmation(deps, event),
  });
}

/**
 * The request leg, identical for both chains so the builder band and the
 * agreement breadcrumb read the same fields off the same row.
 */
async function toBookingRequestLeg(
  deps: Pick<GetEventProvenanceDeps, "repos" | "logger" | "reportError">,
  request: BookingRequestRecord,
): Promise<NonNullable<NonNullable<GetEventProvenanceOutput>["bookingRequest"]>> {
  return {
    id: request.id,
    status: request.status,
    direction: request.direction,
    senderDisplayName: await resolveSenderDisplayName(deps, request),
    lastMessageAt: request.lastMessageAt,
    intent: request.intent,
    placeId: request.placeId,
    placeName: request.placeName,
    parked: request.parkedUnclaimedAt !== null,
  };
}

/**
 * The venue's stance on this event, through the shared admin-side reading
 * (`describeVenueConfirmationState`). ONE `places.getById`, only when the
 * event has a place. NOT swallowed: a place read that throws means the store
 * is unhealthy, and a confident "unconfirmed" on a banner that tells the
 * requester whether they may publish under the venue's name is worse than an
 * error.
 */
async function resolveVenueConfirmation(
  deps: Pick<GetEventProvenanceDeps, "repos">,
  event: EventRecord,
): Promise<NonNullable<GetEventProvenanceOutput>["venueConfirmation"]> {
  if (!event.placeId) {
    return { state: "none", ownerSide: null, placeName: null };
  }
  const place = await deps.repos.places.getById(event.placeId);
  const { state, ownerSide } = describeVenueConfirmationState(
    event,
    place
      ? {
          id: place.id,
          orgIdsWithAccess: place.orgIdsWithAccess ?? [],
          humanIdsWithAccess: place.humanIdsWithAccess ?? [],
          acceptsCommunityListings: place.acceptsCommunityListings === true,
        }
      : null,
  );
  return { state, ownerSide, placeName: place?.name ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-aggregate backstop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-derive the chain from the EVENT ROW instead of trusting the FKs we just
 * followed. Returns a short reason on violation, null when the chain holds.
 *
 * Cross-org leakage is this repo's worst failure mode, and it is structurally
 * available here: the agreement and the booking request belong to a different
 * aggregate than the event, reached by two reverse lookups. If either lookup
 * were ever widened (a non-unique predicate, a copy-pasted `findFirst`, a
 * caller passing the wrong id), a venue would see ANOTHER org's negotiation —
 * who pitched them, and a link into that thread. Two independent checks:
 *
 *  1. ANCHOR. The agreement must actually be linked to THIS event id, and the
 *     request must actually be linked to THIS agreement id. Structural: every
 *     legitimate row satisfies it by construction, so it can only fire on a
 *     broken query — which is exactly the bug class it exists for.
 *
 *  2. VENUE SIDE. The event must belong to one of the agreement's two parties
 *     (proposer = the act, counterparty = the venue business side), OR sit at
 *     the agreement's place. Both halves are re-derived from `event`'s own
 *     columns.
 *
 *     Why the disjunction rather than the tighter "owner === counterparty":
 *     `createEventFromAgreement` does mint the event under the counterparty,
 *     but `finalizeBookingAgreement` also lets a venue hand-pick an EXISTING
 *     event to link (it gates on "the actor can edit that event", not on
 *     ownership matching a party). That hand-picked show is at the negotiated
 *     venue, so the place match carries it. Demanding both halves would drop
 *     provenance from legitimately linked events and page an operator about
 *     it — a guard that cries wolf gets muted, and then it guards nothing.
 *
 *     The place comparison ignores a null `event.placeId` on purpose:
 *     null === null is not evidence of anything, and a freeform event linked
 *     to an agreement of two unrelated parties is the anomaly, not the norm.
 *
 * Ownerless events never reach here — `ensureActorCanEditEvent` refuses
 * COMMUNITY stewardship and rows with neither owner column.
 */
function describeProvenanceMismatch(
  event: EventRecord,
  agreement: AgreementRecord,
  request: BookingRequestRecord | null,
): string | null {
  if (agreement.eventId !== event.id && agreement.draftEventId !== event.id) {
    return "agreement_not_anchored_on_event";
  }

  if (request && request.agreementId !== agreement.id) {
    return "request_not_anchored_on_agreement";
  }

  // The event's OWN identity refs, in the same `type:id` shape the agreement
  // stores its parties in. Both columns are read when both are set — the
  // event is genuinely both, and the gate has already authorized the actor.
  const eventOwnerRefs = new Set<string>();
  if (event.orgId) eventOwnerRefs.add(`organization:${event.orgId}`);
  if (event.humanId) eventOwnerRefs.add(`human:${event.humanId}`);

  const isParty =
    eventOwnerRefs.has(`${agreement.proposerType}:${agreement.proposerId}`) ||
    eventOwnerRefs.has(
      `${agreement.counterpartyType}:${agreement.counterpartyId}`,
    );
  const isAtAgreementPlace =
    event.placeId !== null &&
    event.placeId !== undefined &&
    event.placeId === agreement.placeId;

  if (!isParty && !isAtAgreementPlace) {
    return "agreement_venue_side_unrelated_to_event";
  }

  return null;
}

/**
 * The event-first twin of {@link describeProvenanceMismatch}: re-derive the
 * origin link from the EVENT ROW instead of trusting the lookup.
 *
 *  1. ANCHOR. The request's `originEventId` must be THIS event. Structural —
 *     only a widened query can fail it.
 *  2. OWNER. `createBookingRequestFromEvent` writes the requester pair from
 *     the event's owner, so the request's `performerOwner*` must name the
 *     event's org or human. Should be impossible to fail; if it ever does, a
 *     venue-side row (or another requester's) is about to render inside
 *     someone else's builder, which is the leak this read must not commit.
 *     An anonymous pair (null owner) is a mismatch too: an event-first row
 *     is never anonymous.
 *
 * Not `placeId`: the request keeps the venue it was SENT to even after the
 * event moves, and that is the requester's own thread either way.
 */
function describeOriginRequestMismatch(
  event: EventRecord,
  request: BookingRequestRecord,
): string | null {
  if (request.originEventId !== event.id) {
    return "request_not_anchored_on_event";
  }

  const eventOwnerRefs = new Set<string>();
  if (event.orgId) eventOwnerRefs.add(`organization:${event.orgId}`);
  if (event.humanId) eventOwnerRefs.add(`human:${event.humanId}`);

  const requester =
    request.performerOwnerType !== null && request.performerOwnerId !== null
      ? `${request.performerOwnerType}:${request.performerOwnerId}`
      : null;
  if (requester === null || !eventOwnerRefs.has(requester)) {
    return "request_owner_unrelated_to_event";
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender name
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The act's display name, resolved the same way `listBookingRequests` resolves
 * `performerDisplayName`: the human/org name for an owned sender, the
 * submitted `contactName` for an anonymous embed inquiry.
 *
 * DELIBERATE SWALLOW (ReporterPort convention): a corrupt row — one carrying
 * NEITHER a performer owner pair nor anonymous contact fields, an
 * app-invariant violation — makes `getBookingRequestSender` throw. Losing the
 * whole provenance breadcrumb over a missing NAME would be the wrong trade;
 * the agreement/request ids are the useful part and stay intact. Logged at
 * error AND reported, because a corrupt row that only manifests as a blank
 * label in someone's UI is a corruption nobody is paged for. The report is
 * guarded so a throwing reporter cannot turn the fallback back into a failure.
 *
 * Repo failures are NOT swallowed: a name lookup that throws means the store
 * is unhealthy, and the caller is entitled to that error rather than a
 * confidently blank answer.
 */
async function resolveSenderDisplayName(
  deps: Pick<GetEventProvenanceDeps, "repos" | "logger" | "reportError">,
  request: BookingRequestRecord,
): Promise<string | null> {
  let sender;
  try {
    sender = getBookingRequestSender(request);
  } catch (error) {
    deps.logger?.error("events.provenance.corrupt_sender_row", {
      bookingRequestId: request.id,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "getEventProvenance", step: "senderDisplayName" },
        extra: { bookingRequestId: request.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // blank-name fallback into a thrown error.
    }
    return null;
  }

  if (sender.kind === "anonymous") {
    return sender.contactName;
  }

  if (sender.performerOwnerType === "human") {
    const human = await deps.repos.humans.getById(sender.performerOwnerId);
    return human?.name ?? null;
  }

  const org = await deps.repos.organizations.getById(sender.performerOwnerId);
  return org?.name ?? null;
}
