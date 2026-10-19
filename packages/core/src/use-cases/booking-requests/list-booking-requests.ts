import { z } from "zod";

import { eventStatusSchema } from "@th/schema";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";
// Same import source as messages/_shared/thread-access.ts — the authority for
// the side concept — so the two never drift to different declarations.
import type { BookingThreadSide } from "@th/types/repos/booking-request-messages";

import { parseInput } from "../../lib/io";
import {
  ORG_ANY_ROLE,
  ORG_EDIT_ROLES,
  requireOrgMembership,
} from "../../lib/rbac";
// ONE declaration of the agreement lifecycle for the whole codebase — the same
// import every booking-agreements projection uses, so the inbox rail and the
// agreement surfaces can never disagree about what statuses exist.
import { agreementStatusSchema } from "../booking-agreements/list-booking-agreements";
import {
  listOwnerScopePlaces,
  type OwnerScope,
} from "./_shared/org-owned-places";
import { requirePlaceOwnership } from "./_shared/place-access";
import { fail } from "@th/errors";
import {
  describeVenueConfirmationState,
  type VenueConfirmationPlaceFields,
} from "../../lib/venue-confirmation";
import { resolveBookingTimezone } from "../booking-agreements/_shared/pitch-seed";
import { isHoldLapsed } from "../booking-holds/_shared/booking-hold-lapse";
import {
  performerOwnerKey,
  resolvePerformerDisplayNames,
} from "./_shared/performer-display-names";
import {
  bookingHoldStatusSchema,
  isoCalendarDateSchema,
} from "../booking-holds/_shared/hold-context";
// ── P5-fixes (booking actions in the venue's holds strip) ──
import {
  bookingNightOf,
  isAskedForNight,
  resolveBookingEventWith,
} from "../booking-holds/_shared/booking-night";
import { todayInZone } from "../booking-holds/_shared/booking-hold-lapse";
import { mintEventOwnerSide } from "../booking-agreements/_shared/agreement-mint-plan";
import type { PlaceRecord } from "@th/ports/repos/places";
import {
  bookingRequestBillItemSchema,
  resolveBillIdentities,
  toBillItems,
  type BookingRequestBillItem,
} from "./_shared/bill-items";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const bookingRequestStatusSchema = z.enum([
  "PENDING",
  "VIEWED",
  "ACCEPTED",
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
]);

/**
 * Whitelisted verified-stats snapshot shape (FR-009). Mirrors
 * `VerifiedStatsSnapshot` — the point-in-time metrics plus the source
 * aggregate's `computedAt`. Intentionally omits everything not in the public
 * whitelist (topCities, followerCount, full channelBreakdown, …).
 */
export const verifiedStatsSnapshotSchema = z
  .object({
    totalEventsPerformed: z.number().int().nonnegative(),
    avgDrawPerEvent: z.number().nullable(),
    repeatFanCount: z.number().int().nonnegative(),
    refLinkTickets: z.number().int().nonnegative(),
    last90DayTickets: z.number().int().nonnegative(),
    last90DayEvents: z.number().int().nonnegative(),
    computedAt: z.string(),
  })
  .strict();

export const bookingRequestHoldSummarySchema = z
  .object({
    id: z.uuid(),
    /**
     * The hold's calendar — VENUE side only. Null on every PERFORMER scope:
     * the act sees its own date and position (booking-holds FR-013), never
     * the venue's calendar structure.
     */
    calendarId: z.uuid().nullable(),
    date: isoCalendarDateSchema,
    position: z.number().int().min(1),
    status: bookingHoldStatusSchema,
    respondBy: z.date().nullable(),
    lapsed: z.boolean(),
    /**
     * The hold's night is one the request asked for (`isAskedForNight`: a
     * preferred date's day, or — RENT / USE — inside the requested window).
     * The venue's "Book without terms" needs it (booking-the-night FR-004,
     * DATE_NOT_ASKED_FOR); the act sees its own pitch's dates anyway.
     */
    askedFor: z.boolean(),
  })
  .strict();

export const bookingRequestTagSummarySchema = z
  .object({ id: z.uuid(), name: z.string(), color: z.string() })
  .strict();

/**
 * Where the venue's vouch for this booking's event stands
 * (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27
 * "Confirmation lives on the Event"). Derived on read through the ONE rule
 * in `lib/venue-confirmation.ts` — never stored, never re-derived inline.
 *
 * - `none` — the booking has no event yet (or the stage lookup degraded).
 * - `confirmed` — the venue stands behind it: venue-owned (confirmed by
 *   construction) or actively stamped for the place the event is at.
 * - `withdrawn` — the venue took its vouch back. Renders like `unconfirmed`
 *   in public; distinct here because the venue's own inbox must say so.
 * - `unconfirmed` — a requester-owned event at the place with no stamp.
 */
export const bookingRequestVenueConfirmationStateSchema = z.enum([
  "none",
  "confirmed",
  "withdrawn",
  "unconfirmed",
]);

export const bookingRequestVenueConfirmationSchema = z
  .object({
    state: bookingRequestVenueConfirmationStateSchema,
    /** The event the state is about. Null exactly when `state` is `none`. */
    eventId: z.uuid().nullable(),
    /**
     * Whose event it is — the place's own row (`place`) or the requester's
     * (`requester`). Null when there is no event. What lets a UI offer
     * "Withdraw confirmation" only where the server would accept it: a
     * venue-owned event is confirmed by construction and refuses withdrawal.
     */
    ownerSide: z.enum(["place", "requester"]).nullable(),
  })
  .strict();

