import { enqueueEventFollowers } from "../follows/enqueue-event-followers";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import { AppError, fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { venueStampIsCurrent } from "./_shared/venue-manager-stamp";
import {
  eventOwnerSideSchema,
  type EventOwnerSide,
} from "../booking-agreements/_shared/event-owner-side";
import {
  assertBookingEventLive,
  resolveBookingEvent,
} from "../booking-holds/_shared/booking-night";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  heldDatesOwnerOf,
  settleHeldDatesForEvent,
  type SettleHeldDatesForEventResult,
} from "../booking-holds/settle-held-dates-for-published-event";
import { requirePlaceBookingAuthority } from "../booking-requests/_shared/place-access";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  loadVenueConfirmationContext,
  toVenueConfirmationEventOutput,
  venueConfirmationEventSchema,
  venueConfirmationRecipientFor,
} from "./_shared/venue-confirmation-context";
import {
  venueConfirmationNotificationIntentSchema,
  type VenueConfirmationNotificationIntent,
} from "./_shared/venue-confirmation-intents";
import { markForSearchReindex } from "../search/search-reindex-marks";

/**
 * The adapter's CAS on `(id, placeId)` lost: the event left this place after
 * we loaded it. Surface as a status refusal (the venue must re-look), never
 * as a stamp for a room the event is no longer at.
 */
export function mapEventMoved(
  err: unknown,
  eventId: string,
  placeId: string,
): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "event_place_mismatch"
  ) {
    return new AppError("INVALID_STATUS", {
      message: "event_moved",
      meta: { eventId, placeId },
      cause: err instanceof Error ? err : undefined,
    });
  }
  return err;
}

/**
 * R3-1: the venue confirmed a start the event no longer has. `startsAt` in
 * the meta is the event's CURRENT start when known (the venue can see the
 * event; this lets its screen say what it moved to), null when the move was
 * caught by the write's CAS.
 */
function eventMovedError(
  eventId: string,
  expectedStartsAt: Date,
  startsAt: Date | null,
): AppError {
  return new AppError("EVENT_MOVED", {
    meta: {
      eventId,
      expectedStartsAt: expectedStartsAt.toISOString(),
      startsAt: startsAt ? startsAt.toISOString() : null,
    },
  });
}

/** Terminal request statuses — nothing can be attached to a closed thread. */
const CLOSED_BOOKING_REQUEST_STATUSES = [
  "DECLINED",
  "WITHDRAWN",
  "EXPIRED",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// confirmVenueEvent — the venue vouches for THIS event at THIS place
// (venue-confirmation-and-booking-intents spec, docs/specs/2026-08-27
// "Confirmation lives on the Event", Use Cases › Confirmation).
//
// Venue side only: `requirePlaceBookingAuthority`, the STAFF gate (owner /
// edit-role member; a booking grantee is refused, holds-without-a-request
// FR-002 — its own events are confirmed by construction instead). Stamps
// `venueConfirmedAt` / `…ByHumanId` / `…RequestId` and CLEARS any withdrawal
// (re-confirming after a withdrawal is the normal path).
//
// TWO INPUT SHAPES, one confirmation:
//   · by EVENT (`{ eventId, bookingRequestId? }`) — the direct confirm, the
//     request an optional LINK (ledger entry + provenance);
//   · by REQUEST (`{ bookingRequestId, ownerOverride? }`) — EVENT-FIRST
//     requests only: confirm stamps the request's `originEventId`, the event
//     it was built from. Any other request is refused
//     VENUE_CONFIRMATION_NOT_FOR_REQUESTS (booking-the-night N15 / FR-011):
//     its night is booked by the sender agreeing terms, or by the venue
//     booking without terms — a booked night needs no confirmation, and this
//     path never mints. `ownerOverride` may only agree with the origin's
//     owner side.
//
// CONFIRMATION TAKES THE LINE (booking-holds spec, 2026-09-07): when the
// confirmed event is already PUBLISHED on a calendar, its held dates are
// settled INSIDE the confirmation tx (`settleHeldDatesForEvent`, provenance
// = the request, owner = the event's owner) — the request's own hold is
// CONFIRMED, competitors released. An open challenge on the line refuses the
// confirmation (HOLD_LINE_HAS_OPEN_CHALLENGE) with nothing committed. The
// hold intents ride the output as `holdNotificationIntents` + the routing
// hint; transport dispatches them post-commit and strips them from the wire.
//
// IDEMPOTENT on an already-confirmed event: `alreadyConfirmed: true`, the
// current state, and NO ledger entry / audit row / intent / line taken. A
// retry never double-tells the requester.
//
// A CONFIRMATION IS A VOUCH FOR A DATE (R3-1): both variants carry the
// `expectedStartsAt` the venue saw, and a show moved after the venue's
// screen loaded is refused with EVENT_MOVED (checked up front, and pinned in
// the stamp's CAS). The same stamp is also written by a save or publish from
// someone who MANAGES the venue (W1, `venue-manager-stamp.ts`); the EDITOR
// bar for that is ruled acceptable — an EDITOR of the owning org can already
// read the address and create venue-owned events.
//
// VENUE-OWNED EVENTS ARE STAMPED TOO. They are confirmed by construction
// (`isVenueConfirmed`), so the stamp changes nothing a reader derives — but
// the SQL reads (`venueConfirmedFor`) and the TS derivation must never
// disagree, and a stamped row is the cheaper of the two to keep consistent.
// The owner notification is skipped there: the venue is telling itself.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The start the venue SAW when it clicked confirm (R3-1). REQUIRED on both
 * variants: an organizer can move `startsAt` after the venue's screen
 * loaded, and a confirmation is a vouch for a DATE (N1 records it as
 * `venueConfirmedStartsAt`). A mismatch refuses with `EVENT_MOVED` and
 * writes nothing — the stamp's CAS pins it too, so a move that lands
 * between this check and the write is refused the same way. An ISO string
 * (a `Date` is accepted for superjson callers). Not compared when THIS call
 * mints the event (request variant): that row did not exist a moment ago,
 * so nobody could have moved it; its start comes from the agreement.
 */
const expectedStartsAtSchema = z
  .union([z.iso.datetime({ offset: true }), z.date()])
  .transform((value) => (value instanceof Date ? value : new Date(value)))
  .refine((value) => !Number.isNaN(value.getTime()), "invalid_datetime");

/** Direct confirm of an event the venue can see; the request is a link. */
export const confirmVenueEventByEventInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    expectedStartsAt: expectedStartsAtSchema,
    /**
     * The booking request that produced this confirmation, when there is
     * one. Must be a TO_VENUE request at the event's place. Omitted = a
     * direct confirm (the event's existing request link, if any, is kept).
     */
    bookingRequestId: z.uuid().optional(),
  })
  .strict();

