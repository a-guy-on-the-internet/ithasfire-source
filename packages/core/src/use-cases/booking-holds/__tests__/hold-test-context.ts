import { vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { PlaceBookingGrantRecord } from "@th/ports/repos/place-booking-grants";
import type { BookingHoldLineTerms } from "@th/ports/repos/booking-holds";
import type { Repos } from "@th/ports/repos";
import type {
  SetBookingRequestAssigneeInput,
  UpdateBookingRequestStatusInput,
} from "@th/types/repos/booking-requests";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import {
  buildBookingRequestRecord,
  buildPlaceRecord,
} from "../../booking-requests/__tests__/helpers";
import {
  createFakeBookingHoldsRepo,
  createFakeBookingTagsRepo,
  createFakePlaceBookingGrantsRepo,
} from "./fakes";

// ─────────────────────────────────────────────────────────────────────────────
// Shared harness for the hold use-case suites: an ORG-OWNED venue with one
// calendar (20:00 default start, one ACTIVE space), a staff EDITOR, a staff
// VIEWER, three acts (each with its own TO_VENUE request), and every repo the
// use cases touch, wired through a passthrough tx.
// ─────────────────────────────────────────────────────────────────────────────

export const STAFF_ID = "11111111-1111-4111-8111-111111111111";
export const VIEWER_ID = "13131313-1313-4131-8131-131313131313";
export const ASSIGNEE_ID = "12121212-1212-4121-8121-121212121212";
export const OUTSIDER_ID = "14141414-1414-4141-8141-141414141414";
export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const PLACE_ID = "33333333-3333-4333-8333-333333333333";
export const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const OTHER_CALENDAR_ID = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
/** A calendar that exists but belongs to ANOTHER place (hold-context assert). */
export const FOREIGN_CALENDAR_ID = "cfcfcfcf-cfcf-4cfc-8cfc-cfcfcfcfcfcf";
export const FOREIGN_PLACE_ID = "34343434-3434-4343-8343-343434343434";
export const SPACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const ACT_A_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const ACT_B_ID = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
export const ACT_C_ID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
export const REQUEST_A = "44444444-4444-4444-8444-444444444444";
export const REQUEST_B = "45454545-4545-4545-8545-454545454545";
export const REQUEST_C = "46464646-4646-4646-8646-464646464646";
export const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
export const DATE = "2026-06-20";
/** 2026-06-10 12:00Z — a Chicago (CDT) morning; DATE is ten days out. */
export const NOW = new Date("2026-06-10T12:00:00.000Z");

export function buildHoldTestContext(options: {
  place?: Partial<PlaceRecord>;
  requests?: Partial<BookingRequestRecord>[];
  memberships?: OrgMembership[];
  /** Person delegations (the booker gate resolves a person grant through them). */
  delegations?: { principalId: string; delegateId: string; role: OrgMembership["role"] }[];
  clock?: () => Date;
  /**
   * Repos to add or replace in the bag (seen both outside and inside the
   * passthrough tx), for suites built on this harness that need more.
   */
  extraRepos?: Record<string, unknown>;
} = {}) {
  const place = buildPlaceRecord({
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    timezone: "America/Chicago",
    ...options.place,
  });

  const requests = new Map<string, BookingRequestRecord>();
  const seedRequest = (overrides: Partial<BookingRequestRecord>) => {
    const row = buildBookingRequestRecord({
      placeId: PLACE_ID,
      calendarId: CALENDAR_ID,
      assigneeHumanId: ASSIGNEE_ID,
      ...overrides,
    });
    requests.set(row.id, row);
    return row;
  };
  seedRequest({ id: REQUEST_A, performerOwnerId: ACT_A_ID, actName: "Act A" });
  seedRequest({ id: REQUEST_B, performerOwnerId: ACT_B_ID, actName: "Act B" });
  seedRequest({ id: REQUEST_C, performerOwnerId: ACT_C_ID, actName: "Act C" });
  for (const extra of options.requests ?? []) seedRequest(extra);

  const memberships: OrgMembership[] = options.memberships ?? [
    { orgId: ORG_ID, humanId: STAFF_ID, role: "EDITOR" },
    { orgId: ORG_ID, humanId: ASSIGNEE_ID, role: "ADMIN" },
    { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
  ];

  // The agreements map is declared below; the line-with-terms join reads it
  // lazily (at call time), exactly like the adapter's BookingHold →
  // BookingRequest → Agreement join.
  const agreements = new Map<string, Record<string, unknown>>();

  // The requester-side read's JOIN (request owner pair + direction → venue),
  // resolved off the same request map the rest of the harness uses.
  const bookingHolds = createFakeBookingHoldsRepo({
    // The adapter's grant join: a BOOKER row reads its grant's end facts off
    // the bag's grants fake (lazily, at read time, so a suite that swaps the
    // grants repo through `extraRepos` is the one joined).
    grantFor: (grantId) => {
      const grant = (
        bag.placeBookingGrants as { rows?: Map<string, PlaceBookingGrantRecord> }
      ).rows?.get(grantId);
      return grant ? { revokedAt: grant.revokedAt, expiresAt: grant.expiresAt } : null;
    },
    termsFor: (bookingRequestId) => {
      const agreementId = requests.get(bookingRequestId)?.agreementId ?? null;
      const row = agreementId ? agreements.get(agreementId) : undefined;
      if (!row) return null;
      return {
        agreementId: row.id as string,
        status: row.status as BookingHoldLineTerms["status"],
        proposedDate: (row.proposedDate as Date | null | undefined) ?? null,
      };
    },
    requesterContext: (bookingRequestId) => {
      const request = requests.get(bookingRequestId);
      if (!request) return null;
      return {
        ownerType: request.performerOwnerType,
        ownerId: request.performerOwnerId,
        direction: request.direction,
        placeId: request.placeId ?? PLACE_ID,
        placeName: place.name,
        placeTimezone: place.timezone,
        actName: request.actName,
      };
    },
  });
  const bookingTags = createFakeBookingTagsRepo();
  /** Empty unless a suite seeds one. Read only by the booker gate (FR-002). */
  const placeBookingGrants = createFakePlaceBookingGrantsRepo();
  const bookingRequestMessages = createFakeBookingRequestMessagesRepo();

  const bookingRequests = {
    getById: vi.fn(async (id: string) => requests.get(id) ?? null),
    // ── P3b (asks) ── the accept's set-length seed and the mint's image copy
    // read the request's asks (none in these suites).
    listAsks: vi.fn(async () => []),
    findByAgreementId: vi.fn(async (agreementId: string) =>
      [...requests.values()].find((r) => r.agreementId === agreementId) ?? null,
    ),
    updateStatus: vi.fn(async (input: UpdateBookingRequestStatusInput) => {
      const current = requests.get(input.id);
      if (!current || !input.expectedFrom.includes(current.status)) {
        throw { code: "conflict", message: "booking_request_status_changed" } as const;
      }
      const next = {
        ...current,
        status: input.status,
        respondedAt: input.respondedAt ?? current.respondedAt,
        declineReason: input.declineReason ?? current.declineReason,
        agreementId: input.agreementId ?? current.agreementId,
      };
      requests.set(next.id, next);
      return next;
    }),
    setAssignee: vi.fn(async (input: SetBookingRequestAssigneeInput) => {
      const current = requests.get(input.id);
      if (!current) {
        throw { code: "not_found", message: "booking_request_not_found" } as const;
      }
      const next = { ...current, assigneeHumanId: input.assigneeHumanId };
      requests.set(next.id, next);
      return next;
    }),
    touchLastMessageAt: vi.fn(async () => {}),
    // The bill (lineup v3): the close paths read it to tell joined acts the
    // request isn't going ahead. No acts on these requests.
    listActsForRequests: vi.fn(async () => []),
  };

  const authz = {
    getOrgMemberships: vi.fn(async (input: { orgIds: string[]; humanId: string }) =>
      memberships.filter((m) => m.humanId === input.humanId && input.orgIds.includes(m.orgId)),
    ),
    getOrgMembership: vi.fn(async (input: { orgId: string; humanId: string }) =>
      memberships.find((m) => m.humanId === input.humanId && m.orgId === input.orgId) ?? null,
    ),
    // The booker gate's read (holds-without-a-request FR-002).
    listOrgMembershipsByHumanId: vi.fn(async (input: { humanId: string; roles?: string[] }) =>
      memberships.filter(
        (m) => m.humanId === input.humanId && (!input.roles || input.roles.includes(m.role)),
      ),
    ),
    getPlaceAccessContext: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? { owningOrgIds: place.orgIdsWithAccess, verifiedHumanOwnerIds: place.humanIdsWithAccess }
        : null,
    ),
  };

  const calendars = {
    findById: vi.fn(async (id: string) =>
      id === CALENDAR_ID || id === OTHER_CALENDAR_ID
        ? { id, placeId: PLACE_ID, name: id === CALENDAR_ID ? "Main Room" : "Patio", isDefault: id === CALENDAR_ID }
        : id === FOREIGN_CALENDAR_ID
          ? { id, placeId: FOREIGN_PLACE_ID, name: "Elsewhere", isDefault: true }
          : null,
    ),
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [
            {
              id: CALENDAR_ID,
              placeId: PLACE_ID,
              name: "Main Room",
              slug: "main-room",
              isDefault: true,
              defaultStartTime: "20:00",
              defaultCategoryId: null,
              spaces: [{ id: SPACE_ID, placeId: PLACE_ID, name: "Main", status: "ACTIVE", sortOrder: 0 }],
            },
            {
              id: OTHER_CALENDAR_ID,
              placeId: PLACE_ID,
              name: "Patio",
              slug: "patio",
              isDefault: false,
              defaultStartTime: null,
              defaultCategoryId: null,
              spaces: [],
            },
          ]
        : [],
    ),
  };

  const agreementsRepo = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      const row = { id: AGREEMENT_ID, status: "DRAFT", eventId: null, draftEventId: null, ...input };
      agreements.set(AGREEMENT_ID, row);
      return row;
    }),
    getById: vi.fn(async (id: string) => agreements.get(id) ?? null),
    /** Header CAS (confirm aligns proposedDate to the hold's night). */
    updateHeader: vi.fn(
      async (
        input: { id: string; expectedFrom: readonly string[] } & Record<string, unknown>,
      ) => {
        const current = agreements.get(input.id);
        if (!current || !input.expectedFrom.includes(current.status as string)) {
          throw { code: "conflict", message: "agreement_status_changed" } as const;
        }
        const { id, expectedFrom: _expectedFrom, ...fields } = input;
        const next = { ...current, ...fields };
        agreements.set(id, next);
        return next;
      },
    ),
    /** Event provenance (FR-018): none by default; suites seed via `agreements`. */
    findByLinkedEventId: vi.fn(async (eventId: string) =>
      [...agreements.values()].find((a) => a.eventId === eventId || a.draftEventId === eventId) ?? null,
    ),
  };
  /** SCHEDULED occurrences by event id (FR-018 multi-date events). */
  const eventDates = new Map<string, Array<{ startsAt: Date; status: "SCHEDULED" | "CANCELLED" }>>();
  const eventDatesRepo = {
    listByEvent: vi.fn(async (input: { eventId: string; statuses?: string[] }) =>
      (eventDates.get(input.eventId) ?? [])
        .filter((d) => !input.statuses || input.statuses.includes(d.status))
        .map((d, i) => ({ id: `${input.eventId}-${i}`, eventId: input.eventId, ordinal: i, startsAt: d.startsAt, endsAt: null, status: d.status, createdAt: NOW, updatedAt: NOW })),
    ),
  };
  const payoutTerms = {
    clone: vi.fn(async () => null),
    createDraft: vi.fn(async () => ({ id: "66666666-6666-4666-8666-666666666666" })),
  };
  /**
   * No payee for anyone: an OPEN RENT / USE accept seeds the requester's
   * default line only when the requester has an ACTIVE payout-enabled Payee,
   * so the honest outcome here is `requesterLineSeeded: false`.
   */
  const payees = {
    getBySubject: vi.fn(async () => null),
    getById: vi.fn(async () => null),
  };
  const audit = { log: vi.fn(async () => {}) };
  const places = { getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)) };
  /** Minted events by id — seed `{ id, startsAt }` to emulate an existing draft. */
  const events = new Map<string, { id: string; startsAt: Date }>();
  const eventsRepo = { getById: vi.fn(async (id: string) => events.get(id) ?? null) };
  /**
   * EVENTS_PER_ORG: unlimited by default (the booking pre-flight reads it
   * before a booking that will save an event); a suite caps it to test the
   * refusal.
   */
  const resourceQuotas = {
    getEffectiveQuota: vi.fn(async () => ({
      limitValue: BigInt("9007199254740991"), // QUOTA_UNLIMITED
      currentUsage: 0n,
    })),
    hasPendingExpansionRequest: vi.fn(async () => false),
  };
  /** Owner rows the mint's plan reads for a requester-owned save: everyone exists. */
  const humans = { getById: vi.fn(async (id: string) => ({ id })) };
  const organizations = { getById: vi.fn(async (id: string) => ({ id })) };

  const delegations = options.delegations ?? [];
  const humanDelegates = {
    // The booker gate's reverse read (place-access `resolveBookerParties`).
    listPrincipalsForDelegate: vi.fn(
      async (input: {
        delegateId: string;
        roles: readonly string[];
        principalIds?: readonly string[];
      }) =>
        delegations
          .filter(
            (d) =>
              d.delegateId === input.delegateId &&
              input.roles.includes(d.role) &&
              (!input.principalIds || input.principalIds.includes(d.principalId)),
          )
          .map((d) => d.principalId)
          .sort(),
    ),
    getDelegation: vi.fn(async (input: { principalId: string; delegateId: string }) => {
      const row = delegations.find(
        (d) => d.principalId === input.principalId && d.delegateId === input.delegateId,
      );
      return row ? { id: `${row.principalId}:${row.delegateId}`, ...row, createdAt: NOW } : null;
    }),
  };

  const bag = {
    bookingHolds,
    bookingTags,
    placeBookingGrants,
    humanDelegates,
    bookingRequests,
    bookingRequestMessages,
    authz,
    calendars,
    agreements: agreementsRepo,
    payoutTerms,
    payees,
    audit,
    places,
    events: eventsRepo,
    eventDates: eventDatesRepo,
    resourceQuotas,
    humans,
    organizations,
    ...options.extraRepos,
  };
  const tx = vi.fn(async <R>(fn: (t: unknown) => Promise<R>): Promise<R> => fn(bag));
  const repos = { ...bag, tx } as unknown as Repos;
  const clock = { now: options.clock ?? (() => NOW) };

  const entries = (requestId: string) =>
    [...bookingRequestMessages.rows.values()]
      .filter((r) => r.bookingRequestId === requestId && r.systemKind)
      .map((r) => ({ kind: r.systemKind, data: r.systemData, actor: r.authorHumanId }));

  return {
    deps: { repos, clock },
    repos,
    place,
    requests,
    bookingHolds,
    bookingTags,
    placeBookingGrants,
    bookingRequests,
    agreements,
    events,
    eventDates,
    eventDatesRepo,
    resourceQuotas,
    audit,
    entries,
    seedRequest,
    /** Seed a live hold at the end of DATE's line for a request. */
    seedHold: (bookingRequestId: string, overrides: Record<string, unknown> = {}) =>
      bookingHolds.seed({ bookingRequestId, calendarId: CALENDAR_ID, date: DATE, placedByHumanId: STAFF_ID, ...overrides }),
    /**
     * booking-the-night N20: give a request terms (an Agreement) — DRAFT by
     * default, dated 20:00 Chicago on `night` (DATE by default) — so its holds
     * read as "ready" (or not) on that night. Returns the agreement id.
     */
    seedTerms: (
      bookingRequestId: string,
      over: { id?: string; status?: string; night?: string; proposedDate?: Date | null } = {},
    ) => {
      const id = over.id ?? `5e${bookingRequestId.slice(2)}`;
      const night = over.night ?? DATE;
      // 20:00 CDT on `night` (UTC−5): the next UTC day at 01:00.
      const next = new Date(`${night}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const proposedDate =
        over.proposedDate !== undefined
          ? over.proposedDate
          : new Date(`${next.toISOString().slice(0, 10)}T01:00:00.000Z`);
      agreements.set(id, {
        id,
        status: over.status ?? "DRAFT",
        eventId: null,
        draftEventId: null,
        proposedDate,
      });
      const request = requests.get(bookingRequestId)!;
      requests.set(bookingRequestId, { ...request, agreementId: id });
      return id;
    },
  };
}