export const bookingRequestSummarySchema = z
  .object({
    id: z.uuid(),
    /**
     * Flow direction (organizer-booking-requests FR-001). TO_VENUE rows carry
     * a placeId; TO_PERFORMER rows carry organizerOrgId (+ optional attached
     * event) instead.
     */
    direction: z.enum(["TO_VENUE", "TO_PERFORMER"]),
    /** Venue (TO_VENUE only — null on TO_PERFORMER rows). */
    placeId: z.uuid().nullable(),
    placeName: z.string().nullable(),
    /**
     * The named Calendar this request routes to (venue-hierarchy FR-008), and
     * its display name — the venue inbox's second filter dimension.
     *
     * A venue's calendars are its PROGRAMMING streams ("Main", "Live Music"),
     * which is what a booker actually filters an inbox by; Space is the
     * physical room and lives on the HOLD, not the request, so it cannot
     * classify a request that nobody has held a date for yet.
     *
     * Both null on TO_PERFORMER rows (organizer→act requests are never
     * routed) and on unrouted/pre-hierarchy rows. `calendarName` is
     * independently null when the calendar has been deleted (SetNull), so a
     * null NAME with a non-null id means "gone", not "unnamed".
     */
    calendarId: z.uuid().nullable(),
    calendarName: z.string().nullable(),
    /** Sender org (TO_PERFORMER only). */
    organizerOrgId: z.uuid().nullable(),
    /** Denormalized organizer-org display name (TO_PERFORMER only). */
    organizerOrgName: z.string().nullable(),
    /** Attached event (TO_PERFORMER only) — id stored, details rendered live. */
    attachedEventId: z.uuid().nullable(),
    attachedEventTitle: z.string().nullable(),
    attachedEventStartsAt: z.date().nullable(),
    /**
     * Polymorphic sender pair — null for ANONYMOUS embed inquiries
     * (booking-request-embed-button FR-005/FR-006). The summary intentionally
     * carries the same four sender columns as the record, so consumers can
     * narrow via `getBookingRequestSender(summary)` instead of null-guessing.
     */
    performerOwnerType: z.enum(["human", "organization"]).nullable(),
    performerOwnerId: z.uuid().nullable(),
    /**
     * Resolved sender name: human/org name for owned requests, the submitted
     * contactName for anonymous inquiries; null when unavailable.
     */
    performerDisplayName: z.string().nullable(),
    // ── Anonymous sender contact (embed inquiries, 2026-07-13) ──────────────
    /** Set for anonymous inquiries (and kept after claim); null for owned. */
    contactName: z.string().nullable(),
    /** Lowercased at rest; the venue's off-platform reply channel (FR-006). */
    contactEmail: z.string().nullable(),
    /**
     * When a real party redeemed the invite-to-claim token. Surfaced because
     * the owner pair alone no longer answers "is this inquiry claimed": since
     * booking-inquirer-outreach an unclaimed inquiry the venue replied to
     * carries a SHADOW owner pair so the reply has somewhere to go. Clients
     * must use `isUnclaimedBookingInquiry(summary)` — non-null contactEmail
     * plus a null `claimedAt` — for every "still anonymous" decision.
     */
    claimedAt: z.date().nullable(),
    /**
     * Set when the provider told us the venue's emailed reply could not be
     * delivered to `contactEmail` (booking-inquirer-outreach). Only ever
     * stamped on rows we actually MAILED, still unclaimed, and still open —
     * so a non-null value means "the venue replied and the inquirer did not
     * get it", which is otherwise invisible on both sides of the thread.
     */
    inquirerEmailUndeliverableAt: z.date().nullable(),
    /**
     * WHICH hard failure stamped the timestamp above. The two are different
     * facts for the venue, not one "delivery failed": BOUNCED means the
     * address is bad, COMPLAINED means it arrived and was marked as junk (and
     * we stop mailing it). Never collapse them in a UI.
     */
    inquirerEmailUndeliverableStatus: z.enum(["BOUNCED", "COMPLAINED"]).nullable(),
    /** Submission provenance. Existing/platform rows are "PLATFORM". */
    source: z.enum(["PLATFORM", "EMBED"]),
    message: z.string(),
    preferredDates: z.array(z.string()),
    expectedDraw: z.number().int().nullable(),
    genre: z.string().nullable(),
    /** LEGACY generic pitch links — superseded by the typed link* fields. */
    links: z.array(z.string()),
    // ── Expanded pitch fields (2026-07-11) ──────────────────────────────────
    actName: z.string().nullable(),
    lineupSize: z.number().int().nullable(),
    setLengthMinutes: z.number().int().nullable(),
    contactPhone: z.string().nullable(),
    techNeeds: z.string().nullable(),
    feeType: z.enum(["GUARANTEE", "DOOR_SPLIT", "NEGOTIABLE"]).nullable(),
    feeAmountCents: z.number().int().nullable(),
    feeCurrency: z.string().nullable(),
    linkMusic: z.string().nullable(),
    linkVideo: z.string().nullable(),
    linkSocial: z.string().nullable(),
    linkEpk: z.string().nullable(),
    status: bookingRequestStatusSchema,
    viewedAt: z.date().nullable(),
    respondedAt: z.date().nullable(),
    declineReason: z.string().nullable(),
    agreementId: z.uuid().nullable(),
    // ── Booking STAGE projection (request → agreement → event) ───────────────
    // A booking travels through three stages, and `status` above describes
    // only the FIRST one. Without these, "accepted, agreement still a draft"
    // and "accepted, terms agreed, event on sale" are the same row.
    //
    // All four are projections of rows hanging off OTHER aggregates, resolved
    // in ONE batched pass per page (see `resolveBookingStages`) and DEGRADED
    // TO NULL — never to a throw — when that pass fails. So null means "no
    // such stage OR we could not read it", which is exactly what a rail should
    // render as "nothing to show", and never as a wrong stage.
    /**
     * Status of the linked `Agreement` (`BookingRequest.agreementId` is the FK
     * — there is no `Agreement.bookingRequestId` column). Null when the
     * request never produced one.
     */
    agreementStatus: agreementStatusSchema.nullable(),
    /**
     * The event this booking produced, reached from the AGREEMENT (there is no
     * `Event.agreementId`): `Agreement.eventId` — the finalized link — falling
     * back to `Agreement.draftEventId`, the pre-finalize anchor stamped by
     * `createEventFromAgreement`. The draft case is where a booked event
     * spends most of its life, since finalize can stay blocked on payout
     * readiness indefinitely; reading only `eventId` would report "no event"
     * for most real bookings. Finalized WINS on a tie (same precedence
     * contract as `AgreementsRepo.findByLinkedEventId`).
     */
    eventId: z.uuid().nullable(),
    /**
     * The linked event's own status — what lets the rail's last stage say
     * something true (draft vs published vs cancelled) instead of merely "an
     * event exists".
     */
    eventStatus: eventStatusSchema.nullable(),
    /**
     * The linked event's start. Deliberately surfaced next to
     * `preferredDates`: the two DIVERGING is the meaningful signal (the show
     * landed on a different night than the one that was pitched).
     */
    eventStartsAt: z.date().nullable(),
    /**
     * What the request asks the venue for (PERFORM / RENT / USE). Picks the
     * default owner of the event a venue confirmation mints: PERFORM → the
     * venue, RENT / USE → the requester. Pre-spec rows read PERFORM.
     */
    intent: z.enum(["PERFORM", "RENT", "USE"]),
    /**
     * True when the request was built from an event (`originEventId` set) —
     * the only kind the venue's `venueConfirmation.confirm` accepts. A boolean
     * on purpose: the origin event id itself is never exposed to the venue.
     */
    builtFromEvent: z.boolean(),
    // ── P5-fixes ── what the venue's two booking actions on a hold ("Send
    // terms", "Book without terms"; booking-the-night FR-003 / FR-004) are
    // gated on, derived with the SAME rules the use cases refuse with. VENUE
    // scopes only — null on every other scope, and null when the stage
    // lookup degraded or the row is inconsistent (callers fail closed).
    /**
     * The booking's event as the booking paths resolve it
     * (`resolveBookingEvent`): `none` — no event yet (a dead draft anchor
     * counts as none: the mint replaces it); `live` — the event's night in
     * the PLACE's zone and its calendar (the line it sits on); `gone` — a
     * cancelled / archived event-first origin or finalized link, which every
     * booking path refuses. Null = could not tell.
     */
    bookingEvent: z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("none") }).strict(),
        z
          .object({
            state: z.literal("live"),
            night: isoCalendarDateSchema,
            calendarId: z.uuid().nullable(),
          })
          .strict(),
        z.object({ state: z.literal("gone") }).strict(),
      ])
      .nullable(),
    /**
     * The night (place zone) of terms the sender has seen or agreed — a
     * PROPOSED agreement, or an ACCEPTED one not yet finalized. A booking
     * never rewrites those: "Book without terms" works only on that night
     * (else TERMS_SENT_FOR_ANOTHER_NIGHT / TERMS_AGREED_FOR_ANOTHER_NIGHT).
     * Null otherwise.
     */
    termsNight: isoCalendarDateSchema.nullable(),
    /**
     * Who a booking without terms pays — its event's money goes 100% to the
     * event's owner until terms are added (`mintEventOwnerSide`, the mint
     * plan's own rule): `place` for a venue-owned event / PERFORM, else
     * `requester`. Null when unknown.
     */
    bookWithoutTermsPayee: z.enum(["place", "requester"]).nullable(),
    /**
     * The request already has a booked night (a CONFIRMED hold; one per
     * request). `holds` carries live holds only, so this is the one signal
     * that both booking actions are over (BOOKING_ALREADY_HAS_NIGHT). Null
     * when the read degraded or off the venue scopes.
     */
    hasBookedNight: z.boolean().nullable(),
    /**
     * The venue's vouch for the row's event — resolved in the same batched
     * pass as the event triple above, and degraded to `none` with it.
     */
    venueConfirmation: bookingRequestVenueConfirmationSchema,
    /**
     * Server-sourced verified-stats snapshot (FR-009/FR-010), null unless the
     * sender opted in AND was eligible. Surfaced so the venue inbox can render
     * it distinctly from the self-reported `expectedDraw`.
     */
    verifiedStatsSnapshot: verifiedStatsSnapshotSchema.nullable(),
    /**
     * Messages on this request's thread the viewer's SIDE has not read — i.e.
     * rows not authored by that side (counterparty + SYSTEM) with
     * `readAt IS NULL`. Per-SIDE, so the same request carries different
     * numbers in the venue inbox and the performer sent list.
     *
     * PER-SIDE, NOT PER-HUMAN: there is one shared `readAt` per message and no
     * per-human read state, so any teammate on your side opening the thread
     * clears the badge for EVERYONE on that side — a second venue staffer can
     * still miss a reply their colleague opened first. Same accepted v1
     * trade-off as `MarkBookingRequestMessagesReadInput`; fixing it means a
     * per-human read table, not a change here.
     *
     * Exists because a reply was previously invisible from every list
     * surface: the only unread signal lived inside the open thread, where
     * "mounting IS reading" cleared it before it could be perceived.
     *
     * ALWAYS a number (0 when quiet, and 0 when the count lookup itself
     * failed — see the swallow in `resolveUnreadCounts`). Never null, so a
     * consumer cannot accidentally render "we didn't look" as "unread".
     */
    unreadMessageCount: z.number().int().nonnegative(),
    // ── Booking-holds WORKFLOW projection (spec 2026-08-25) ─────────────────
    /**
     * LIVE holds (ACTIVE | CHALLENGED) on this request — the inbox Holds tab
     * (FR-011) and the act's own-position view (FR-013). `lapsed` is the
     * lazy-expiry PROJECTION: reads never write, so a hold whose deadline or
     * date has passed is flagged here and settled by the next mutation. The
     * act sees only its own request's holds by construction (they hang off
     * it); never the rest of a line.
     */
    holds: z.array(bookingRequestHoldSummarySchema),
    /**
     * Venue-internal assignee (FR-015). Null on performer scopes — the act
     * never sees who at the venue is handling it.
     */
    assigneeHumanId: z.uuid().nullable(),
    /** Venue-internal org tags (FR-017). Always `[]` on performer scopes. */
    tags: z.array(bookingRequestTagSummarySchema),
    /**
     * The bill (lineup-booking-requests v2, FR-004): the acts on this
     * request, ordered by `sortOrder` (0 = headliner), each with its consent
     * state. Resolved in ONE batched pass per page (`resolveBookingBills`).
     *
     * VISIBILITY IS APPLIED HERE, not in the renderer: the venue-facing
     * scopes (`venue`, `org-venues`, `human-venues`) never receive a DECLINED
     * act; the sender's scope (`performer`) keeps it (rendered struck). The
     * TO_PERFORMER scopes (`organizer`, `performer-inbox`) always read `[]` —
     * those requests carry no bill (NFR-004).
     *
     * `[]` also means a LEGACY request (sent before the bill existed — no act
     * rows), which readers render the pre-bill way (the sender is the act) —
     * UNLESS `billUnavailable` says the lookup failed.
     */
    bill: z.array(bookingRequestBillItemSchema),
    /**
     * True only when the bill lookup DEGRADED for this page (see
     * `resolveBookingBills`): `bill` is `[]` because we could not read it,
     * not because the request has none. A UI must then say nothing about who
     * is playing rather than fall back to "the sender is the act" — which
     * could name the wrong act on a promoter's request.
     */
    billUnavailable: z.boolean(),
    expiresAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict();