/** Confirm a booking: the event is resolved (or minted) from the request. */
export const confirmVenueEventByRequestInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    expectedStartsAt: expectedStartsAtSchema,
    /**
     * Who owns the event when this confirmation MINTS it (spec "Who mints,
     * who owns"): omitted = default by the request's intent (PERFORM →
     * venue, RENT / USE → requester). On an event that already exists it
     * may only agree with that event's owner side — ownership never moves
     * on confirm (INVALID_STATUS `owner_override_conflicts_with_event`).
     */
    ownerOverride: eventOwnerSideSchema.optional(),
  })
  .strict();

export const confirmVenueEventInputSchema = z.union([
  confirmVenueEventByEventInputSchema,
  confirmVenueEventByRequestInputSchema,
]);

export const confirmVenueEventOutputSchema = z
  .object({
    event: venueConfirmationEventSchema,
    /** True = no write happened; the event was already stamped and not withdrawn. */
    alreadyConfirmed: z.boolean(),
    /** True = this call minted the event before stamping it (request variant). */
    minted: z.boolean(),
    /** Owed post-commit; stripped from the wire (see the wire schema). */
    notificationIntents: z.array(venueConfirmationNotificationIntentSchema),
    /**
     * Booking-hold notifications owed because the confirmation TOOK THE LINE
     * (the event was already PUBLISHED on a calendar). Empty otherwise.
     * Stripped from the wire; dispatched by transport post-commit.
     */
    holdNotificationIntents: z.array(bookingHoldNotificationIntentSchema),
    /** FR-016 routing for the hold intents; null when nothing was owed. */
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable(),
  })
  .strict();

/**
 * What transport puts on the wire: every intent stays server-side.
 * Re-wrapped in `z.object(...shape)` rather than used as the bare `.omit()`
 * result so the wire schema is a plain (non-strict) object: `.strict()`
 * survives `.omit()`, and a strict wire schema would reject the very fields
 * it strips when transport parses the full use-case output through it.
 */
