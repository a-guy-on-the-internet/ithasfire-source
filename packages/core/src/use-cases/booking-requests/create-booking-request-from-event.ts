import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";
import type { BookingIntent } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";
import { fail, isAppError } from "@th/errors";

import { ORG_EDIT_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { isVenueOwnedEvent } from "../../lib/venue-confirmation";
import { resolveTimeZone, toLocalParts } from "../../lib/venue-local-time";
import { toPerformerOwnerType } from "../performers/set-performer-mode";
import { DAY_MS } from "./constants";
import {
  BOOKING_PURPOSE_MAX_LENGTH,
  BOOKING_WINDOW_MAX_DAYS,
  runBookingRequestGates,
  writeBookingRequestInTx,
} from "./create-booking-request";
import type { BookingRequestNotificationIntent } from "./_shared/booking-request-intents";

// ─────────────────────────────────────────────────────────────────────────────
// createBookingRequestFromEvent — the EVENT-FIRST entry path (venue-
// confirmation-and-booking-intents spec, docs/specs/2026-08-27 "Two entry
// paths, one request" / Use Cases › Requests).
//
// "The builder names a place and a calendar. If that calendar accepts the
// chosen intent, saving the event auto-creates the booking request — the
// request is now the venue approving an event." The request is the SAME row
// a pitch produces (same gates, same ledger), plus `originEventId`, so
// `confirmVenueEvent` by request stamps the event instead of minting one.
//
// TRANSACTION PARTICIPANT, like `appendBookingSystemEntry`: it takes the
// event save's `TxRepos` and runs AFTER the event row is written, so the
// event and its request commit together. The notifications it owes ride the
// save's output as intents (dispatched post-commit by transport).
//
// WHAT IT NEVER THROWS FOR — "no request, no error" (spec: "A place with no
// calendar accepting that intent can still be chosen as a plain address-only
// location: no request, no badge, nothing to confirm"):
//   · the event is not at a place, or names no calendar;
//   · the event is VENUE-OWNED (confirmed by construction — nothing to ask);
//   · the owner (org or person) is the grantee of an active booking grant
//     for the place (the save path stamps those; see `finalizeSaveEvent`);
//   · the owner is nobody (an ownerless community listing has no requester);
//   · the venue is not taking this ask — the gate walk's ACCEPTANCE
//     refusals, `EVENT_FIRST_SKIP_CODES` below. The spec names only the
//     calendar toggle; an UNCLAIMED venue (PLACE_NOT_TAKING_REQUESTS,
//     amendment 2026-09-25), the claimed venue's opt-out, an unverified claimed
//     place, unconfigured hours and a night outside them are the same fact
//     from the builder's seat ("this venue is not taking requests for this
//     right now") and would otherwise fail an event save the organizer can
//     do nothing about. The event attaches address-only in every one.
//   · PERFORM by a sender without performer mode (`sender_not_eligible`).
//     The pitch's gate APPLIES — no PERFORM request is created for a
//     non-performer — but it cannot fail the save: a promoter org that never
//     enabled performer mode saves shows at venues every day, and its event
//     must land (address-only) rather than bounce. The builder should offer
//     PERFORM to performers only; this is the server-side backstop.
//
// WHAT IT DOES THROW FOR — caller bugs and hard refusals, which fail the
// save: the actor is not the owner (NOT_RESOURCE_OWNER / INSUFFICIENT_ROLE),
// the place vanished (PLACE_NOT_FOUND), a foreign calendar or a space not on
// it (CALENDAR_NOT_FOUND / `space_not_on_calendar`), RENT/USE without a
// window (`window_*` — the ROOM is not required, owner ruling 2026-09-22),
// and a second OPEN request by this sender at this place
// (DUPLICATE_OPEN_REQUEST — the DB partial unique refuses it too; the
// organizer resolves it by withdrawing the other request).
//
// IDEMPOTENT ON `originEventId` (unique): a second save of the same event
// finds the first request and creates nothing, whatever its status. A later
// save that MOVES the event to another place or calendar therefore does NOT
// create a second request — the first stays, pointing at the old place. The
// venue there can still "not mine" it; the new venue gets no request until
// the organizer withdraws the first. Decided here, not by the spec; flagged.
//
// EXPIRY is the pitch's `now + 14 days` (FR-003), unchanged: a request for
// an event three months out expires before the show if the venue never
// looks. The spec is silent on an event-anchored TTL; flagged, not decided.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two skip reasons that come out of the gate walk — "the venue is not
 * taking this ask" / "this sender may not ask" — and therefore REACH THE
 * BUILDER (save output `bookingRequest.outcome === "skipped"`, owner ruling
 * 2026-09-08: a venue with no hours, a closed night, a paused venue or a
 * sender without performer mode must not save into silence). The source of
 * truth for the wire's `reason` enum; the internal reasons below never
 * cross the wire.
 */
export const EVENT_FIRST_ABSORBED_SKIP_REASONS = [
  "venue_not_accepting",
  "sender_not_eligible",
] as const;
export type EventFirstAbsorbedSkipReason =
  (typeof EVENT_FIRST_ABSORBED_SKIP_REASONS)[number];

/**
 * The gate-walk refusals that mean "the venue is not taking this ask" and
 * are absorbed into `outcome: "skipped"` on the event-first path. Everything
 * else the walk throws propagates and fails the save.
 */
export const EVENT_FIRST_SKIP_CODES: ReadonlyArray<{
  code: string;
  /** When set, only that machine message of the code is absorbed. */
  message?: string;
  reason: EventFirstAbsorbedSkipReason;
}> = [
  { code: "INVALID_INPUT", message: "calendar_rejects_intent", reason: "venue_not_accepting" },
  // Amendment 2026-09-25: an unclaimed venue takes no requests. The event
  // still saves at the place, address-only, as it always could.
  { code: "PLACE_NOT_TAKING_REQUESTS", reason: "venue_not_accepting" },
  { code: "PLACE_NOT_VERIFIED", reason: "venue_not_accepting" },
  { code: "PLACE_NOT_ACCEPTING_REQUESTS", reason: "venue_not_accepting" },
  { code: "BOOKING_DATE_UNAVAILABLE", reason: "venue_not_accepting" },
  { code: "PERFORMER_MODE_REQUIRED", reason: "sender_not_eligible" },
];

/**
 * "Not applicable" — the event-first block had nothing to ask (no place /
 * calendar / owner) or the venue is confirmed by construction. These
 * collapse to `bookingRequest: null` on the wire.
 */
export type EventFirstInternalSkipReason =
  | "no_place"
  | "no_calendar"
  | "no_owner"
  | "venue_owned"
  | "grant_holder";

export type EventFirstSkipReason =
  | EventFirstInternalSkipReason
  | EventFirstAbsorbedSkipReason;

export type CreateBookingRequestFromEventRepos = TxRepos;

/** The saved event row the request is derived from. */
export type EventFirstSourceEvent = Pick<
  EventRecord,
  | "id"
  | "orgId"
  | "humanId"
  | "placeId"
  | "calendarId"
  | "spaceId"
  | "title"
  | "startsAt"
  | "endsAt"
>;

export type CreateBookingRequestFromEventArgs = {
  event: EventFirstSourceEvent;
  /** What the builder asked the venue for. Defaults to PERFORM. */
  intent?: BookingIntent;
  /**
   * The human saving the event — must be the event's owner (self for a
   * human-owned event; an EDIT-role member for an org-owned one). `null` is
   * the SYSTEM actor, allowed ONLY for the legacy migration: no access check
   * (there is nobody to check), and the ledger / audit record no author.
   */
  actorHumanId: string | null;
  now: Date;
  /** `"bypass"` ONLY for the legacy migration — see `runBookingRequestGates`. */
  performerGate?: "enforce" | "bypass";
  logger?: LoggerPort;
};

export type CreateBookingRequestFromEventResult =
  | {
      outcome: "created";
      bookingRequestId: string;
      /** The venue the request went to — what the builder names in its
       * "Sent to <venue> for confirmation" line (save output `bookingRequest`). */
      placeId: string;
      placeName: string | null;
      intent: BookingIntent;
      /**
       * Always false: a new request is never parked (amendment 2026-09-25).
       * Kept on the save's wire output until the builder's read of it and
       * the `parkedUnclaimedAt` column go together.
       */
      parked: false;
      notificationIntents: BookingRequestNotificationIntent[];
    }
  | {
      outcome: "existing";
      bookingRequestId: string;
      /** From the re-found row (denormalized), so the re-save reports the
       * SAME venue the first save did even if the event has since moved. */
      placeId: string;
      placeName: string | null;
      /** The ROW's intent — a re-save asking for something else still finds this one. */
      intent: BookingIntent;
      /**
       * A request parked before the amendment and not yet cleaned up
       * (`parkedUnclaimedAt` set). Readable for old rows only; nothing
       * writes the stamp any more.
       */
      parked: boolean;
      notificationIntents: [];
    }
  | EventFirstInternalSkip
  | EventFirstAbsorbedSkip;

/** Nothing to ask — see `EventFirstInternalSkipReason`. */
export type EventFirstInternalSkip = {
  outcome: "skipped";
  reason: EventFirstInternalSkipReason;
  notificationIntents: [];
};

/**
 * The gate walk refused the ask and the save absorbed it. Carries what the
 * builder needs to say so — which venue, what was asked, and the refusal's
 * own code + machine message (`PLACE_NOT_ACCEPTING_REQUESTS` /
 * `booking_requests_unconfigured` for a venue that has never set hours,
 * `BOOKING_DATE_UNAVAILABLE` for a closed night, …).
 */
export type EventFirstAbsorbedSkip = {
  outcome: "skipped";
  reason: EventFirstAbsorbedSkipReason;
  code: string;
  message: string;
  placeId: string;
  placeName: string | null;
  intent: BookingIntent;
  notificationIntents: [];
};

/** Narrows a result to the skip that reaches the builder. */
export function isEventFirstAbsorbedSkip(
  result: CreateBookingRequestFromEventResult,
): result is EventFirstAbsorbedSkip {
  return (
    result.outcome === "skipped" &&
    (EVENT_FIRST_ABSORBED_SKIP_REASONS as readonly string[]).includes(
      result.reason,
    )
  );
}

const NONE: [] = [];

export async function createBookingRequestFromEvent(
  tx: CreateBookingRequestFromEventRepos,
  args: CreateBookingRequestFromEventArgs,
): Promise<CreateBookingRequestFromEventResult> {
  const { event, now } = args;
  const intent: BookingIntent = args.intent ?? "PERFORM";
  const logger = args.logger?.child({
    useCase: "createBookingRequestFromEvent",
  });

  const placeId = event.placeId ?? null;
  if (placeId === null) {
    return skipped("no_place");
  }
  const calendarId = event.calendarId ?? null;
  if (calendarId === null) {
    return skipped("no_calendar");
  }

  // The requester is the event's owner — the performer-owner pair (spec:
  // "requester = the event's owner (human, or org via the performer-owner
  // pair)"). Nobody owns a community listing, so nobody is asking.
  const owner = ownerOf(event);
  if (owner === null) {
    return skipped("no_owner");
  }

  // Actor must be that owner — the same sender control the pitch runs
  // (`createBookingRequest` step 1). The save wrappers already asserted it;
  // re-asserted here so the primitive is safe from any caller.
  if (args.actorHumanId !== null) {
    await requireOwnerAccess({
      repos: tx,
      ownerType: owner.type === "human" ? "HUMAN" : "ORGANIZATION",
      ownerId: owner.id,
      actorHumanId: args.actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
  }

  // Idempotency: one request per origin event, ever. Looked up BEFORE the
  // gates so a re-save of an event whose venue has since paused requests
  // still reports the request it already has.
  const existing = await tx.bookingRequests.findByOriginEventId(event.id);
  if (existing) {
    return {
      outcome: "existing",
      bookingRequestId: existing.id,
      placeId: existing.placeId,
      placeName: existing.placeName,
      intent: existing.intent,
      parked: existing.parkedUnclaimedAt != null,
      notificationIntents: NONE,
    };
  }

  // Venue-owned → confirmed by construction; grant-holder → the save path
  // stamps it. Neither has anything to ask. Read the place ONCE here; the
  // gate walk re-reads it (one extra read on the rare path that gets there
  // is the price of not duplicating the walk).
  const place = await tx.places.getById(placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  if (isVenueOwnedEvent(event, place)) {
    return skipped("venue_owned");
  }
  // The owner as grantee (holds-without-a-request FR-002, the same match
  // `classifyBuilderVenueTrust` makes): an org event's org, a person's
  // event's person. The grantee's own event is confirmed by construction.
  const grant = await tx.placeBookingGrants.findActiveForActor({
    placeId: place.id,
    calendarId,
    humanIds: owner.type === "human" ? [owner.id] : [],
    orgIds: owner.type === "human" ? [] : [owner.id],
    now,
  });
  if (grant && grant.placeId === place.id) {
    return skipped("grant_holder");
  }

  // Per-intent shape — the pitch's `refineIntentShape`, on the event's own
  // fields: RENT/USE are a room + a window + a one-line purpose.
  // The room is OPTIONAL (owner ruling 2026-09-22): an event saved at a
  // calendar without a room picked still asks. The room is chosen at
  // accept/confirm, on the draft event. When the event DOES name one, it is
  // still checked against the routed calendar by the gate walk below.
  const spaceId = event.spaceId ?? undefined;
  let requestedStartsAt: Date | null = null;
  let requestedEndsAt: Date | null = null;
  let purpose: string | null = null;
  if (intent !== "PERFORM") {
    if (!event.endsAt) {
      throw fail("INVALID_INPUT", {
        message: "window_required_for_intent",
        meta: { eventId: event.id, intent },
      });
    }
    const span = event.endsAt.getTime() - event.startsAt.getTime();
    if (span <= 0) {
      throw fail("INVALID_INPUT", {
        message: "window_end_before_start",
        meta: { eventId: event.id, intent },
      });
    }
    if (span > BOOKING_WINDOW_MAX_DAYS * DAY_MS) {
      throw fail("INVALID_INPUT", {
        message: "window_too_long",
        meta: { eventId: event.id, intent },
      });
    }
    requestedStartsAt = event.startsAt;
    requestedEndsAt = event.endsAt;
    // The title is already plain text (sanitized at the save boundary); only
    // the column bound applies.
    purpose = event.title.slice(0, BOOKING_PURPOSE_MAX_LENGTH);
  }

  // The event's place-local day — the venue's zone, as the pitch and the
  // hold lines resolve it (`resolveTimeZone` falls back to the platform
  // default when the place has none).
  const preferredDates = [
    toLocalParts(event.startsAt, resolveTimeZone(place.timezone)).date,
  ];

  // The SAME gate walk the pitch runs (performer mode, place + claimed,
  // hours, calendar accepts the intent, space on the calendar, one open
  // request per sender×place). Acceptance refusals become a skip; the rest
  // fail the save.
  //
  // The venue's booking STANDARDS (venue-booking-standards spec, FR-006) are
  // deliberately NOT enforced here, nor on the legacy-migration caller that
  // reaches this path with `performerGate: "bypass"`: standards say what a
  // PITCH must include, and neither is one. This request is the venue being
  // asked to approve an event that already exists (its dates, title and
  // lineup live on the event), and the migration is a system actor filing a
  // published show. There is no form to have filled in, and refusing the
  // request would silently drop the event's confirmation ask. The pitch
  // entrances (`createBookingRequest`, `createBookingInquiry`) enforce them.
  let gates;
  try {
    gates = await runBookingRequestGates(
      tx,
      { now: () => now, logger },
      {
        ownerType: owner.type,
        ownerId: owner.id,
        intent,
        placeId: place.id,
        calendarId,
        spaceId,
        preferredDates,
        performerGate: args.performerGate ?? "enforce",
      },
    );
  } catch (error) {
    const absorbed = matchSkipCode(error);
    if (!absorbed) throw error;
    logger?.info("booking_requests.event_first.skipped", {
      eventId: event.id,
      placeId: place.id,
      calendarId,
      intent,
      reason: absorbed.reason,
      code: absorbed.code,
      message: absorbed.message,
    });
    return {
      outcome: "skipped",
      reason: absorbed.reason,
      code: absorbed.code,
      message: absorbed.message,
      placeId: place.id,
      placeName: place.name,
      intent,
      notificationIntents: NONE,
    };
  }

  const request = await writeBookingRequestInTx(tx, {
    place: gates.place,
    calendar: gates.calendar,
    ownerType: owner.type,
    ownerId: owner.id,
    actorHumanId: args.actorHumanId,
    now,
    fields: {
      // `message` is NOT NULL and every reader treats it as populated; the
      // event-first request has no pitch, so the event's title stands in.
      message: event.title,
      preferredDates,
      intent,
      spaceId: spaceId ?? null,
      requestedStartsAt,
      requestedEndsAt,
      purpose,
      originEventId: event.id,
      // No pitch fields: the event IS the pitch. Genre / stats / links stay
      // null — the venue opens the event from the thread.
      tags: [],
      verifiedStatsSnapshot: null,
    },
  });

  // The claimed venue's FR-008 "new request" notice, as an intent because
  // this runs inside the save's transaction.
  const notificationIntents: BookingRequestNotificationIntent[] = [
    {
      kind: "request.received",
      bookingRequestId: request.id,
      placeId: place.id,
      at: now,
    },
  ];

  logger?.info("booking_requests.event_first.created", {
    bookingRequestId: request.id,
    eventId: event.id,
    placeId: place.id,
    calendarId: request.calendarId,
    intent,
    performerOwnerType: owner.type,
    performerOwnerId: owner.id,
    actorHumanId: args.actorHumanId,
  });

  return {
    outcome: "created",
    bookingRequestId: request.id,
    placeId: place.id,
    placeName: place.name,
    intent,
    parked: false,
    notificationIntents,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function skipped(reason: EventFirstInternalSkipReason): EventFirstInternalSkip {
  return { outcome: "skipped", reason, notificationIntents: NONE };
}

/**
 * The event's owner as the performer-owner pair; null for an ownerless
 * listing. The stored party convention is `"human" | "organization"` (see
 * `PerformerOwnerType`), NOT the wire `"org"` — mapped through the same
 * `toPerformerOwnerType` the pitch path uses so an org-owned event's
 * performer-mode read and its stored `performerOwnerType` can never drift
 * from a human-owned one's.
 */
export function ownerOf(
  event: Pick<EventRecord, "orgId" | "humanId">,
): { type: PerformerOwnerType; id: string } | null {
  if (event.orgId) {
    return { type: toPerformerOwnerType("org"), id: event.orgId };
  }
  if (event.humanId) {
    return { type: toPerformerOwnerType("human"), id: event.humanId };
  }
  return null;
}

function matchSkipCode(
  error: unknown,
): {
  code: string;
  message: string;
  reason: EventFirstAbsorbedSkipReason;
} | null {
  if (!isAppError(error)) return null;
  const hit = EVENT_FIRST_SKIP_CODES.find(
    (entry) =>
      entry.code === error.code &&
      (entry.message === undefined || entry.message === error.message),
  );
  return hit
    ? { code: error.code, message: error.message, reason: hit.reason }
    : null;
}