export const listBookingRequestsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    /**
     * - "venue" — a place's inbox (TO_VENUE, received);
     * - "org-venues" — EVERY venue the org owns, in one inbox (TO_VENUE,
     *   received) — the org-level Bookings page, so answering a request no
     *   longer means drilling into the venue that received it;
     * - "human-venues" — EVERY venue the ACTOR owns directly (PlaceOwnership
     *   ownerType HUMAN), in one inbox (TO_VENUE, received) — the personal
     *   admin's Bookings page. No extra id: the owner IS the actor;
     * - "performer" — an act's sent list (TO_VENUE, sent);
     * - "organizer" — an org's outbound act requests (TO_PERFORMER, sent);
     * - "performer-inbox" — an act's received organizer requests
     *   (TO_PERFORMER, received). Direction scoping lives in the repo
     *   queries (NFR-001) — no scope can ever see the other direction.
     * - "sent-to-venues" — lineup v3 FR-014 / L15: the requests the ADMIN
     *   WORKSPACE's subject SENT to venues (TO_VENUE, sent) — the org for
     *   `/admin/{org}` (`orgId`), the actor for `/admin/@{person}` (no id).
     *   Same rows as "performer" (bill as the sender sees it, stages, the
     *   sender's own holds), behind the workspace's gate: ORG_EDIT_ROLES for
     *   an org, the person themselves.
     * - "received-as-performer" — the same workspace's RECEIVED organizer
     *   requests (TO_PERFORMER, received), behind the same gate.
     */
    scope: z.enum([
      "venue",
      "org-venues",
      "human-venues",
      "performer",
      "organizer",
      "performer-inbox",
      "sent-to-venues",
      "received-as-performer",
    ]),
    /** Required for `scope: "venue"`. */
    placeId: z.uuid().optional(),
    /**
     * Required for `scope: "org-venues"` — the org whose OWNED VENUES are
     * being read. For the workspace scopes ("sent-to-venues" /
     * "received-as-performer") it is the workspace's ORG subject; absent
     * there = the actor's own (person) workspace.
     *
     * Deliberately NOT `organizerOrgId`: in this file (and on the summary)
     * that field means "the SENDER org of a TO_PERFORMER row", and overloading
     * one key with two different orgs is how a scope ends up authorizing
     * against the wrong one. `orgId` is also the exact field
     * `countOpenBookingRequests` takes — this scope is the list behind those
     * badges, so the two inputs read the same.
     */
    orgId: z.uuid().optional(),
    /** Required for `scope: "organizer"`. */
    organizerOrgId: z.uuid().optional(),
    /**
     * Performer / performer-inbox scopes — defaults to the actor's human
     * identity.
     */
    performerOwnerType: z.enum(["human", "org"]).optional(),
    performerOwnerId: z.uuid().optional(),
    statuses: z.array(bookingRequestStatusSchema).optional(),
  })
  .strict();

export const listBookingRequestsOutputSchema = z
  .object({
    requests: z.array(bookingRequestSummarySchema),
    /**
     * `scope: "org-venues"` / `"human-venues"` ONLY: true when the owner holds
     * more venues than one response enumerates (`MAX_OWNED_PLACES` in
     * `_shared/org-owned-places.ts`) and the alphabetical tail was cut, so the
     * inbox is missing those venues' requests entirely.
     *
     * ABSENT (undefined) on every other scope — those have no owned-place
     * enumeration to truncate. Absent means "not applicable", not "false"; a
     * consumer rendering the org inbox should treat only `=== true` as a cut.
     * Surfaced at all because the alternative is the failure mode this whole
     * surface exists to avoid: a capped inbox that reads as "you have no more
     * requests".
     */
    ownedPlacesTruncated: z.boolean().optional(),
  })
  .strict();

export type ListBookingRequestsInput = z.infer<
  typeof listBookingRequestsInputSchema
>;
export type ListBookingRequestsOutput = z.infer<
  typeof listBookingRequestsOutputSchema
>;
export type BookingRequestSummary = z.infer<typeof bookingRequestSummarySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListBookingRequestsDeps = {
  repos: Pick<
    Repos,
    | "bookingRequests"
    | "places"
    | "authz"
    | "humans"
    | "organizations"
    | "bookingRequestMessages"
    // Read-only, and ONLY ever by ids taken off already-authorized request
    // rows — the stage projection (see `resolveBookingStages`).
    | "agreements"
    | "events"
    // Booking-holds workflow projection (`resolveBookingWorkflow`): live
    // holds + tags, batched by the same already-authorized ids.
    | "bookingHolds"
    | "bookingTags"
    // The bill's act pages (names + links), read by owner ids taken off
    // the already-authorized requests' act rows (`resolveBookingBills`).
    | "entityPages"
  >;
  /**
   * Clock for the lazy-expiry projection (`lapsed`). Optional so existing
   * callers keep compiling; defaults to wall time.
   */
  clock?: { now(): Date };
  logger?: LoggerPort;
  /**
   * Optional best-effort error reporter. Fired on every deliberate swallow in
   * this use case: a corrupt row (sender-invariant violation) being skipped so
   * the rest of the inbox still renders, a failed unread-count lookup degrading
   * the whole list to `unreadMessageCount: 0`, a failed stage lookup degrading
   * every row's agreement/event fields to null, a failed bill lookup
   * degrading every row's `bill` to `[]`, and the `org-venues` /
   * `human-venues` cross-owner backstop dropping a row for a place the owner
   * does not hold. Never
   * affects output; a throwing reporter changes nothing.
   */
  reportError?: ReporterPort;
};

/**
 * The agreement/event stage projection for ONE request row — the four fields
 * the inbox rail needs beyond `status`.
 *
 * COHERENT BY CONSTRUCTION: `eventId` is non-null if and only if the event row
 * itself resolved, so `eventStatus`/`eventStartsAt` are never null next to a
 * non-null id. A rail can therefore treat "eventId set" as "there is an event
 * and I can describe it" — instead of rendering a final stage it has nothing
 * to say about (which is the failure this projection exists to end).
 */
export type BookingStage = {
  agreementStatus: BookingRequestSummary["agreementStatus"];
  eventId: string | null;
  eventStatus: BookingRequestSummary["eventStatus"];
  eventStartsAt: Date | null;
  venueConfirmation: BookingRequestSummary["venueConfirmation"];
  bookingEvent: BookingRequestSummary["bookingEvent"];
  termsNight: BookingRequestSummary["termsNight"];
  bookWithoutTermsPayee: BookingRequestSummary["bookWithoutTermsPayee"];
  hasBookedNight: BookingRequestSummary["hasBookedNight"];
};

/** The venue-confirmation shape for a row with no event. */
const NO_VENUE_CONFIRMATION: BookingStage["venueConfirmation"] = {
  state: "none",
  eventId: null,
  ownerSide: null,
};

/** No agreement, no event — and the shape every degraded/unknown row takes. */
const NO_STAGE: BookingStage = {
  agreementStatus: null,
  eventId: null,
  eventStatus: null,
  eventStartsAt: null,
  venueConfirmation: NO_VENUE_CONFIRMATION,
  bookingEvent: null,
  termsNight: null,
  bookWithoutTermsPayee: null,
  hasBookedNight: null,
};

/** The mint's owner side, in the inbox's words. */
function toPayee(
  side: "place" | "requester" | null,
): BookingStage["bookWithoutTermsPayee"] {
  return side;
}

/** Holds + assignee + tags for ONE row (booking-holds workflow projection). */
export type BookingWorkflow = {
  holds: BookingRequestSummary["holds"];
  assigneeHumanId: string | null;
  tags: BookingRequestSummary["tags"];
};