export const confirmVenueEventWireOutputSchema = z.object(
  confirmVenueEventOutputSchema.omit({
    notificationIntents: true,
    holdNotificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type ConfirmVenueEventInput = z.infer<typeof confirmVenueEventInputSchema>;
export type ConfirmVenueEventByEventInput = z.infer<
  typeof confirmVenueEventByEventInputSchema
>;
export type ConfirmVenueEventByRequestInput = z.infer<
  typeof confirmVenueEventByRequestInputSchema
>;
export type ConfirmVenueEventOutput = z.infer<typeof confirmVenueEventOutputSchema>;
export type ConfirmVenueEventWireOutput = z.infer<
  typeof confirmVenueEventWireOutputSchema
>;

export type ConfirmVenueEventDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Threaded into the deliberate-swallow branches (ReporterPort). */
  reportError?: ReporterPort;
};

const NO_HELD_DATES: SettleHeldDatesForEventResult = {
  confirmed: [],
  released: [],
  intents: [],
  staffRecipientHint: null,
};

export async function confirmVenueEvent(
  deps: ConfirmVenueEventDeps,
  rawInput: unknown,
): Promise<ConfirmVenueEventOutput> {
  const input = parseInput(confirmVenueEventInputSchema, rawInput);
  const now = deps.clock.now();
  const logger = deps.logger?.child({ useCase: "confirmVenueEvent" });

  const resolved =
    "eventId" in input
      ? {
          eventId: input.eventId,
          request: input.bookingRequestId
            ? await loadOpenVenueRequest(deps.repos, input.bookingRequestId)
            : null,
          ownerOverride: null,
          minted: false,
        }
      : await resolveEventForRequest(deps, input, now);

  return confirmResolvedEvent(deps, logger, {
    actorHumanId: input.actorHumanId,
    now,
    expectedStartsAt: input.expectedStartsAt,
    ...resolved,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request variant — resolve (or mint) the event the request is about
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a request that something may still be attached to: it must exist and
 * not be closed. Place / owner matching against the event happens later,
 * once the event is known (`confirmResolvedEvent`).
 */
async function loadOpenVenueRequest(
  repos: Pick<Repos, "bookingRequests">,
  bookingRequestId: string,
): Promise<BookingRequestRecord> {
  const request = await repos.bookingRequests.getById(bookingRequestId);
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  if (
    (CLOSED_BOOKING_REQUEST_STATUSES as readonly string[]).includes(
      request.status,
    )
  ) {
    throw fail("INVALID_STATUS", {
      message: "booking_request_closed",
      meta: { bookingRequestId: request.id, status: request.status },
    });
  }
  return request;
}

async function resolveEventForRequest(
  deps: ConfirmVenueEventDeps,
  input: ConfirmVenueEventByRequestInput,
  now: Date,
): Promise<{
  eventId: string;
  request: BookingRequestRecord;
  ownerOverride: EventOwnerSide | null;
  minted: boolean;
}> {
  const request = await loadOpenVenueRequest(deps.repos, input.bookingRequestId);
  if (request.direction !== "TO_VENUE") {
    throw fail("INVALID_INPUT", {
      message: "booking_request_not_venue_bound",
      meta: { bookingRequestId: request.id, direction: request.direction },
    });
  }

  // Venue-side authority on the REQUEST's place, before any event is read
  // (the stamp re-asserts it on the event's calendar — the venue must be
  // authorized at every hop).
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  await requirePlaceBookingAuthority(deps.repos, place, input.actorHumanId);

  // N15 / FR-011: venue confirmation is for events built FIRST. A booking
  // request that was not created from an event books its night by the
  // sender agreeing terms (or the venue booking without terms) — never by a
  // venue confirmation. Refused before anything is read or written.
  if (!request.originEventId) {
    throw fail("VENUE_CONFIRMATION_NOT_FOR_REQUESTS", {
      meta: { bookingRequestId: request.id },
    });
  }

  // The request's event must be live (spec N11; owner rulings 2026-10-01):
  // a cancelled / archived / missing event-first origin refuses ALWAYS — no
  // leftover legacy draft stands in for it — and so does a finalized link to
  // a dead event. The same resolution every booking path's pre-flight uses;
  // refused here before anything is stamped.
  const agreementForCheck = request.agreementId
    ? await deps.repos.agreements.getById(request.agreementId)
    : null;
  assertBookingEventLive(
    await resolveBookingEvent(deps.repos, {
      agreement: agreementForCheck,
      request,
    }),
    { side: "venue", agreementId: request.agreementId ?? null },
  );

  // Event-first: the request was created FROM an event — confirm stamps
  // that event. Nothing is minted and no night is booked here.
  return {
    eventId: request.originEventId,
    request,
    ownerOverride: input.ownerOverride ?? null,
    minted: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The confirmation proper — shared by both variants
// ─────────────────────────────────────────────────────────────────────────────

async function confirmResolvedEvent(
  deps: ConfirmVenueEventDeps,
  logger: LoggerPort | undefined,
  args: {
    actorHumanId: string;
    now: Date;
    eventId: string;
    /** Loaded + open; matched against the event below. Null = direct confirm. */
    request: BookingRequestRecord | null;
    ownerOverride: EventOwnerSide | null;
    minted: boolean;
    /** The start the venue saw (R3-1); ignored when `minted`. */
    expectedStartsAt: Date;
  },
): Promise<ConfirmVenueEventOutput> {
  const { actorHumanId, now, request, minted } = args;
  // R3-1: the start the stamp must find on the row. Null when this call
  // minted the event (see `expectedStartsAtSchema`).
  const expectedStartsAt = minted ? null : args.expectedStartsAt;

  const { event, place, authority, venueOwned } =
    await loadVenueConfirmationContext(deps.repos, {
      eventId: args.eventId,
      actorHumanId,
    });
  const ownerSide: EventOwnerSide = venueOwned ? "place" : "requester";

  // A named request must be a venue-bound request at THIS place, still
  // open, and — when it names an act — the act that OWNS this event. The
  // ledger entry lands on that thread naming this event, so staff must not
  // be able to attach act A's request to act B's event, nor revive a closed
  // one. Anonymous requests (no owner pair) have nobody to match against.
  if (request) {
    if (request.direction !== "TO_VENUE" || request.placeId !== event.placeId) {
      throw fail("INVALID_INPUT", {
        message: "booking_request_place_mismatch",
        meta: {
          bookingRequestId: request.id,
          eventId: event.id,
          eventPlaceId: event.placeId,
        },
      });
    }
    // Owner match applies to a REQUESTER-owned event (RENT/USE, or a venue
    // that overrode ownership): the act on the thread must own the event.
    // A VENUE-owned event is the venue's own row confirmed for the act on
    // its own thread (PERFORM: the venue hosts, the act is the lineup) — the
    // request's act is not its owner by design, so no match is asked for.
    if (!venueOwned && request.performerOwnerType && request.performerOwnerId) {
      const ownerMatches =
        request.performerOwnerType === "organization"
          ? event.orgId === request.performerOwnerId
          : event.humanId === request.performerOwnerId;
      if (!ownerMatches) {
        throw fail("INVALID_INPUT", {
          message: "booking_request_owner_mismatch",
          meta: {
            bookingRequestId: request.id,
            eventId: event.id,
            performerOwnerType: request.performerOwnerType,
          },
        });
      }
    }
  }

  // An override on an EXISTING event may only agree with it: ownership never
  // moves on confirm (a mint honours the override before we get here).
  if (args.ownerOverride && args.ownerOverride !== ownerSide) {
    throw fail("INVALID_STATUS", {
      message: "owner_override_conflicts_with_event",
      meta: {
        eventId: event.id,
        ownerSide,
        ownerOverride: args.ownerOverride,
      },
    });
  }

  // R3-1: the venue's screen is stale — the organizer moved the show after
  // it loaded. Refuse before anything else (including the "already
  // confirmed" answer, which would otherwise read as a vouch for a date
  // the venue never saw).
  if (
    expectedStartsAt !== null &&
    event.startsAt.getTime() !== expectedStartsAt.getTime()
  ) {
    throw eventMovedError(event.id, expectedStartsAt, event.startsAt);
  }

  // "Already confirmed" = a stamp that is CURRENT: active for this place AND
  // recorded at this start. A stamp for a date the organizer has since moved
  // away from is not this confirmation, so the venue confirming the NEW date
  // (which it just saw — checked above) re-stamps it (N1).
  if (venueStampIsCurrent(event)) {
    logger?.info("events.venue_confirmation.already_confirmed", {
      eventId: event.id,
      placeId: place.id,
      actorHumanId,
    });
    return confirmVenueEventOutputSchema.parse({
      event: toVenueConfirmationEventOutput(event, place),
      alreadyConfirmed: true,
      minted,
      notificationIntents: [],
      holdNotificationIntents: [],
      staffRecipientHint: null,
    });
  }

  // A direct re-confirm keeps the request the earlier confirmation came
  // from; the stamp is a re-stamp, not a detach.
  const linkedRequestId =
    request?.id ?? event.venueConfirmationRequestId ?? null;

  const outcome = await deps.repos.tx(async (tx) => {
    // Re-read INSIDE the tx: the short-circuit above is a pre-tx read, and
    // two concurrent confirms would otherwise both append the ledger entry
    // and the audit row. The second writer sees the first's commit here.
    const fresh = await tx.events.getById(event.id);
    if (!fresh) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (venueStampIsCurrent(fresh)) {
      return { already: true as const, event: fresh };
    }
    // `placeId` is the place we AUTHORIZED against: the adapter's CAS
    // (`WHERE id AND placeId`) refuses to stamp an event that moved to
    // another venue between our read and this write, and the stamp is bound
    // to this place (security review H1 — a vouch never travels).
    let stamped: EventRecord;
    try {
      stamped = await tx.events.setVenueConfirmation({
        eventId: event.id,
        placeId: place.id,
        confirmedByHumanId: actorHumanId,
        bookingRequestId: linkedRequestId,
        at: now,
        // R3-1: the CAS also pins the start the venue saw.
        expectedStartsAt,
      });
    } catch (err) {
      if (
        expectedStartsAt !== null &&
        typeof err === "object" &&
        err !== null &&
        (err as { code?: unknown }).code === "event_starts_at_mismatch"
      ) {
        throw eventMovedError(event.id, expectedStartsAt, null);
      }
      throw mapEventMoved(err, event.id, place.id);
    }

    // Confirmation takes the line (booking-holds spec, 2026-09-07): a
    // PUBLISHED event on a calendar now blocks — settle its held dates in
    // THIS tx, after the stamp (the settle's own gate reads the stamp), with
    // the request as provenance so its own hold wins. An open challenge
    // throws HOLD_LINE_HAS_OPEN_CHALLENGE and rolls the stamp back with it.
    // A DRAFT is a pencil-in and touches nothing; so does an event with no
    // calendar (outside the holds world).
    const heldDates =
      stamped.status === "PUBLISHED" && (stamped.calendarId ?? null) !== null
        ? await settleHeldDatesForEvent(tx, {
            event: stamped,
            now,
            actorHumanId,
            owner: heldDatesOwnerOf(stamped),
            // Explicit request → own request wins even without an
            // agreement (event-first). Direct confirm → the thread.
            ...(linkedRequestId ? { provenanceRequestId: linkedRequestId } : {}),
          })
        : NO_HELD_DATES;

    await tx.audit.log({
      entity: "event",
      entityId: event.id,
      action: "event.place_confirmed",
      data: {
        actorHumanId,
        placeId: place.id,
        bookingRequestId: linkedRequestId,
        via: authority.via,
        placeOwned: venueOwned,
        ownerSide,
        minted,
        reconfirmed: (event.venueConfirmationWithdrawnAt ?? null) !== null,
        heldDatesConfirmed: heldDates.confirmed.map((h) => h.id),
        heldDatesReleased: heldDates.released.map((h) => h.id),
      },
      at: now,
    });
    if (linkedRequestId) {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: linkedRequestId,
        kind: "booking_event.place_confirmed",
        data: { eventId: event.id, ownerSide },
        actorHumanId,
      });
    }
    // The event document names the venue only when it is confirmed.
    if (stamped.status === "PUBLISHED") {
      await markForSearchReindex(tx, [{ kind: "event", id: stamped.id }], now);
    }
    await enqueueEventFollowers(tx, stamped, now, {onlyPlace: true});
    return { already: false as const, event: stamped, heldDates };
  });

  if (outcome.already) {
    logger?.info("events.venue_confirmation.already_confirmed", {
      eventId: event.id,
      placeId: place.id,
      actorHumanId,
      raced: true,
    });
    return confirmVenueEventOutputSchema.parse({
      event: toVenueConfirmationEventOutput(outcome.event, place),
      alreadyConfirmed: true,
      minted,
      notificationIntents: [],
      holdNotificationIntents: [],
      staffRecipientHint: null,
    });
  }
  const updated = outcome.event;

  const intents: VenueConfirmationNotificationIntent[] = [];
  const recipient = venueOwned ? null : venueConfirmationRecipientFor(event);
  if (recipient) {
    intents.push({
      kind: "event.place_confirmed",
      eventId: event.id,
      placeId: place.id,
      bookingRequestId: linkedRequestId,
      recipient,
      at: updated.venueConfirmedAt ?? now,
    });
  }

  logger?.info("events.venue_confirmation.confirmed", {
    eventId: event.id,
    placeId: place.id,
    actorHumanId,
    via: authority.via,
    bookingRequestId: linkedRequestId,
    venueOwned,
    ownerSide,
    minted,
    intentCount: intents.length,
    heldDatesConfirmed: outcome.heldDates.confirmed.length,
    heldDatesReleased: outcome.heldDates.released.length,
  });

  return confirmVenueEventOutputSchema.parse({
    event: toVenueConfirmationEventOutput(updated, place),
    alreadyConfirmed: false,
    minted,
    notificationIntents: intents,
    holdNotificationIntents: outcome.heldDates.intents,
    staffRecipientHint: outcome.heldDates.staffRecipientHint,
  });
}
