import { vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type {
  EventRecord,
  SetVenueConfirmationInput,
  WithdrawVenueConfirmationInput,
} from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { Repos } from "@th/ports/repos";

import {
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageEventRecord,
  makeFakeIdempotency,
  withTx,
} from "../../booking-requests/__tests__/helpers";
import {
  createFakeBookingHoldsRepo,
  createFakePlaceBookingGrantsRepo,
} from "../../booking-holds/__tests__/fakes";

// ─────────────────────────────────────────────────────────────────────────────
// Harness for `confirmVenueEvent` / `withdrawVenueConfirmation`: an ORG-owned
// venue (EDITOR + VIEWER staff, one direct human owner), a third-party event
// at it, an in-memory events repo whose `setVenueConfirmation` /
// `withdrawVenueConfirmation` mirror the adapter contracts (stamp clears the
// withdrawal; withdraw is idempotent on the same reason and valid on a
// never-confirmed row; both P2025 on a missing row), and the ledger/grants
// fakes wired through a passthrough tx.
// ─────────────────────────────────────────────────────────────────────────────

export const PLACE_ID = "33333333-3333-4333-8333-333333333333";
export const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222222";
export const OWNER_ID = "11111111-1111-4111-8111-111111111111";
export const EDITOR_ID = "12121212-1212-4121-8121-121212121212";
export const VIEWER_ID = "13131313-1313-4131-8131-131313131313";
export const STRANGER_ID = "14141414-1414-4141-8141-141414141414";
export const REQUESTER_ID = "15151515-1515-4151-8151-151515151515";
export const REQUESTER_ORG_ID = "25252525-2525-4252-8252-252525252525";
export const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
export const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_PLACE_ID = "34343434-3434-4343-8343-343434343434";
export const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
export const OTHER_REQUEST_ID = "45454545-4545-4545-8545-454545454545";
export const NOW = new Date("2026-09-02T12:00:00.000Z");
export const EARLIER = new Date("2026-08-20T12:00:00.000Z");
/** The fixture event's start (`buildStageEventRecord`): 2026-09-19T00:00Z. */
export const EVENT_STARTS_AT = new Date("2026-09-19T00:00:00.000Z");
/**
 * The place-local day of `EVENT_STARTS_AT`: the fixture place has no zone,
 * so the booking fallback (`America/Chicago`, CDT) makes it the evening of
 * the 18th — the hold line a confirmation takes.
 */
export const HELD_DATE = "2026-09-18";

export function buildVenueConfirmationContext(
  options: {
    event?: Partial<EventRecord>;
    place?: Partial<PlaceRecord>;
    requests?: Partial<BookingRequestRecord>[];
    memberships?: OrgMembership[];
    /** Agreements by id (the request variant walks `request.agreementId`). */
    agreements?: Array<{
      id: string;
      eventId?: string | null;
      draftEventId?: string | null;
      status?: string;
    }>;
  } = {},
) {
  const place = buildPlaceRecord({
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG_ID],
    humanIdsWithAccess: [OWNER_ID],
    ...options.place,
  });

  const events = new Map<string, EventRecord>();
  const seedEvent = (overrides: Partial<EventRecord> = {}) => {
    const row = buildStageEventRecord({
      id: EVENT_ID,
      orgId: null,
      humanId: REQUESTER_ID,
      placeId: PLACE_ID,
      calendarId: CALENDAR_ID,
      title: "Third-party Night",
      status: "PUBLISHED",
      venueConfirmedAt: null,
      venueConfirmedByHumanId: null,
      // A stamped fixture is stamped FOR this place unless a suite says
      // otherwise (H1: the stamp is bound to the place it was issued for).
      venueConfirmedPlaceId: overrides.venueConfirmedAt ? PLACE_ID : null,
      venueConfirmationRequestId: null,
      venueConfirmationWithdrawnAt: null,
      venueConfirmationWithdrawnReason: null,
      ...overrides,
    });
    // A stamped fixture carries the date it was stamped for (the N1 backfill
    // invariant) unless the suite says otherwise.
    if (
      row.venueConfirmedAt &&
      !Object.prototype.hasOwnProperty.call(overrides, "venueConfirmedStartsAt")
    ) {
      row.venueConfirmedStartsAt = row.startsAt;
    }
    events.set(row.id, row);
    return row;
  };

  // EXACTLY the adapter's CAS-miss object (see `eventPlaceMismatch` in
  // packages/adapters/src/db/prisma/events.ts): the write runs WHERE id AND
  // placeId, so a moved event, a foreign eventId, or no such event all land
  // here. The fake must not drift from what production throws.
  const placeMismatch = () =>
    ({
      code: "event_place_mismatch",
      message: "event_place_mismatch",
    }) as const;
  seedEvent(options.event);

  const missing = (id: string) =>
    Object.assign(new Error(`Record to update not found: ${id}`), {
      code: "P2025",
    });

  const eventsRepo = {
    getById: vi.fn(async (id: string) => events.get(id) ?? null),
    setVenueConfirmation: vi.fn(async (input: SetVenueConfirmationInput) => {
      const current = events.get(input.eventId);
      if (!current) throw missing(input.eventId);
      if (current.placeId !== input.placeId) throw placeMismatch();
      // R3-1: the adapter's CAS also pins the start the venue saw.
      if (
        input.expectedStartsAt &&
        current.startsAt.getTime() !== input.expectedStartsAt.getTime()
      ) {
        throw {
          code: "event_starts_at_mismatch",
          message: "event_starts_at_mismatch",
        } as const;
      }
      const next: EventRecord = {
        ...current,
        venueConfirmedAt: input.at,
        venueConfirmedByHumanId: input.confirmedByHumanId,
        venueConfirmedPlaceId: input.placeId,
        venueConfirmationRequestId: input.bookingRequestId,
        venueConfirmationWithdrawnAt: null,
        venueConfirmationWithdrawnReason: null,
        // The adapter copies the row's own start (N1).
        venueConfirmedStartsAt: current.startsAt,
      };
      events.set(next.id, next);
      return next;
    }),
    withdrawVenueConfirmation: vi.fn(
      async (input: WithdrawVenueConfirmationInput) => {
        const current = events.get(input.eventId);
        if (!current) throw missing(input.eventId);
        if (current.placeId !== input.placeId) throw placeMismatch();
        if (
          current.venueConfirmationWithdrawnAt &&
          current.venueConfirmationWithdrawnReason === input.reason
        ) {
          return current;
        }
        const next: EventRecord = {
          ...current,
          venueConfirmationWithdrawnAt: input.at,
          venueConfirmationWithdrawnReason: input.reason,
          venueConfirmedStartsAt: null,
        };
        events.set(next.id, next);
        return next;
      },
    ),
  };

  const requests = new Map<string, BookingRequestRecord>();
  for (const extra of options.requests ?? []) {
    const row = buildBookingRequestRecord({
      id: REQUEST_ID,
      placeId: PLACE_ID,
      performerOwnerType: "human",
      performerOwnerId: REQUESTER_ID,
      ...extra,
    } as Partial<BookingRequestRecord>);
    requests.set(row.id, row);
  }
  const bookingRequests = {
    getById: vi.fn(async (id: string) => requests.get(id) ?? null),
    findByAgreementId: vi.fn(async (agreementId: string) =>
      [...requests.values()].find((r) => r.agreementId === agreementId) ?? null,
    ),
    touchLastMessageAt: vi.fn(async () => {}),
  };

  const memberships: OrgMembership[] = options.memberships ?? [
    { orgId: VENUE_ORG_ID, humanId: EDITOR_ID, role: "EDITOR" },
    { orgId: VENUE_ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
  ];
  const authz = {
    getOrgMemberships: vi.fn(
      async (input: { orgIds: string[]; humanId: string }) =>
        memberships.filter(
          (m) => m.humanId === input.humanId && input.orgIds.includes(m.orgId),
        ),
    ),
  };

  const placeBookingGrants = createFakePlaceBookingGrantsRepo();
  const audit = { log: vi.fn(async () => {}) };
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
  };

  // Confirmation takes the line: the settle reads the calendar → place,
  // the event's occurrences, the thread (agreement → request) and the
  // holds (an in-memory fake, so suites can seed a line).
  const agreementRows = new Map(
    (options.agreements ?? []).map((a) => [
      a.id,
      { status: "ACCEPTED", eventId: null, draftEventId: null, ...a },
    ]),
  );
  const agreements = {
    getById: vi.fn(async (id: string) => agreementRows.get(id) ?? null),
    findByLinkedEventId: vi.fn(async (eventId: string) =>
      [...agreementRows.values()].find(
        (a) => a.eventId === eventId || a.draftEventId === eventId,
      ) ?? null,
    ),
  };
  const calendars = {
    findById: vi.fn(async (id: string) =>
      id === CALENDAR_ID
        ? { id, placeId: PLACE_ID, name: "Main Room", isDefault: true }
        : null,
    ),
  };
  const eventDates = { listByEvent: vi.fn(async () => []) };
  const bookingHolds = createFakeBookingHoldsRepo();
  const idempotency = makeFakeIdempotency();

  const repos = withTx({
    events: eventsRepo,
    places,
    authz,
    audit,
    bookingRequests,
    placeBookingGrants,
    agreements,
    calendars,
    eventDates,
    bookingHolds,
  }) as unknown as Repos;

  const entries = (requestId: string) => {
    const messages = (
      repos as unknown as {
        bookingRequestMessages: {
          rows: Map<string, { bookingRequestId: string; systemKind: string | null; systemData: unknown; authorHumanId: string | null }>;
        };
      }
    ).bookingRequestMessages.rows;
    return [...messages.values()]
      .filter((r) => r.bookingRequestId === requestId && r.systemKind)
      .map((r) => ({ kind: r.systemKind, data: r.systemData, actor: r.authorHumanId }));
  };

  return {
    deps: { repos, clock: { now: () => NOW }, idempotency },
    repos,
    place,
    events,
    eventsRepo,
    requests,
    bookingRequests,
    agreements,
    agreementRows,
    calendars,
    bookingHolds,
    authz,
    audit,
    placeBookingGrants,
    idempotency,
    seedEvent,
    entries,
    /** A live hold on the fixture event's line (CALENDAR_ID × HELD_DATE). */
    seedHold: (bookingRequestId: string, overrides: Record<string, unknown> = {}) =>
      bookingHolds.seed({
        bookingRequestId,
        calendarId: CALENDAR_ID,
        date: HELD_DATE,
        placedByHumanId: EDITOR_ID,
        ...overrides,
      }),
  };
}