/** The degraded / not-applicable shape: nothing to show. */
const NO_WORKFLOW: BookingWorkflow = { holds: [], assigneeHumanId: null, tags: [] };

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export function toBookingRequestSummary(
  record: BookingRequestRecord,
  performerDisplayName: string | null = null,
  /**
   * Unread count for the viewer's SIDE (per-side, not per-human — see the
   * schema field). Defaults to 0 so callers that have no thread context (and
   * every future one) stay compiling AND stay honest: "no count supplied"
   * renders as a quiet row, never as a phantom badge.
   */
  unreadMessageCount = 0,
  /**
   * Agreement/event stage for this row. Defaults to {@link NO_STAGE} so
   * callers with no stage context stay compiling AND stay honest: "we didn't
   * look" renders identically to "there is no agreement yet" — never as a
   * phantom stage.
   */
  stage: BookingStage = NO_STAGE,
  /**
   * Holds / assignee / tags for this row. Defaults to {@link NO_WORKFLOW} —
   * "we didn't look" renders as "nothing to show", never as a phantom hold.
   */
  workflow: BookingWorkflow = NO_WORKFLOW,
  /**
   * The bill, already filtered for the viewer's audience. Defaults to `[]` —
   * "we didn't look" renders as a pre-bill request, never as a phantom act.
   */
  bill: BookingRequestBillItem[] = [],
  /** True only on the degraded bill path — see the schema field. */
  billUnavailable = false,
): BookingRequestSummary {
  // Narrowing doubles as the sender-invariant check: a corrupt row (neither
  // identity) throws here and is skipped + reported by `toSummaries`.
  const sender = getBookingRequestSender(record);
  // Unclaimed inquiries display as their submitted contact name (FR-006);
  // truly owned requests use the batch-resolved human/org name. Claim state
  // wins over the sender narrowing: a shadow owner minted for venue outreach
  // is not a name the venue should see instead of who wrote to them.
  const displayName = isUnclaimedBookingInquiry(record)
    ? record.contactName
    : sender.kind === "owned"
      ? performerDisplayName
      : sender.contactName;
  return {
    id: record.id,
    direction: record.direction,
    placeId: record.placeId,
    placeName: record.placeName,
    calendarId: record.calendarId,
    calendarName: record.calendarName,
    organizerOrgId: record.organizerOrgId,
    organizerOrgName: record.organizerOrgName,
    attachedEventId: record.attachedEventId,
    attachedEventTitle: record.attachedEventTitle,
    attachedEventStartsAt: record.attachedEventStartsAt,
    performerOwnerType: record.performerOwnerType,
    performerOwnerId: record.performerOwnerId,
    performerDisplayName: displayName,
    contactName: record.contactName,
    contactEmail: record.contactEmail,
    claimedAt: record.claimedAt,
    inquirerEmailUndeliverableAt: record.inquirerEmailUndeliverableAt,
    inquirerEmailUndeliverableStatus: record.inquirerEmailUndeliverableStatus,
    source: record.source,
    message: record.message,
    preferredDates: record.preferredDates,
    expectedDraw: record.expectedDraw,
    genre: record.genre,
    links: record.links,
    actName: record.actName,
    lineupSize: record.lineupSize,
    setLengthMinutes: record.setLengthMinutes,
    contactPhone: record.contactPhone,
    techNeeds: record.techNeeds,
    feeType: record.feeType,
    feeAmountCents: record.feeAmountCents,
    feeCurrency: record.feeCurrency,
    linkMusic: record.linkMusic,
    linkVideo: record.linkVideo,
    linkSocial: record.linkSocial,
    linkEpk: record.linkEpk,
    status: record.status,
    viewedAt: record.viewedAt,
    respondedAt: record.respondedAt,
    declineReason: record.declineReason,
    agreementId: record.agreementId,
    agreementStatus: stage.agreementStatus,
    eventId: stage.eventId,
    eventStatus: stage.eventStatus,
    eventStartsAt: stage.eventStartsAt,
    intent: record.intent,
    builtFromEvent: record.originEventId != null,
    bookingEvent: stage.bookingEvent,
    termsNight: stage.termsNight,
    bookWithoutTermsPayee: stage.bookWithoutTermsPayee,
    hasBookedNight: stage.hasBookedNight,
    venueConfirmation: stage.venueConfirmation,
    verifiedStatsSnapshot: record.verifiedStatsSnapshot,
    unreadMessageCount,
    holds: workflow.holds,
    assigneeHumanId: workflow.assigneeHumanId,
    tags: workflow.tags,
    bill,
    billUnavailable,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

/**
 * BATCH-resolve the viewer's unread message count for every request on the
 * page: ONE `countUnreadByRequest` call total, never one per row (same N+1 bar
 * as {@link resolvePerformerDisplayNames}).
 *
 * DELIBERATE SWALLOW (ReporterPort convention): a failed count must not take
 * down someone's entire inbox — a missing badge is a far smaller harm than a
 * blank list. The failure is logged AND reported so the degradation is visible
 * to operators instead of silently rendering every thread as quiet forever;
 * the reporter call is guarded so a throwing reporter cannot turn the fallback
 * back into an outage. Callers zero-fill from the returned (possibly empty)
 * map, so the degraded shape is exactly "everything reads as 0".
 *
 * The swallow covers TRANSIENT failures only. An UNWIRED repo is a different
 * class of problem — permanent, and it would make the badge dead on arrival
 * while every list still renders green — so it throws NOT_CONFIGURED before
 * the try, exactly like `messagesIn` in messages/_shared/thread-access.ts.
 * The check runs BEFORE the empty-page short-circuit on purpose: a wiring
 * omission must not stay invisible until someone happens to have a request.
 * (Unreachable through the composition roots today, where `Repos` demands the
 * repo; reachable through a partial-repos object widened with `as unknown as`,
 * which is how every test fixture in this repo builds deps.)
 */
async function resolveUnreadCounts(
  deps: Pick<ListBookingRequestsDeps, "repos" | "logger" | "reportError">,
  records: BookingRequestRecord[],
  side: BookingThreadSide,
  scope: ListBookingRequestsInput["scope"],
): Promise<Map<string, number>> {
  const messages = deps.repos.bookingRequestMessages;
  if (!messages) {
    throw fail("NOT_CONFIGURED", {
      message: "bookingRequestMessages repo missing",
    });
  }

  if (records.length === 0) return new Map();

  try {
    return await messages.countUnreadByRequest({
      bookingRequestIds: records.map((record) => record.id),
      side,
    });
  } catch (error) {
    deps.logger?.error("booking_requests.list.unread_counts_failed", {
      scope,
      side,
      requestCount: records.length,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "listBookingRequests", step: "unreadCounts" },
        extra: { scope, side, requestCount: records.length },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // degrade-to-zero fallback into a thrown error.
    }
    return new Map();
  }
}

/**
 * The venue-confirmation projection of ONE resolved event — the shared
 * admin-side reading (`describeVenueConfirmationState`, lib/venue-confirmation)
 * keyed to the event. `owners === null` = the place row is gone.
 */
function describeVenueConfirmation(
  event: EventRecord,
  owners: VenueConfirmationPlaceFields | null,
): BookingStage["venueConfirmation"] {
  return { ...describeVenueConfirmationState(event, owners), eventId: event.id };
}

/**
 * BATCH-resolve the booking STAGE (agreement + event) for every row on the
 * page — the data behind the Request → Agreement → Event rail.
 *
 * THE TRAVERSAL, which is counter-intuitive in both hops:
 *  1. `BookingRequest.agreementId` is the FK on the REQUEST side
 *     (`String? @unique`, SetNull). There is no `Agreement.bookingRequestId`
 *     column, so the agreement is fetched BY ID, not by a back-reference.
 *  2. There is no `Event.agreementId` either. The event hangs off the
 *     AGREEMENT, through one of two unique columns: `eventId` (finalized) and
 *     `draftEventId` (the anchor `createEventFromAgreement` stamps before
 *     finalize). FINALIZED WINS — the same precedence
 *     `AgreementsRepo.findByLinkedEventId` documents, for the same reason: the
 *     money link is the defensible answer when an event is one agreement's
 *     stale draft and another's finalized show. Reading only `eventId` would
 *     report "no event" for most real bookings, since finalize can stay
 *     blocked on payout readiness indefinitely.
 *
 * COST: at most TWO queries for the WHOLE page (one `agreements` set-fetch,
 * one `events` set-fetch), never one per row — the same N+1 bar as
 * {@link resolvePerformerDisplayNames} / {@link resolveUnreadCounts}. ZERO
 * queries when no row carries an agreementId (the common inbox), and ONE when
 * no agreement has reached an event.
 *
 * CROSS-ORG ISOLATION: every id looked up here is read off a row the caller
 * was ALREADY authorized for by the scope above (place ownership, org
 * membership, or performer identity). Nothing widens that — the agreement and
 * event are the ones this very request produced, and no id from input or from
 * another org's row can enter the batch.
 *
 * DELIBERATE SWALLOW (ReporterPort convention): a dead agreement/event query
 * must not blank someone's entire inbox — the rows themselves are already in
 * hand and remain perfectly renderable. The failure is logged AND reported so
 * the degradation is visible to operators rather than silently rendering every
 * booking as "no agreement yet" forever; the reporter call is guarded so a
 * throwing reporter cannot turn the fallback back into an outage. Callers fall
 * back to {@link NO_STAGE} from the returned (possibly empty) map, so the
 * degraded shape is exactly "every stage field reads null".
 *
 * The swallow covers TRANSIENT failures only. An UNWIRED repo is the other
 * class — permanent, and it would ship a rail that is dead on arrival while
 * every list renders green — so it throws NOT_CONFIGURED before the try,
 * exactly like {@link resolveUnreadCounts}. The check runs BEFORE the
 * no-agreements short-circuit on purpose: a wiring omission must not stay
 * invisible until someone happens to have an accepted booking.
 */
async function resolveBookingStages(
  deps: Pick<ListBookingRequestsDeps, "repos" | "logger" | "reportError">,
  records: BookingRequestRecord[],
  scope: ListBookingRequestsInput["scope"],
  /**
   * P5-fixes: also resolve the venue's booking-action fields
   * (`bookingEvent`, `termsNight`, `bookWithoutTermsPayee`). Venue scopes
   * only; elsewhere they stay null.
   */
  venueBooking = false,
): Promise<Map<string, BookingStage>> {
  const agreementsRepo = deps.repos.agreements;
  const eventsRepo = deps.repos.events;
  if (!agreementsRepo || !eventsRepo) {
    throw fail("NOT_CONFIGURED", {
      message: "agreements/events repo missing",
    });
  }

  // Distinct agreement ids only — several requests can never share one
  // (`agreementId` is unique), but the Set also guards the empty case without
  // a DB round trip. Event-first rows (`originEventId`, the request a save
  // auto-created for an event the requester built) carry their event without
  // any agreement, so they count as "something to look up" too.
  const agreementIds = new Set<string>();
  const originEventIds = new Set<string>();
  for (const record of records) {
    if (record.agreementId) agreementIds.add(record.agreementId);
    if (record.originEventId) originEventIds.add(record.originEventId);
  }
  // A venue row with neither has nothing to look up and no event: its
  // booking fields are known without a query (owner by intent).
  const withoutLookup = (record: BookingRequestRecord): BookingStage => ({
    ...NO_STAGE,
    bookingEvent: { state: "none" },
    bookWithoutTermsPayee: toPayee(
      mintEventOwnerSide({ event: null, place: null, request: record, ownerOverride: null }),
    ),
  });
  const bareStages = (): Map<string, BookingStage> => {
    const bare = new Map<string, BookingStage>();
    if (!venueBooking) return bare;
    for (const record of records) {
      if (record.direction !== "TO_VENUE") continue;
      if (record.agreementId || record.originEventId) continue;
      bare.set(record.id, withoutLookup(record));
    }
    return bare;
  };
  if (agreementIds.size === 0 && originEventIds.size === 0) return bareStages();

  try {
    const agreements =
      agreementIds.size > 0
        ? await agreementsRepo.findManyByIds([...agreementIds])
        : [];

    // Hop 2, resolved once per AGREEMENT (not per row): finalized link first,
    // draft anchor only on a miss.
    const linkedEventIdByAgreement = new Map<string, string>();
    const eventIds = new Set<string>(originEventIds);
    for (const agreement of agreements) {
      const linkedEventId = agreement.eventId ?? agreement.draftEventId;
      if (!linkedEventId) continue;
      linkedEventIdByAgreement.set(agreement.id, linkedEventId);
      eventIds.add(linkedEventId);
    }

    const events =
      eventIds.size > 0 ? await eventsRepo.findManyByIds([...eventIds]) : [];
    const eventsById = new Map(events.map((event) => [event.id, event]));
    const agreementsByIdForBooking = new Map(
      agreements.map((agreement) => [agreement.id, agreement]),
    );

    // P5-fixes: the booking event per venue row, by the booking paths' own
    // resolver, over the events just read (every id it can ask for is in
    // the set: the origin, and the agreement's `eventId ?? draftEventId`).
    const bookingResolution = new Map<
      string,
      Awaited<ReturnType<typeof resolveBookingEventWith>>
    >();
    if (venueBooking) {
      for (const record of records) {
        if (record.direction !== "TO_VENUE") continue;
        const agreement = record.agreementId
          ? agreementsByIdForBooking.get(record.agreementId)
          : undefined;
        if (record.agreementId && !agreement) continue;
        bookingResolution.set(
          record.id,
          await resolveBookingEventWith(
            async (id) => eventsById.get(id) ?? null,
            { agreement: agreement ?? null, request: record },
          ),
        );
      }
    }
    /** Terms the sender has seen or agreed (they are never rewritten). */
    const termsOut = (agreement: (typeof agreements)[number] | undefined) =>
      agreement !== undefined &&
      agreement.proposedDate != null &&
      (agreement.status === "PROPOSED" ||
        (agreement.status === "ACCEPTED" && agreement.eventId === null));

    // Hop 3 — the venue's vouch. ONE place read per DISTINCT place the
    // resolved events sit at (never per row; the same batching bar as the
    // hold-timezone read in `resolveBookingWorkflow`). Only the owner lists
    // are read off the place: they feed `isVenueOwnedEvent` and never leave
    // this function.
    const eventPlaceIds = new Set<string>();
    for (const event of events) {
      if (event.placeId) eventPlaceIds.add(event.placeId);
    }
    // P5-fixes: the REQUEST's place too, but only where its zone or owners
    // are needed (a live booking event, or terms out) — never for the common
    // row, and once per distinct place with the event places above.
    for (const record of records) {
      if (!record.placeId) continue;
      const agreement = record.agreementId
        ? agreementsByIdForBooking.get(record.agreementId)
        : undefined;
      if (bookingResolution.get(record.id)?.kind === "event" || (venueBooking && termsOut(agreement))) {
        eventPlaceIds.add(record.placeId);
      }
    }
    const placeById = new Map<string, PlaceRecord | null>();
    const placeOwners = new Map<string, VenueConfirmationPlaceFields | null>(
      await Promise.all(
        [...eventPlaceIds].map(async (placeId) => {
          const place = await deps.repos.places.getById(placeId);
          placeById.set(placeId, place ?? null);
          return [
            placeId,
            place
              ? {
                  id: place.id,
                  orgIdsWithAccess: place.orgIdsWithAccess ?? [],
                  humanIdsWithAccess: place.humanIdsWithAccess ?? [],
                  acceptsCommunityListings:
                    place.acceptsCommunityListings === true,
                }
              : null,
          ] as const;
        }),
      ),
    );

    const agreementsById = new Map(
      agreements.map((agreement) => [agreement.id, agreement]),
    );

    /** P5-fixes: one venue row's booking-action fields (else nulls). */
    const bookingFields = (
      record: BookingRequestRecord,
      agreement: (typeof agreements)[number] | undefined,
    ): Pick<BookingStage, "bookingEvent" | "termsNight" | "bookWithoutTermsPayee"> => {
      const resolution = bookingResolution.get(record.id);
      if (!resolution) {
        return { bookingEvent: null, termsNight: null, bookWithoutTermsPayee: null };
      }
      const place = record.placeId ? (placeById.get(record.placeId) ?? null) : null;
      const placeTz = resolveBookingTimezone(place?.timezone ?? null);
      const termsNight =
        termsOut(agreement) && agreement?.proposedDate && place
          ? bookingNightOf(agreement.proposedDate, placeTz)
          : null;
      if (resolution.kind === "origin_gone" || resolution.kind === "linked_gone") {
        return { bookingEvent: { state: "gone" }, termsNight, bookWithoutTermsPayee: null };
      }
      if (resolution.kind === "none") {
        return {
          bookingEvent: { state: "none" },
          termsNight,
          bookWithoutTermsPayee: toPayee(
            mintEventOwnerSide({ event: null, place, request: record, ownerOverride: null }),
          ),
        };
      }
      // A live event: its night in the PLACE's zone — the same day the
      // booking paths compare (`assertBookingEventOnNight`). Without the
      // place row there is no zone to read it in: unknown, not a guess.
      if (!place) {
        return { bookingEvent: null, termsNight: null, bookWithoutTermsPayee: null };
      }
      return {
        bookingEvent: {
          state: "live",
          night: todayInZone(resolution.event.startsAt, placeTz),
          calendarId: resolution.event.calendarId ?? null,
        },
        termsNight,
        bookWithoutTermsPayee: toPayee(
          mintEventOwnerSide({ event: resolution.event, place, request: record, ownerOverride: null }),
        ),
      };
    };

    const stages = bareStages();
    for (const record of records) {
      const agreement = record.agreementId
        ? agreementsById.get(record.agreementId)
        : undefined;
      // A dangling FK (agreement deleted between the two reads) reads as "no
      // stage" rather than a half-populated row — callers get NO_STAGE.
      if (record.agreementId && !agreement) continue;
      if (!agreement && !record.originEventId) continue;

      // The row's event, in the precedence `confirmVenueEvent` resolves it:
      // the event the request was created FROM wins over the one its
      // agreement anchors — an event-first request is ABOUT that event.
      const linkedEventId =
        record.originEventId ??
        (agreement ? (linkedEventIdByAgreement.get(agreement.id) ?? null) : null);
      const event = linkedEventId ? eventsById.get(linkedEventId) : undefined;
      stages.set(record.id, {
        ...bookingFields(record, agreement),
        // Filled by `resolveVenueBookingStages` on the venue scopes only.
        hasBookedNight: null,
        agreementStatus: agreement?.status ?? null,
        // All-or-nothing on the event triple (see BookingStage): if the event
        // row did not resolve we say nothing about it, rather than claim a
        // stage we cannot describe.
        eventId: event ? event.id : null,
        eventStatus: event?.status ?? null,
        eventStartsAt: event?.startsAt ?? null,
        venueConfirmation: event
          ? describeVenueConfirmation(
              event,
              event.placeId ? (placeOwners.get(event.placeId) ?? null) : null,
            )
          : NO_VENUE_CONFIRMATION,
      });
    }
    return stages;
  } catch (error) {
    deps.logger?.error("booking_requests.list.stage_lookup_failed", {
      scope,
      requestCount: records.length,
      agreementCount: agreementIds.size,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "listBookingRequests", step: "bookingStages" },
        extra: {
          scope,
          requestCount: records.length,
          agreementCount: agreementIds.size,
        },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // degrade-to-null fallback into a thrown error.
    }
    return new Map();
  }
}

/**
 * P5-fixes — the VENUE scopes' stage: {@link resolveBookingStages} with the
 * booking-action fields, plus `hasBookedNight` from ONE batched read of the
 * page's booked nights. The two reads degrade independently: a failed
 * booked-night read nulls only `hasBookedNight` (the web fails closed on
 * null), never the rail.
 */
async function resolveVenueBookingStages(
  deps: Pick<ListBookingRequestsDeps, "repos" | "logger" | "reportError">,
  records: BookingRequestRecord[],
  scope: ListBookingRequestsInput["scope"],
): Promise<Map<string, BookingStage>> {
  const [stages, booked] = await Promise.all([
    resolveBookingStages(deps, records, scope, true),
    resolveBookedNights(deps, records, scope),
  ]);
  for (const record of records) {
    if (record.direction !== "TO_VENUE") continue;
    const stage = stages.get(record.id) ?? NO_STAGE;
    stages.set(record.id, {
      ...stage,
      hasBookedNight: booked === null ? null : booked.has(record.id),
    });
  }
  return stages;
}

/**
 * The page's requests that already booked a night (a CONFIRMED hold), in ONE
 * query. DELIBERATE SWALLOW (ReporterPort convention): a failed read returns
 * null — "could not tell" — and is logged AND reported; a throwing reporter
 * changes nothing.
 */
async function resolveBookedNights(
  deps: Pick<ListBookingRequestsDeps, "repos" | "logger" | "reportError">,
  records: BookingRequestRecord[],
  scope: ListBookingRequestsInput["scope"],
): Promise<Set<string> | null> {
  const holdsRepo = deps.repos.bookingHolds;
  if (!holdsRepo) {
    throw fail("NOT_CONFIGURED", { message: "bookingHolds repo missing" });
  }
  const ids = records.filter((r) => r.direction === "TO_VENUE").map((r) => r.id);
  if (ids.length === 0) return new Set();
  try {
    return new Set(await holdsRepo.listRequestIdsWithConfirmedHold(ids));
  } catch (error) {
    deps.logger?.error("booking_requests.list.booked_nights_lookup_failed", {
      scope,
      requestCount: ids.length,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "listBookingRequests", step: "bookedNights" },
        extra: { scope, requestCount: ids.length },
      });
    } catch {
      // Best-effort: a throwing reporter must not undo the fallback.
    }
    return null;
  }
}

/**
 * BATCH-resolve the booking-holds WORKFLOW projection (live holds, assignee,
 * org tags) for every row on the page — the data behind the Holds tab, the
 * "Assigned to" column and the tag chips (spec FR-011 / FR-015 / FR-017).
 *
 * VIEWER SCOPING (the security-relevant part): assignee and tags are
 * VENUE-INTERNAL. On the performer scopes (`performer`, `performer-inbox`)
 * they are never even READ — the projection returns `null` / `[]` for them
 * by construction. Holds ARE shown to the act, but only its own (they hang
 * off its own request; a line's other members are other requests, which
 * this scope cannot list).
 *
 * COST: ONE `listLiveForRequests` + ONE `listForRequests` for the whole page
 * (zero when the page is empty), plus one `places.getById` per DISTINCT
 * place that has a live hold — needed for the place zone the lazy-expiry
 * predicate runs in (FR-010 is "before today in the PLACE's timezone"). No
 * batch place read exists on the port; holds are rare enough per page that
 * the per-place read is bounded by the number of venues with a live hold,
 * never by the number of rows.
 *
 * READS NEVER WRITE: a lapse is projected (`lapsed: true`), not settled.
 *
 * DELIBERATE SWALLOW (ReporterPort convention, same posture as
 * `resolveBookingStages`): a failed holds/tags read degrades every row to
 * {@link NO_WORKFLOW} — the inbox still renders — and is logged AND
 * reported. Unwired repos throw NOT_CONFIGURED before the try, exactly like
 * the stage projection.
 */
async function resolveBookingWorkflow(
  deps: Pick<ListBookingRequestsDeps, "repos" | "logger" | "reportError" | "clock">,
  records: BookingRequestRecord[],
  side: BookingThreadSide,
  scope: ListBookingRequestsInput["scope"],
): Promise<Map<string, BookingWorkflow>> {
  const holdsRepo = deps.repos.bookingHolds;
  const tagsRepo = deps.repos.bookingTags;
  if (!holdsRepo || !tagsRepo) {
    throw fail("NOT_CONFIGURED", {
      message: "bookingHolds/bookingTags repo missing",
    });
  }
  if (records.length === 0) return new Map();

  const now = deps.clock?.now() ?? new Date();
  const ids = records.map((record) => record.id);
  const venueSide = side === "VENUE";

  try {
    const [holds, tagRows] = await Promise.all([
      holdsRepo.listLiveForRequests(ids),
      // Venue-internal: not even read for the act.
      venueSide ? tagsRepo.listForRequests(ids) : Promise.resolve([]),
    ]);

    // Place zone per request that has a live hold (distinct places only).
    const recordsById = new Map(records.map((r) => [r.id, r]));
    const placeIds = new Set<string>();
    for (const hold of holds) {
      const placeId = recordsById.get(hold.bookingRequestId)?.placeId;
      if (placeId) placeIds.add(placeId);
    }
    const places = await Promise.all(
      [...placeIds].map(async (placeId) => [placeId, await deps.repos.places.getById(placeId)] as const),
    );
    const zoneByPlace = new Map(
      places.map(([placeId, place]) => [placeId, resolveBookingTimezone(place?.timezone ?? null)]),
    );

    const holdsByRequest = new Map<string, BookingWorkflow["holds"]>();
    for (const hold of holds) {
      const record = recordsById.get(hold.bookingRequestId);
      if (!record) continue;
      const zone =
        (record.placeId ? zoneByPlace.get(record.placeId) : undefined) ??
        resolveBookingTimezone(null);
      const list = holdsByRequest.get(hold.bookingRequestId) ?? [];
      list.push({
        id: hold.id,
        calendarId: venueSide ? hold.calendarId : null,
        date: hold.date,
        position: hold.position,
        status: hold.status,
        respondBy: hold.respondBy,
        lapsed: isHoldLapsed(hold, now, zone) !== null,
        askedFor: isAskedForNight(record, hold.date, zone),
      });
      holdsByRequest.set(hold.bookingRequestId, list);
    }

    const tagsByRequest = new Map<string, BookingWorkflow["tags"]>();
    for (const row of tagRows) {
      const list = tagsByRequest.get(row.bookingRequestId) ?? [];
      list.push({ id: row.tag.id, name: row.tag.name, color: row.tag.color });
      tagsByRequest.set(row.bookingRequestId, list);
    }

    const workflow = new Map<string, BookingWorkflow>();
    for (const record of records) {
      workflow.set(record.id, {
        holds: holdsByRequest.get(record.id) ?? [],
        // `?? null`: a pre-holds row shape (older fixtures / adapters mid-
        // deploy) must read as "unassigned", never as an undefined field that
        // fails the strict output schema and blanks the whole inbox.
        assigneeHumanId: venueSide ? (record.assigneeHumanId ?? null) : null,
        tags: tagsByRequest.get(record.id) ?? [],
      });
    }
    return workflow;
  } catch (error) {
    deps.logger?.error("booking_requests.list.workflow_lookup_failed", {
      scope,
      side,
      requestCount: records.length,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "listBookingRequests", step: "bookingWorkflow" },
        extra: { scope, side, requestCount: records.length },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // degrade-to-empty fallback into a thrown error.
    }
    return new Map();
  }
}

/**
 * Who is reading the bill: the VENUE side (a declined act is hidden) or the
 * SENDER (kept, rendered struck) — FR-004.
 */
type BillAudience = "venue" | "sender";

/** One page's bills, and whether the read degraded (→ `billUnavailable`). */
type BookingBills = {
  byRequest: Map<string, BookingRequestBillItem[]>;
  unavailable: boolean;
};

const NO_BILLS: BookingBills = { byRequest: new Map(), unavailable: false };

/**
 * BATCH-resolve the bill (lineup-booking-requests v2) for every TO_VENUE row
 * on the page: ONE `listActsForRequests` for the whole page, then ONE pass of
 * identity reads (`resolveBillIdentities`: humans + orgs + their pages) for
 * every platform act on it — never per row, never per act (NFR-003).
 *
 * VIEWER SCOPING: the venue audience never receives a DECLINED act (FR-004 —
 * hidden, not struck); the sender keeps it. Applied here, with the data, so
 * a client that does not know to hide a row never gets it.
 *
 * CROSS-ORG ISOLATION: the request ids come off rows the scope already
 * authorized, and the owner ids come off THOSE requests' act rows — nothing
 * from input enters the batch.
 *
 * DELIBERATE SWALLOW (ReporterPort convention, same posture as
 * `resolveBookingWorkflow`): a failed bill read degrades every row to `[]`
 * with `billUnavailable: true` — so a UI can tell "could not read" from "no
 * bill" and never misstate who is playing — and is logged AND reported. A
 * throwing reporter changes nothing.
 */
async function resolveBookingBills(
  deps: Pick<ListBookingRequestsDeps, "repos" | "logger" | "reportError">,
  records: BookingRequestRecord[],
  audience: BillAudience,
  scope: ListBookingRequestsInput["scope"],
): Promise<BookingBills> {
  // Only TO_VENUE requests carry a bill (NFR-004). Every scope that reaches
  // here lists TO_VENUE rows already; the filter keeps the rule local.
  const ids = records
    .filter((record) => record.direction === "TO_VENUE")
    .map((record) => record.id);
  if (ids.length === 0) return NO_BILLS;

  try {
    const acts = await deps.repos.bookingRequests.listActsForRequests(ids);
    if (acts.length === 0) return NO_BILLS;

    const identities = await resolveBillIdentities(deps.repos, acts);

    const actsByRequest = new Map<string, typeof acts>();
    for (const act of acts) {
      const list = actsByRequest.get(act.bookingRequestId) ?? [];
      list.push(act);
      actsByRequest.set(act.bookingRequestId, list);
    }

    const bills = new Map<string, BookingRequestBillItem[]>();
    for (const [requestId, requestActs] of actsByRequest) {
      bills.set(
        requestId,
        toBillItems(requestActs, identities, {
          hideDeclined: audience === "venue",
        }),
      );
    }
    return { byRequest: bills, unavailable: false };
  } catch (error) {
    deps.logger?.error("booking_requests.list.bill_lookup_failed", {
      scope,
      audience,
      requestCount: ids.length,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "listBookingRequests", step: "bookingBills" },
        extra: { scope, audience, requestCount: ids.length },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // degrade-to-empty fallback into a thrown error.
    }
    return { byRequest: new Map(), unavailable: true };
  }
}

/**
 * Map records → summaries, belt-and-braces: one corrupt row (sender-invariant
 * violation) must NEVER take down the whole inbox/sent-list. The bad row is
 * skipped and reported via `reportError` (deliberate-swallow convention —
 * without it the corruption would be invisible to operators).
 */
function toSummaries(
  records: BookingRequestRecord[],
  displayNames: Map<string, string>,
  unreadCounts: Map<string, number>,
  stages: Map<string, BookingStage>,
  deps: Pick<ListBookingRequestsDeps, "logger" | "reportError">,
  workflow: Map<string, BookingWorkflow> = new Map(),
  bills: BookingBills = NO_BILLS,
): BookingRequestSummary[] {
  const summaries: BookingRequestSummary[] = [];
  for (const record of records) {
    try {
      const sender = getBookingRequestSender(record);
      const displayName =
        sender.kind === "owned" && !isUnclaimedBookingInquiry(record)
          ? (displayNames.get(
              performerOwnerKey(
                sender.performerOwnerType,
                sender.performerOwnerId,
              ),
            ) ?? null)
          : null;
      // Zero-fill: `countUnreadByRequest` omits requests with no unread rows.
      // Null-fill: `resolveBookingStages` omits rows with no agreement (and
      // every row when the lookup itself degraded).
      summaries.push(
        toBookingRequestSummary(
          record,
          displayName,
          unreadCounts.get(record.id) ?? 0,
          stages.get(record.id) ?? NO_STAGE,
          workflow.get(record.id) ?? NO_WORKFLOW,
          // Empty-fill: legacy requests (no act rows), TO_PERFORMER rows and
          // a degraded bill lookup all read as "no bill".
          bills.byRequest.get(record.id) ?? [],
          // Only rows whose bill was actually asked for: TO_PERFORMER rows
          // carry none, so a failed read says nothing about them.
          bills.unavailable && record.direction === "TO_VENUE",
        ),
      );
    } catch (error) {
      deps.logger?.error("booking_requests.list.corrupt_row_skipped", {
        bookingRequestId: record.id,
        placeId: record.placeId,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "listBookingRequests" },
          extra: { bookingRequestId: record.id, placeId: record.placeId },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn the
        // skip-one-row fallback into a thrown error.
      }
    }
  }
  return summaries;
}

/**
 * The cross-venue inbox for ONE owning subject — the body behind BOTH
 * `scope: "org-venues"` and `scope: "human-venues"`. One function, so the two
 * scopes cannot drift apart on enumeration, backstop, side or truncation.
 *
 * NOT authz: the caller has already gated (org membership for an org subject;
 * for a human subject the owner IS the actor). What this does is scope.
 */
async function listOwnedVenuesInbox(
  deps: ListBookingRequestsDeps,
  input: ListBookingRequestsInput,
  subject: OwnerScope,
): Promise<ListBookingRequestsOutput> {
  // Log/report identity for the subject. The org shape keeps its historical
  // `orgId` key (operators already search on it); the human shape names the
  // owner explicitly so a dropped-row report can never be misread as an org.
  const ownerFields =
    subject.kind === "org"
      ? { orgId: subject.orgId }
      : { ownerHumanId: subject.humanId };
  const backstopStep =
    subject.kind === "org" ? "orgVenueScope" : "humanVenueScope";

  // THE SAME enumeration `countOpenBookingRequests` uses — one helper, so a
  // venue can never appear in the badge rail and be missing from the inbox
  // it links to (or the reverse).
  const owned = await listOwnerScopePlaces(deps.repos, subject);
  const ownedPlaceIds = owned.places.map((place) => place.id);

  if (owned.truncated) {
    // Never silent: the flag rides the response AND the cut is logged, so a
    // partial inbox is legible from both the UI and the operator side.
    deps.logger?.info("booking_requests.list.owned_places_truncated", {
      scope: input.scope,
      ...ownerFields,
      ownedPlaceCount: ownedPlaceIds.length,
    });
  }

  const records = await deps.repos.bookingRequests.listForPlaces({
    placeIds: ownedPlaceIds,
    statuses: input.statuses,
  });

  // CROSS-OWNER BACKSTOP. The repo already scopes by `placeId IN (owned)`, so
  // a foreign row means the query or the enumeration is broken — the single
  // worst failure this surface can have, and the one it must not render.
  // Belt-and-braces (same posture as the corrupt-row skip in `toSummaries`):
  // drop the row and REPORT it, because a leak that only shows up in
  // someone's UI is a leak nobody is paged for.
  const ownedPlaceIdSet = new Set(ownedPlaceIds);
  const scoped = records.filter((record) => {
    if (record.placeId && ownedPlaceIdSet.has(record.placeId)) return true;
    deps.logger?.error("booking_requests.list.foreign_place_row_dropped", {
      scope: input.scope,
      ...ownerFields,
      bookingRequestId: record.id,
      placeId: record.placeId,
    });
    try {
      deps.reportError?.(
        new Error("booking_requests.list.foreign_place_row_dropped"),
        {
          tags: { useCase: "listBookingRequests", step: backstopStep },
          extra: {
            ...ownerFields,
            bookingRequestId: record.id,
            placeId: record.placeId,
          },
        },
      );
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // drop-the-foreign-row backstop into a thrown error.
    }
    return false;
  });

  // Reads as VENUE, exactly like the single-venue inbox: the enum's VENUE
  // slot is "the non-act party", which on a TO_VENUE thread is the place's
  // owners/staff (side table in messages/_shared/thread-access.ts). Same ONE
  // batched count call for the whole page — this inbox spans up to 100
  // venues, so a per-row lookup here would be the worst N+1 in the file.
  const [displayNames, unreadCounts, stages, workflow, bills] =
    await Promise.all([
      resolvePerformerDisplayNames(deps.repos, scoped),
      resolveUnreadCounts(deps, scoped, "VENUE", input.scope),
      // Runs on `scoped`, NOT `records`: a dropped foreign row must not even
      // have its agreement (or its bill) looked up.
      resolveVenueBookingStages(deps, scoped, input.scope),
      resolveBookingWorkflow(deps, scoped, "VENUE", input.scope),
      resolveBookingBills(deps, scoped, "venue", input.scope),
    ]);

  return listBookingRequestsOutputSchema.parse({
    requests: toSummaries(
      scoped,
      displayNames,
      unreadCounts,
      stages,
      deps,
      workflow,
      bills,
    ),
    ownedPlacesTruncated: owned.truncated,
  });
}

/**
 * Booking-request lists, one per surface (spec FR-002 +
 * organizer-booking-requests FR-007/FR-008). Direction scoping is enforced in
 * the repo queries (NFR-001) — no scope can ever return the other direction.
 *
 * - `scope: "venue"` — requires `placeId` and place ownership (direct human
 *   owner or member of an owning org). Viewing the inbox does NOT require the
 *   place to be VERIFIED — only ownership. TO_VENUE received.
 * - `scope: "org-venues"` — requires `orgId`; org membership (any role) to
 *   view. TO_VENUE received across EVERY place the org owns, so the org-level
 *   Bookings page is a real inbox rather than a set of link-outs. Rows carry
 *   `placeId`/`placeName` (denormalized on every read by the adapter's
 *   `RELATED_INCLUDE`), which is what lets that page group by venue. The owned
 *   set is capped; the cut is reported via `ownedPlacesTruncated`, never
 *   swallowed.
 * - `scope: "human-venues"` — the same inbox for the PERSONAL admin: venues
 *   the actor owns directly (PlaceOwnership ownerType HUMAN) plus the venues
 *   of every org the actor belongs to. The owner is the actor, so
 *   there is no membership gate — a human may always read their own venues'
 *   inboxes, exactly as `requirePlaceOwnership` already grants per venue.
 *   Identical enumeration, backstop and truncation contract to "org-venues".
 * - `scope: "performer"` — the act's SENT pitches (TO_VENUE). Defaults to
 *   the actor's human identity; an org sender ref requires membership in
 *   that org (any role — viewing is not privileged beyond membership).
 * - `scope: "organizer"` — requires `organizerOrgId`; org membership (any
 *   role) to view. TO_PERFORMER sent.
 * - `scope: "performer-inbox"` — the act's RECEIVED organizer requests
 *   (TO_PERFORMER). Same owner defaulting/authz as "performer".
 */
export async function listBookingRequests(
  deps: ListBookingRequestsDeps,
  rawInput: unknown,
): Promise<ListBookingRequestsOutput> {
  const input = parseInput(listBookingRequestsInputSchema, rawInput);

  if (input.scope === "venue") {
    if (!input.placeId) {
      throw fail("PLACE_ID_REQUIRED");
    }

    const place = await deps.repos.places.getById(input.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }

    await requirePlaceOwnership(deps.repos, place, input.actorHumanId);

    const records = await deps.repos.bookingRequests.listForPlace({
      placeId: place.id,
      statuses: input.statuses,
    });
    // The venue inbox reads as VENUE — the place's owners/staff on a TO_VENUE
    // thread (see the side table in messages/_shared/thread-access.ts).
    const [displayNames, unreadCounts, stages, workflow, bills] =
      await Promise.all([
        resolvePerformerDisplayNames(deps.repos, records),
        resolveUnreadCounts(deps, records, "VENUE", input.scope),
        resolveVenueBookingStages(deps, records, input.scope),
        resolveBookingWorkflow(deps, records, "VENUE", input.scope),
        // Venue-facing: DECLINED acts never reach this inbox (FR-004).
        resolveBookingBills(deps, records, "venue", input.scope),
      ]);

    return listBookingRequestsOutputSchema.parse({
      requests: toSummaries(
        records,
        displayNames,
        unreadCounts,
        stages,
        deps,
        workflow,
        bills,
      ),
    });
  }

  if (input.scope === "org-venues") {
    if (!input.orgId) {
      throw fail("ORGANIZATION_NOT_FOUND", { message: "org_id_required" });
    }

    // Same bar as viewing ONE of those venues' inboxes and as
    // `countOpenBookingRequests`: membership, any role. Viewing is not
    // privileged beyond membership; the write paths (respond/withdraw/post)
    // keep their own edit-role gates.
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });

    return listOwnedVenuesInbox(deps, input, {
      kind: "org",
      orgId: input.orgId,
    });
  }

  if (input.scope === "human-venues") {
    // NO membership gate, on purpose: the scope carries no id — the subject IS
    // the actor by construction, so a caller cannot name another human. The
    // enumeration in `listOwnerScopePlaces` is itself the authorization:
    // VERIFIED, non-revoked ownership rows on ACTIVE places, for THIS actor
    // directly AND for every org THIS actor belongs to — a strict SUBSET of
    // what `requirePlaceOwnership` allows per venue (it checks no place
    // status, and membership-any is exactly its view bar), the same asymmetry
    // `countOpenBookingRequests` documents for orgs.
    //
    // The org venues are in here because the PERSONAL admin is a hub, not a
    // tenant: it answers "what is waiting on me", across everything. The
    // per-ORG Bookings page stays strictly single-tenant — see
    // `listOwnerScopePlaces` for why the two are deliberately asymmetric.
    return listOwnedVenuesInbox(deps, input, {
      kind: "human",
      humanId: input.actorHumanId,
    });
  }

  if (input.scope === "organizer") {
    if (!input.organizerOrgId) {
      throw fail("ORGANIZATION_NOT_FOUND", {
        message: "organizer_org_id_required",
      });
    }

    // Viewing the org's outbound list is membership-any (the Bookings hub is
    // org-visible); withdraw/respond actions stay ORG_EDIT_ROLES in their
    // own use cases.
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.organizerOrgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });

    const records = await deps.repos.bookingRequests.listForOrganizer({
      organizerOrgId: input.organizerOrgId,
      statuses: input.statuses,
    });
    // The "performer display name" on TO_PERFORMER rows is the TARGET act —
    // exactly what the organizer list renders per row.
    //
    // The organizer viewer's side is VENUE, not PERFORMER: the enum's VENUE
    // slot is "the non-act party" in BOTH directions, so on a TO_PERFORMER
    // thread the SENDER organizer org sits in the VENUE slot (side table in
    // messages/_shared/thread-access.ts). Reading this as PERFORMER would
    // badge the organizer with its OWN outbound messages and hide the act's
    // replies — the exact inversion this field exists to prevent.
    const [displayNames, unreadCounts, stages] = await Promise.all([
      resolvePerformerDisplayNames(deps.repos, records),
      resolveUnreadCounts(deps, records, "VENUE", input.scope),
      resolveBookingStages(deps, records, input.scope),
    ]);

    return listBookingRequestsOutputSchema.parse({
      requests: toSummaries(records, displayNames, unreadCounts, stages, deps),
    });
  }

  // Performer scopes ("performer" sent / "performer-inbox" received) share
  // owner defaulting + authz: self for a human act, org membership (any
  // role) for an org act. The workspace scopes (v3 FR-014) read the same
  // rows for the admin workspace's subject, behind its gate.
  const { ownerType, ownerId } = await resolveSenderSubject(deps, input);
  const sent = input.scope === "performer" || input.scope === "sent-to-venues";

  const records = sent
    ? await deps.repos.bookingRequests.listForPerformer({
        ownerType,
        ownerId,
        statuses: input.statuses,
      })
    : await deps.repos.bookingRequests.listForPerformerInbox({
        ownerType,
        ownerId,
        statuses: input.statuses,
      });
  // Both performer scopes read the thread AS THE ACT — side PERFORMER in
  // either direction.
  // The act sees its OWN holds (FR-013) — and never the venue's assignee or
  // tags, which `resolveBookingWorkflow` nulls on the PERFORMER side. The
  // organizer-request inbox ("performer-inbox") holds TO_PERFORMER rows,
  // which own no holds by construction; the read is a cheap empty.
  //
  // The bill: the SENDER's view on "performer" (their sent TO_VENUE
  // requests — declined acts kept, rendered struck). "performer-inbox" rows
  // are TO_PERFORMER, which carry no bill (NFR-004): not even read.
  const [displayNames, unreadCounts, stages, workflow, bills] =
    await Promise.all([
      resolvePerformerDisplayNames(deps.repos, records),
      resolveUnreadCounts(deps, records, "PERFORMER", input.scope),
      resolveBookingStages(deps, records, input.scope),
      resolveBookingWorkflow(deps, records, "PERFORMER", input.scope),
      sent
        ? resolveBookingBills(deps, records, "sender", input.scope)
        : Promise.resolve(NO_BILLS),
    ]);

  return listBookingRequestsOutputSchema.parse({
    requests: toSummaries(
      records,
      displayNames,
      unreadCounts,
      stages,
      deps,
      workflow,
      bills,
    ),
  });
}

/**
 * The sender / act subject of the performer-side scopes, authorized:
 *   · "performer" / "performer-inbox" — `performerOwnerType/Id`, defaulting
 *     to the actor; another person is NOT_RESOURCE_OWNER, an org needs
 *     membership (any role — viewing is not privileged beyond membership);
 *   · "sent-to-venues" / "received-as-performer" (v3 FR-014) — the admin
 *     workspace's subject: `orgId` → that org, behind the workspace's gate
 *     (ORG_EDIT_ROLES, the bar to send or withdraw as it); no `orgId` → the
 *     actor. A caller can never name another person here: there is no
 *     person id on these scopes.
 */
async function resolveSenderSubject(
  deps: ListBookingRequestsDeps,
  input: ListBookingRequestsInput,
): Promise<{ ownerType: "human" | "organization"; ownerId: string }> {
  if (
    input.scope === "sent-to-venues" ||
    input.scope === "received-as-performer"
  ) {
    if (!input.orgId) {
      return { ownerType: "human", ownerId: input.actorHumanId };
    }
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
    return { ownerType: "organization", ownerId: input.orgId };
  }

  const ownerType =
    input.performerOwnerType === "org" ? "organization" : "human";
  const ownerId = input.performerOwnerId ?? input.actorHumanId;
  if (ownerType === "human") {
    if (ownerId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER");
    }
  } else {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: ownerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });
  }
  return { ownerType, ownerId };
}
