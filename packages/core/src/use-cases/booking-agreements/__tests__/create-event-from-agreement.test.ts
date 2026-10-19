import { afterEach, describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
// ── P3b (asks) ──
import type {
  BookingRequestAskRecord,
  BookingRequestAttachmentRecord,
} from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  createEventFromAgreement,
  createEventFromAgreementForHold,
  createEventFromAgreementOnNight,
} from "../create-event-from-agreement";
import type { CreateEventFromAgreementDeps } from "../create-event-from-agreement";
import {
  AGREEMENT_ID,
  OUTSIDER_ID,
  PERFORMER_ID,
  PLACE_ID,
  TERMS_ID,
  THIRD_PARTY_PAYEE_ID,
  VENUE_ADMIN_ID,
  VENUE_ORG_ID,
  VENUE_PAYEE_ID,
  VENUE_VIEWER_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildPayeeRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeClock,
  makeFakeIdempotency,
  withTx,
  type AgreementsRepoFakeOptions,
} from "./helpers";
import { cleanPng } from "../../../lib/images/__tests__/image-fixtures";
import {
  buildPerformerProfile,
  buildPlaceRecord as buildRequestPlaceRecord,
  systemEntriesFor,
  withTx as withRequestTx,
} from "../../booking-requests/__tests__/helpers";
import {
  createBookingRequest,
  type CreateBookingRequestDeps,
} from "../../booking-requests/create-booking-request";
import {
  joinBookingRequestAct,
  type AnswerBookingRequestActDeps,
} from "../../booking-requests/answer-booking-request-act";
import {
  createFakeBookingRequestActs,
  type FakeBookingRequestActs,
} from "@th/test-utils/fakes/booking-request-acts";
import type {
  FakeBookingHoldsRepo,
  FakePlaceBookingGrantsRepo,
} from "../../booking-holds/__tests__/fakes";
import { committedHoldIntentsOf } from "../../booking-holds/_shared/booking-hold-intents";
import {
  confirmVenueEvent,
  type ConfirmVenueEventDeps,
} from "../../events/confirm-venue-event";

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
/** Sequential mint ids — the events fake hands these out per upsertDraft call. */
const NEW_EVENT_IDS = [
  "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0",
  "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2",
] as const;
const NEW_EVENT_ID = NEW_EVENT_IDS[0];
const EVENT_HUMAN_ID = "ee11ee11-ee11-4e11-8e11-ee11ee11ee11";
const VENUE_OWNER_ID = "31313131-3131-4131-8131-313131313131";
const PERFORMER_ORG_ID = "42424242-4242-4242-8424-424242424242";

/** 19:00 America/Chicago (CDT, UTC-5) on the first preferred date 2026-07-10. */
const EXPECTED_DEFAULT_STARTS_AT = "2026-07-11T00:00:00.000Z";
const EXPECTED_DEFAULT_ENDS_AT = "2026-07-11T03:00:00.000Z";

function buildPlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "Test Venue",
    slug: "test-venue",
    formattedAddress: "123 Main St",
    addressLine1: "123 Main St",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37201",
    countryCode: "US",
    capacity: null,
    lat: null,
    lng: null,
    phone: null,
    website: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
    acceptsBookingRequests: true,
    orgIdsWithAccess: [VENUE_ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceRecord;
}

function buildRequest(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return {
    id: REQUEST_ID,
    direction: "TO_VENUE",
    placeId: PLACE_ID,
    placeName: "Test Venue",
    organizerOrgId: null,
    organizerOrgName: null,
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
    calendarId: null,
    performerOwnerType: "human",
    performerOwnerId: PERFORMER_ID,
    contactName: null,
    contactEmail: null,
    source: "PLATFORM",
    embedId: null,
    claimTokenHash: null,
    claimTokenExpiresAt: null,
    claimedAt: null,
    message: "We'd love to play a Friday night slot.",
    preferredDates: ["2026-07-10"],
    expectedDraw: 80,
    genre: "punk",
    links: [],
    actName: "The Fake Band",
    lineupSize: null,
    setLengthMinutes: null,
    contactPhone: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    linkMusic: null,
    linkVideo: null,
    linkSocial: null,
    linkEpk: null,
    tags: [],
    assigneeHumanId: null,
    taxFormStatus: "NONE",
    intent: "PERFORM",
    spaceId: null,
    requestedStartsAt: null,
    requestedEndsAt: null,
    purpose: null,
    expectedAttendance: null,
    originEventId: null,
    parkedUnclaimedAt: null,
    billRecorded: false,
    lastMessageAt: null,
    status: "ACCEPTED",
    viewedAt: null,
    respondedAt: new Date("2026-06-09T00:00:00.000Z"),
    declineReason: null,
    agreementId: AGREEMENT_ID,
    verifiedStatsSnapshot: null,
    expiresAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    ...overrides,
  } satisfies BookingRequestRecord;
}

const CONFIRMED_LINE = buildLineRecord({
  payeeId: THIRD_PARTY_PAYEE_ID,
  confirmationStatus: "CONFIRMED",
  confirmedAt: new Date("2026-06-08T00:00:00.000Z"),
});
const PARTY_LINE = buildLineRecord({
  id: "11111111-2222-4333-8444-555555555555",
  payeeId: VENUE_PAYEE_ID,
  percent: 30,
  requiresConfirmation: false,
  confirmationStatus: null,
});

type BuildOptions = AgreementsRepoFakeOptions & {
  agreement?: ReturnType<typeof buildAgreementRecord> | null;
  request?: BookingRequestRecord | null;
  place?: PlaceRecord;
  lines?: ReturnType<typeof buildLineRecord>[];
  payees?: ReturnType<typeof buildPayeeRecord>[];
  /** Org lookup for org-typed performer senders / the venue-owner org. */
  orgName?: string;
  /** Override (e.g. `makeDroppableIdempotency` for retention-window tests). */
  idempotency?: ReturnType<typeof makeFakeIdempotency>;
  /** Calendars repo for the venue-hierarchy routing tests (FR-005/FR-009). */
  calendars?: unknown;
  /**
   * What `categories.getById` answers for a calendar's default category.
   * Omitted = an active category with the asked id.
   */
  defaultCategory?: { active: boolean } | null;
  /**
   * The request's bill (lineup-booking-requests v2): an act store the mint
   * locks and reads. Omitted = the pre-bill shape (no act rows) — `withTx`
   * autowires an empty store.
   */
  acts?: FakeBookingRequestActs;
  /** Web base URL (an org SELF row's page link on the lineup). */
  publicAppUrl?: string;
  /** Org pages by org id — `entityPages.getByOwner("ORGANIZATION", id)`. */
  orgPages?: Record<string, { slug: string; visibility: "PUBLIC" | "PRIVATE" | "UNLISTED" }>;
};

/**
 * `makeFakeIdempotency` plus a `drop()` escape hatch so tests can simulate
 * the asymmetric-retention window (this use case's 24h envelope record
 * expiring while the save path's 3-day record survives). Semantics otherwise
 * identical to the shared fake.
 */
function makeDroppableIdempotency() {
  const results = new Map<string, unknown>();
  const inProgress = new Map<string, number>();
  const failed = new Map<string, number>();

  const isLive = (map: Map<string, number>, key: string) => {
    const until = map.get(key);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      map.delete(key);
      return false;
    }
    return true;
  };

  return {
    async begin(key: string, ttlSec = 60) {
      if (results.has(key)) return false;
      if (isLive(failed, key) || isLive(inProgress, key)) return false;
      inProgress.set(key, Date.now() + ttlSec * 1000);
      return true;
    },
    async commit(key: string, result: unknown) {
      results.set(key, result);
      inProgress.delete(key);
      failed.delete(key);
    },
    async fail(key: string, _error: unknown, keepSec = 15 * 60) {
      inProgress.delete(key);
      failed.set(key, Date.now() + keepSec * 1000);
    },
    async get<T>(key: string) {
      return (results.get(key) as T | undefined) ?? null;
    },
    async run(key: string, _ttlSec: number, fn: () => Promise<unknown>) {
      const prior = results.get(key);
      if (prior !== undefined) return { fresh: false, result: prior as never };
      const result = await fn();
      results.set(key, result);
      return { fresh: true, result };
    },
    /** Simulate retention expiry of a committed record. */
    drop(key: string) {
      results.delete(key);
    },
  };
}

/**
 * Default calendars fake for `buildDeps` — the repo is REQUIRED on the
 * aggregate (Step 5), so every mint resolves placement. One default calendar
 * ("Main Calendar") with one ACTIVE space, mirroring what upsert-place mints
 * for a real venue. Routing-specific suites pass their own fake instead.
 */
const DEFAULT_CALENDAR_ID = "ca1e0da1-de1f-4a11-8a11-000000000001";
const DEFAULT_SPACE_ID = "0000f00d-de1f-4a11-8a11-000000000001";
const makeDefaultCalendarsFake = () => ({
  listByPlace: vi.fn(async (placeId: string) =>
    placeId === PLACE_ID
      ? [
          {
            id: DEFAULT_CALENDAR_ID,
            placeId: PLACE_ID,
            name: "Main Calendar",
            slug: "main",
            description: null,
            isDefault: true,
            defaultStartTime: null,
            defaultCategoryId: null,
            eventTemplate: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            spaces: [
              {
                id: DEFAULT_SPACE_ID,
                placeId: PLACE_ID,
                name: "Main Space",
                capacity: null,
                sortOrder: 0,
                status: "ACTIVE",
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
          },
        ]
      : [],
  ),
});

function buildDeps(options: BuildOptions = {}) {
  const agreements = makeAgreementsRepoFake(
    options.agreement === undefined
      ? buildAgreementRecord({ status: "ACCEPTED" })
      : options.agreement,
    options,
  );
  const audit = makeAuditFake();
  const idempotency = options.idempotency ?? makeFakeIdempotency();
  const request =
    options.request === undefined ? buildRequest() : options.request;
  const place = options.place ?? buildPlace();

  const bookingRequests = {
    findByAgreementId: vi.fn(async () => request),
    // booking-the-night NFR-001: the manual mint books agreed terms' night
    // (re-reads the request under the line lock; the ledger bumps recency).
    getById: vi.fn(async () => request),
    touchLastMessageAt: vi.fn(async () => undefined),
    // ── P3b (asks) ── the post-mint image copy reads the request's asks
    // (none unless a test seeds them).
    listAsks: vi.fn(async (): Promise<BookingRequestAskRecord[]> => []),
    getAttachment: vi.fn(async (): Promise<BookingRequestAttachmentRecord | null> => null),
    stampAskEventImage: vi.fn(async () => true),
    ...(options.acts
      ? {
          addActs: options.acts.addActs,
          listActsForRequests: options.acts.listActsForRequests,
          getActForOwner: options.acts.getActForOwner,
          setActConfirmation: options.acts.setActConfirmation,
          lockBill: vi.fn(options.acts.lockBill),
          promoteActToSelf: options.acts.promoteActToSelf,
        }
      : {}),
  };
  const places = {
    getById: vi.fn(async (id: string) => (id === place.id ? place : null)),
    updateTaxRate: vi.fn(async () => undefined),
  };

  // Membership map: VENUE_ADMIN edit-level, VENUE_VIEWER read-only.
  const memberships: Record<string, string> = {
    [`${VENUE_ORG_ID}:${VENUE_ADMIN_ID}`]: "ADMIN",
    [`${VENUE_ORG_ID}:${VENUE_VIEWER_ID}`]: "VIEWER",
  };
  const authz = {
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        const role = memberships[`${orgId}:${humanId}`];
        return role ? { orgId, humanId, role } : null;
      },
    ),
    getOrgMemberships: vi.fn(
      async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        orgIds
          .map((orgId) => ({
            orgId,
            humanId,
            role: memberships[`${orgId}:${humanId}`],
          }))
          .filter((m) => m.role),
    ),
  };

  const organizations = {
    getById: vi.fn(async (id: string) => ({
      id,
      name:
        id === PERFORMER_ORG_ID
          ? (options.orgName ?? "Band Org")
          : "Venue Org",
    })),
  };
  const humans = {
    getById: vi.fn(async (id: string) => ({ id, name: "Perry Former" })),
  };

  // ── Standard save-event internals (finalizeSaveEvent) ─────────────────────
  // Stateful events fake: upsertDraft mints sequential ids into a live map;
  // getById serves BOTH the staleness/liveness checks and finalize's
  // ensureEventEditable; deleteEvent() simulates a venue deletion (row gone +
  // the FK SetNull on the agreement's anchors).
  const mintedEvents = new Map<string, Record<string, unknown>>();
  const deletedEventIds = new Set<string>();
  let mintCount = 0;
  const upsertDraft = vi.fn(
    async (input: {
      title: string;
      startsAt: Date;
      endsAt: Date | null;
      orgId: string | null;
      humanId: string | null;
      status: string;
      location: { kind: string; placeId?: string };
    }) => {
      const id = NEW_EVENT_IDS[mintCount] ?? `overflow-${mintCount}`;
      mintCount += 1;
      const record = {
        id,
        orgId: input.orgId,
        humanId: input.humanId,
        title: input.title,
        status: input.status,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        placeId:
          input.location.kind === "place"
            ? (input.location.placeId ?? null)
            : null,
        savedLocationId: null,
        postalCode: null,
        countryCode: null,
        region: null,
        addressText: null,
        instructionalAdmission: false,
      };
      mintedEvents.set(id, record);
      return record;
    },
  );
  const events = {
    upsertDraft,
    // Place-address-withholding D1: a place-linked save takes the shared
    // place-location lock before reading the venue. A no-op in memory.
    lockLocationsAtPlace: vi.fn(async () => undefined),
    // booking-the-night P2c (W5 residual d): finalize takes the event row
    // (then the booking lock, then the booked line) inside its transaction.
    // A no-op in memory.
    lockRows: vi.fn(async () => undefined),
    getById: vi.fn(async (id: string) =>
      deletedEventIds.has(id) ? null : (mintedEvents.get(id) ?? null),
    ),
    linkPayoutTerms: vi.fn(async () => undefined),
    updateTaxRate: vi.fn(async () => undefined),
    setVenuePlacement: vi.fn(async () => undefined),
    // Like the adapter: stamp + bind, and record the row's own start as the
    // confirmed one (N1). A row this fake never minted answers undefined, as
    // the bare mock always did.
    setVenueConfirmation: vi.fn(
      async (input: {
        eventId: string;
        placeId: string;
        confirmedByHumanId: string;
        bookingRequestId: string | null;
        at: Date;
      }) => {
        const row = mintedEvents.get(input.eventId);
        if (!row) return undefined;
        const next = {
          ...row,
          venueConfirmedAt: input.at,
          venueConfirmedByHumanId: input.confirmedByHumanId,
          venueConfirmedPlaceId: input.placeId,
          venueConfirmationRequestId: input.bookingRequestId,
          venueConfirmationWithdrawnAt: null,
          venueConfirmedStartsAt: row.startsAt,
        };
        mintedEvents.set(input.eventId, next);
        return next;
      },
    ),
    // Slug-at-create: `finalizeSaveEvent` slugs a brand-new event, so the
    // mint path exercises these too. The minted rows carry no country
    // (`countryCode: null` above, and the fake place is not joined), so the
    // realistic answer here is "no context" → the event mints slugless, which
    // is the documented best-effort outcome rather than a failure.
    getSlugContext: vi.fn(async (eventId: string) => {
      const record = mintedEvents.get(eventId);
      if (!record) return null;
      return {
        eventId,
        orgId: record.orgId ?? null,
        humanId: record.humanId ?? null,
        eventTitle: record.title,
        startsAt: record.startsAt,
        orgName: null,
        countryCode: null,
        regionCode: null,
        cityOrRegionCode: null,
        shortId: null,
      };
    }),
    assignSlug: vi.fn(async () => undefined),
  };
  /** Venue deletes an event: row gone + FK SetNull on the agreement anchors. */
  const deleteEvent = (id: string) => {
    deletedEventIds.add(id);
    const current = agreements.record();
    if (current) {
      agreements.set({
        ...current,
        draftEventId: current.draftEventId === id ? null : current.draftEventId,
        eventId: current.eventId === id ? null : current.eventId,
      });
    }
  };
  const eventHumans = {
    attach: vi.fn(
      async (input: Record<string, unknown>) =>
        ({ id: EVENT_HUMAN_ID, ...input }) as { id: string },
    ),
  };
  const placeLayouts = { getByPlace: vi.fn(async () => null) };
  const resourceQuotas = {
    getEffectiveQuota: vi.fn(async () => ({
      limitValue: BigInt("9007199254740991"), // QUOTA_UNLIMITED — skip enforcement
      currentUsage: 0n,
    })),
    hasPendingExpansionRequest: vi.fn(async () => false),
    incrementUsage: vi.fn(async () => undefined),
  };

  // ── Finalize internals ─────────────────────────────────────────────────────
  const lines = options.lines ?? [CONFIRMED_LINE, PARTY_LINE];
  const termsStatusRef = { current: "PENDING" as string };
  const payoutTerms = {
    listLines: vi.fn(async () => lines),
    activate: vi.fn(
      async ({ expectedFrom }: { expectedFrom: readonly string[] }) => {
        if (!expectedFrom.includes(termsStatusRef.current)) return null;
        termsStatusRef.current = "ACTIVE";
        return { id: TERMS_ID, status: "ACTIVE" };
      },
    ),
    getById: vi.fn(async () => ({
      id: TERMS_ID,
      status: termsStatusRef.current,
    })),
  };
  const payeeRecords = options.payees ?? [
    buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID }),
    buildPayeeRecord({
      id: VENUE_PAYEE_ID,
      subjectType: "ORGANIZATION",
      subjectId: VENUE_ORG_ID,
    }),
  ];
  const payees = {
    getByIds: vi.fn(async (ids: string[]) =>
      payeeRecords.filter((payee) => ids.includes(payee.id)),
    ),
  };

  const reportError = vi.fn();

  const deps = {
    repos: withTx({
      agreements: agreements.repo,
      bookingRequests,
      places,
      authz,
      organizations,
      humans,
      events,
      eventHumans,
      placeLayouts,
      resourceQuotas,
      payoutTerms,
      payees,
      audit,
      calendars: options.calendars ?? makeDefaultCalendarsFake(),
      categories: {
        getById: vi.fn(async (id: string) =>
          options.defaultCategory === null
            ? null
            : { id, active: options.defaultCategory?.active ?? true },
        ),
      },
      entityPages: {
        getByOwner: vi.fn(async (ownerType: string, ownerId: string) => {
          const page = ownerType === "ORGANIZATION" ? options.orgPages?.[ownerId] : undefined;
          return page ? { id: `page-${ownerId}`, ownerType, ownerId, ...page } : null;
        }),
      },
    }) as unknown as CreateEventFromAgreementDeps["repos"],
    idempotency,
    clock: makeClock(),
    reportError,
    ...(options.publicAppUrl ? { publicAppUrl: options.publicAppUrl } : {}),
    // `canManagePlace`, the adapter's rule over this fake's own data: a
    // verified direct owner, or OWNER / ADMIN / EDITOR of an owning org.
    authz: {
      canManagePlace: vi.fn(
        async ({ actorHumanId, placeId }: { actorHumanId: string; placeId: string }) => {
          if (placeId !== place.id) return { allowed: false };
          if (place.humanIdsWithAccess.includes(actorHumanId)) return { allowed: true };
          return {
            allowed: place.orgIdsWithAccess.some((orgId) =>
              ["OWNER", "ADMIN", "EDITOR"].includes(
                memberships[`${orgId}:${actorHumanId}`] ?? "",
              ),
            ),
          };
        },
      ),
    },
  } satisfies CreateEventFromAgreementDeps;

  return {
    deps,
    agreements,
    bookingRequests,
    events,
    eventHumans,
    audit,
    idempotency,
    payoutTerms,
    reportError,
    deleteEvent,
    termsStatus: () => termsStatusRef.current,
  };
}

const baseInput = {
  actorHumanId: VENUE_ADMIN_ID,
  agreementId: AGREEMENT_ID,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createEventFromAgreement", () => {
  it("happy path (org-owned venue, finalizable): mints the DRAFT, attaches the headliner, stamps the anchor, finalize-links", async () => {
    const { deps, agreements, events, eventHumans, audit } = buildDeps();

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: false,
      finalized: true,
    });

    // Event minted through the standard save internals, owned by the venue
    // counterparty org, at the venue place, on the first preferred date at
    // 19:00 platform-local, titled from actName + place.
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft).toMatchObject({
      orgId: VENUE_ORG_ID,
      humanId: null,
      status: "DRAFT",
      title: "The Fake Band at Test Venue",
      location: { kind: "place", placeId: PLACE_ID },
      timezone: "America/Chicago",
    });
    expect(draft.startsAt.toISOString()).toBe(EXPECTED_DEFAULT_STARTS_AT);
    expect(draft.endsAt?.toISOString()).toBe(EXPECTED_DEFAULT_ENDS_AT);

    // Headliner lineup row: owned human sender → humanId, actName kept as the
    // displayed stage name.
    expect(eventHumans.attach).toHaveBeenCalledTimes(1);
    expect(eventHumans.attach).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      humanId: PERFORMER_ID,
      orgId: null,
      externalName: "The Fake Band",
      externalUrl: null,
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 0,
    });

    // Anchor stamped + finalize linked (real finalize ran).
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    expect(agreements.record()?.eventId).toBe(NEW_EVENT_ID);
    expect(events.linkPayoutTerms).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      payoutTermsId: TERMS_ID,
      kind: "PRIMARY",
    });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_agreement",
        entityId: AGREEMENT_ID,
        action: "booking_agreement.event_created",
        data: expect.objectContaining({
          eventId: NEW_EVENT_ID,
          bookingRequestId: REQUEST_ID,
          placeId: PLACE_ID,
        }),
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.finalized" }),
    );
  });

  it("blocked finalize (unconfirmed lines): event still exists, anchor stamped, finalized:false + blocked code, eventId NOT linked", async () => {
    const { deps, agreements, events, payoutTerms, termsStatus } = buildDeps({
      lines: [
        buildLineRecord({
          payeeId: THIRD_PARTY_PAYEE_ID,
          confirmationStatus: "PENDING",
        }),
        PARTY_LINE,
      ],
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "lines_unconfirmed",
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    // The REAL finalize invariants held: nothing linked, nothing activated.
    expect(agreements.record()?.eventId).toBeNull();
    expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    expect(payoutTerms.activate).not.toHaveBeenCalled();
    expect(termsStatus()).toBe("PENDING");
  });

  it("blocked payee (payee_not_ready) surfaces the other gate code", async () => {
    const { deps } = buildDeps({
      payees: [
        buildPayeeRecord({
          id: THIRD_PARTY_PAYEE_ID,
          status: "PENDING",
          payoutsEnabled: false,
          chargesEnabled: false,
        }),
        buildPayeeRecord({
          id: VENUE_PAYEE_ID,
          subjectType: "ORGANIZATION",
          subjectId: VENUE_ORG_ID,
        }),
      ],
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.finalized).toBe(false);
    expect(result.finalizeBlocked).toBe("payee_not_ready");
    expect(result.eventId).toBe(NEW_EVENT_ID);
  });

  it("a frozen deal on the event (DEAL_FROZEN) is 'created, finalize from the agreement page': deal_frozen, nothing linked", async () => {
    const { deps, agreements, events, payoutTerms, termsStatus } = buildDeps();
    const serve = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) => {
      const row = await serve(id);
      return row ? { ...row, dealFrozenAt: new Date("2026-10-01T09:00:00.000Z") } : row;
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "deal_frozen",
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    expect(agreements.record()?.eventId).toBeNull();
    expect(events.linkPayoutTerms).not.toHaveBeenCalled();
    expect(payoutTerms.activate).not.toHaveBeenCalled();
    expect(termsStatus()).toBe("PENDING");
  });

  it("converges: blocked create, payouts confirmed, second call returns the SAME draft and finalizes it (no second event)", async () => {
    vi.useFakeTimers();
    const pendingLine = buildLineRecord({
      payeeId: THIRD_PARTY_PAYEE_ID,
      confirmationStatus: "PENDING",
    });
    const { deps, agreements, events, payoutTerms } = buildDeps({
      lines: [pendingLine, PARTY_LINE],
    });

    const first = await createEventFromAgreement(deps, baseInput);
    expect(first).toMatchObject({
      eventId: NEW_EVENT_ID,
      finalized: false,
      finalizeBlocked: "lines_unconfirmed",
    });

    // Payouts get confirmed; the blocked finalize's 1s deterministic
    // retention lapses.
    pendingLine.confirmationStatus = "CONFIRMED";
    vi.advanceTimersByTime(1_100);

    const second = await createEventFromAgreement(deps, baseInput);

    expect(second).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: true,
      finalized: true,
    });
    // Exactly ONE event ever minted.
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(agreements.record()?.eventId).toBe(NEW_EVENT_ID);
    expect(payoutTerms.activate).toHaveBeenCalledTimes(1);
  });

  it("already finalize-linked agreement → returns the linked event without minting (works for FULFILLED too)", async () => {
    const linkedEventId = "12121212-1212-4121-8121-121212121212";
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "FULFILLED",
        eventId: linkedEventId,
        draftEventId: linkedEventId,
      }),
    });
    // The linked event is live (the plan checks it; review round 5 W1).
    events.getById.mockImplementation(async (id: string) =>
      id === linkedEventId ? ({ id, status: "PUBLISHED", startsAt: new Date("2026-07-11T01:00:00.000Z"), orgId: VENUE_ORG_ID } as never) : null,
    );

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: linkedEventId,
      alreadyLinked: true,
      finalized: true,
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
    // Terms already finalized book nothing (left as-is, documented).
    expect((deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo).lockLine).not.toHaveBeenCalled();
  });

  // Review round 5 W1: the manual "Create event" on terms finalized against
  // an event that has since been cancelled or archived no longer hands that
  // event back — the plan refuses it, like every booking path.
  it.each([["CANCELLED"], ["ARCHIVED"]])(
    "finalize-linked to an event that is now %s → INVALID_STATUS linked_event_not_live, nothing minted",
    async (status) => {
      const linkedEventId = "12121212-1212-4121-8121-121212121212";
      const { deps, events } = buildDeps({
        agreement: buildAgreementRecord({ status: "FULFILLED", eventId: linkedEventId }),
      });
      events.getById.mockImplementation(async (id: string) =>
        id === linkedEventId ? ({ id, status, startsAt: new Date("2026-07-11T01:00:00.000Z") } as never) : null,
      );

      await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "linked_event_not_live",
        meta: { agreementId: AGREEMENT_ID, eventId: linkedEventId },
      });
      expect(events.upsertDraft).not.toHaveBeenCalled();
    },
  );

  it("concurrent double-call: exactly one event; the loser replays or sees the in-progress lock", async () => {
    const { deps, events } = buildDeps();

    const settled = await Promise.allSettled([
      createEventFromAgreement(deps, baseInput),
      createEventFromAgreement(deps, baseInput),
    ]);

    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const s of fulfilled) {
      expect((s as PromiseFulfilledResult<{ eventId: string }>).value.eventId).toBe(
        NEW_EVENT_ID,
      );
    }
    for (const s of settled) {
      if (s.status === "rejected") {
        expect(s.reason).toMatchObject({
          code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
        });
      }
    }
  });

  it("deleted draft: retained records are never honored — second call mints FRESH under a generation-scoped key; third call replays it", async () => {
    // The bricking scenario from review: mint E1 (envelope caches {E1} for
    // 24h) → venue deletes E1 (FK SetNulls the anchor, records survive) →
    // next click must NOT hand back the dead id or die on it — it advances
    // to the `:after:E1` generation and mints fresh.
    const { deps, agreements, events, deleteEvent } = buildDeps();

    const first = await createEventFromAgreement(deps, baseInput);
    expect(first).toMatchObject({
      eventId: NEW_EVENT_IDS[0],
      finalized: true,
    });

    deleteEvent(NEW_EVENT_IDS[0]);
    expect(agreements.record()?.draftEventId).toBeNull();
    expect(agreements.record()?.eventId).toBeNull();

    const second = await createEventFromAgreement(deps, baseInput);
    expect(second).toEqual({
      eventId: NEW_EVENT_IDS[1], // a FRESH event, not the dead replay
      alreadyLinked: false,
      finalized: true, // the finalize envelope also skipped ITS stale record
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_IDS[1]);
    expect(agreements.record()?.eventId).toBe(NEW_EVENT_IDS[1]);

    // Third call converges idempotently on the fresh draft.
    const third = await createEventFromAgreement(deps, baseInput);
    expect(third).toEqual({
      eventId: NEW_EVENT_IDS[1],
      alreadyLinked: true,
      finalized: true,
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
  });

  it("save-path replay of a deleted id (envelope expired, save record retained): the mint loop advances the save clientKey and mints fresh", async () => {
    // The >24h-but-<3d window: this use case's envelope record has expired,
    // so the create begins fresh — but the SAVE path's retained record
    // replays the deleted event id. The liveness loop must reject it and
    // re-mint under the `:after:<staleId>` save key.
    const idempotency = makeDroppableIdempotency();
    const { deps, agreements, events, deleteEvent } = buildDeps({
      idempotency,
    });

    const first = await createEventFromAgreement(deps, baseInput);
    expect(first.eventId).toBe(NEW_EVENT_IDS[0]);

    // Envelope record ages out; the save record survives.
    idempotency.drop(`bookingAgreement:createEvent:${AGREEMENT_ID}`);
    deleteEvent(NEW_EVENT_IDS[0]);

    const second = await createEventFromAgreement(deps, baseInput);

    expect(second.eventId).toBe(NEW_EVENT_IDS[1]);
    expect(second.alreadyLinked).toBe(false);
    // Two real mints: the save replay of the dead id never surfaced.
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_IDS[1]);
  });

  it("in-progress envelope (no committed record) → IDEMPOTENCY_LOCK_IN_PROGRESS, nothing minted", async () => {
    const { deps, idempotency, events } = buildDeps();
    await idempotency.begin(`bookingAgreement:createEvent:${AGREEMENT_ID}`, 60);

    await expect(
      createEventFromAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_LOCK_IN_PROGRESS" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("anchor-CAS loser (envelope amnesia backstop): tx rolls back the lineup, orphan is REPORTED, conflict surfaces", async () => {
    const { deps, events, eventHumans, reportError } = buildDeps({
      updateConflict: true, // setDraftEvent CAS loses
    });

    await expect(
      createEventFromAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });

    // The save committed an event whose anchor stamp then lost — that orphan
    // must be visible in Sentry (ReporterPort convention).
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: expect.objectContaining({
          agreementId: AGREEMENT_ID,
          orphanEventId: NEW_EVENT_ID,
        }),
      }),
    );
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    // setDraftEvent threw before the attach — no half-linked lineup.
    expect(eventHumans.attach).not.toHaveBeenCalled();
  });

  // ── Gates ──────────────────────────────────────────────────────────────────

  it("blocks non-ACCEPTED agreements", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
    });

    await expect(
      createEventFromAgreement(deps, baseInput),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_ACCEPTED" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("rejects actors with no place access (NOT_RESOURCE_OWNER)", async () => {
    const { deps } = buildDeps();

    await expect(
      createEventFromAgreement(deps, {
        ...baseInput,
        actorHumanId: OUTSIDER_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects org members below edit level (INSUFFICIENT_ROLE)", async () => {
    const { deps } = buildDeps();

    await expect(
      createEventFromAgreement(deps, {
        ...baseInput,
        actorHumanId: VENUE_VIEWER_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects agreements without a linked booking request (booking-specific procedure)", async () => {
    const { deps } = buildDeps({ request: null });

    await expect(
      createEventFromAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "BOOKING_REQUEST_NOT_FOUND",
      meta: expect.objectContaining({
        reason: "agreement_has_no_booking_request",
      }),
    });
  });

  it("rejects TO_PERFORMER-originated agreements (organizer-booking-requests v1 guard, NFR-001)", async () => {
    const { deps, events } = buildDeps({
      request: buildRequest({
        direction: "TO_PERFORMER",
        placeId: null,
        placeName: null,
        organizerOrgId: "99999999-9999-4999-8999-999999999999",
      }),
    });

    await expect(
      createEventFromAgreement(deps, baseInput),
    ).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "organizer_agreement_event_creation_unsupported",
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  // ── Lineup identity variants ───────────────────────────────────────────────

  it("anonymous-unclaimed sender → free-text headliner from actName, contactName fallback", async () => {
    const { deps, eventHumans, events } = buildDeps({
      request: buildRequest({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Jamie Doe",
        contactEmail: "jamie@example.com",
        actName: null,
        source: "EMBED",
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: null,
        externalName: "Jamie Doe",
        role: "PERFORMER",
        sortOrder: 0,
      }),
    );
    // Title falls back to the contact name too.
    expect(events.upsertDraft.mock.calls[0]![0]!.title).toBe(
      "Jamie Doe at Test Venue",
    );
  });

  it("org-typed performer sender → free-text headliner from the org display name (documented EventHuman limitation)", async () => {
    const { deps, eventHumans } = buildDeps({
      request: buildRequest({
        performerOwnerType: "organization",
        performerOwnerId: PERFORMER_ORG_ID,
        actName: null,
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: null, externalName: "Band Org" }),
    );
  });

  // ── Human venue counterparty ───────────────────────────────────────────────

  it("human counterparty: the counterparty human (direct place owner) creates a human-owned event", async () => {
    const { deps, events, agreements } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        counterpartyType: "human",
        counterpartyId: VENUE_OWNER_ID,
      }),
      place: buildPlace({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [VENUE_OWNER_ID],
      }),
    });

    const result = await createEventFromAgreement(deps, {
      ...baseInput,
      actorHumanId: VENUE_OWNER_ID,
    });

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(result.finalized).toBe(true);
    expect(events.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null, humanId: VENUE_OWNER_ID }),
    );
    expect(agreements.record()?.eventId).toBe(NEW_EVENT_ID);
  });

  // holds-without-a-request FR-002 retires the venue-confirmation spec's
  // grant hook here: minting from an ACT's agreement is staff-only. Was: a
  // grantee passed the venue gate via the grant, was refused the VENUE-owned
  // mint (grant_cannot_mint_venue_owned) and minted a REQUESTER-owned (RENT)
  // draft, stamped venue-confirmed. Both are now refused at the staff gate,
  // before any save, envelope claim or stamp.
  it.each([
    ["a VENUE-owned (PERFORM) event", "PERFORM"],
    ["a REQUESTER-owned (RENT) event", "RENT"],
  ] as const)("a booking grantee minting %s is refused NOT_RESOURCE_OWNER at the staff gate; nothing saved or stamped", async (_label, intent) => {
    const { deps, events } = buildDeps({
      request: buildRequest({ intent }),
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        counterpartyType: "human",
        counterpartyId: OUTSIDER_ID,
      }),
      place: buildPlace({ orgIdsWithAccess: [], humanIdsWithAccess: [VENUE_OWNER_ID] }),
    });
    const grants = (deps.repos as unknown as { placeBookingGrants: FakePlaceBookingGrantsRepo }).placeBookingGrants;
    grants.seed({ placeId: PLACE_ID, humanId: OUTSIDER_ID });
    const envelopeBegin = vi.spyOn(deps.idempotency, "begin");

    await expect(
      createEventFromAgreement(deps, { ...baseInput, actorHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER", meta: { entity: "place" } });
    // The staff gate never reads grants.
    expect(grants.findActiveForActor).not.toHaveBeenCalled();
    expect(events.upsertDraft).not.toHaveBeenCalled();
    expect(vi.mocked(deps.repos.agreements.setDraftEvent)).not.toHaveBeenCalled();
    expect(events.setVenueConfirmation).not.toHaveBeenCalled();
    expect(envelopeBegin).not.toHaveBeenCalled();
  });

  it("an owner's mint is venue-owned by construction: never stamped", async () => {
    const owner = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED", counterpartyType: "human", counterpartyId: VENUE_OWNER_ID }),
      place: buildPlace({ orgIdsWithAccess: [], humanIdsWithAccess: [VENUE_OWNER_ID] }),
    });
    await createEventFromAgreement(owner.deps, { ...baseInput, actorHumanId: VENUE_OWNER_ID });
    expect(owner.events.setVenueConfirmation).not.toHaveBeenCalled();
  });

  it("human counterparty: a DIFFERENT direct owner cannot mint an event owned by the counterparty (NOT_RESOURCE_OWNER)", async () => {
    const otherOwner = "32323232-3232-4232-8232-323232323232";
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        counterpartyType: "human",
        counterpartyId: VENUE_OWNER_ID,
      }),
      place: buildPlace({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [VENUE_OWNER_ID, otherOwner],
      }),
    });

    await expect(
      createEventFromAgreement(deps, { ...baseInput, actorHumanId: otherOwner }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: expect.objectContaining({ entity: "agreement_counterparty" }),
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  // ── Overrides ──────────────────────────────────────────────────────────────

  it("honors title/startsAt overrides", async () => {
    const { deps, events } = buildDeps();

    await createEventFromAgreement(deps, {
      ...baseInput,
      overrides: {
        title: "Custom Show Title",
        startsAt: "2026-08-01T01:30:00.000Z",
      },
    });

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.title).toBe("Custom Show Title");
    expect(draft.startsAt.toISOString()).toBe("2026-08-01T01:30:00.000Z");
    expect(draft.endsAt?.toISOString()).toBe("2026-08-01T04:30:00.000Z");
  });

  it("DST boundary: a preferred date after fall-back resolves 19:00 CST (UTC-6)", async () => {
    // 2026-07-10 (CDT test above) is UTC-5; 2026-11-06 is past the Nov 1
    // fall-back, so 19:00 America/Chicago = 2026-11-07T01:00:00Z.
    const { deps, events } = buildDeps({
      request: buildRequest({ preferredDates: ["2026-11-06"] }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-11-07T01:00:00.000Z");
    expect(draft.endsAt?.toISOString()).toBe("2026-11-07T04:00:00.000Z");
  });

  // ── Negotiated date (Agreement.proposedDate / proposedEndDate) ────────────

  it("prefers the NEGOTIATED proposedDate over preferredDates[0], using the instant AS-IS", async () => {
    // The header editor stores proposedDate as a bare instant
    // (z.coerce.date(), no timezone captured) — no 19:00 anchoring may be
    // applied to it; the request's preferredDates are only the opening ask.
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-09-05T02:30:00.000Z"),
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-09-05T02:30:00.000Z");
    // No proposedEndDate → standard +3h show length.
    expect(draft.endsAt?.toISOString()).toBe("2026-09-05T05:30:00.000Z");
  });

  it("honors the negotiated proposedEndDate when the negotiated start is used", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-09-05T02:30:00.000Z"),
        proposedEndDate: new Date("2026-09-05T06:00:00.000Z"),
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-09-05T02:30:00.000Z");
    expect(draft.endsAt?.toISOString()).toBe("2026-09-05T06:00:00.000Z");
  });

  it("the event's duration follows a SEEDED set length end-to-end", async () => {
    // What the accept now seeds for "Sep 15, 45-minute set": proposedDate at
    // 19:00 in the venue's zone, proposedEndDate 45 minutes later. The mint
    // must carry that through instead of flattening it to +3h — that flatten
    // is exactly what "everything talked about gets lost" looked like.
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-09-16T00:00:00.000Z"),
        proposedEndDate: new Date("2026-09-16T00:45:00.000Z"),
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(draft.endsAt?.toISOString()).toBe("2026-09-16T00:45:00.000Z");
  });

  it("still falls back to +3h when NOTHING named a duration", async () => {
    // A pitch with no `setLengthMinutes` seeds no `proposedEndDate`, so the
    // default show length remains the answer for "nobody said".
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-09-16T00:00:00.000Z"),
        proposedEndDate: null,
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.endsAt?.toISOString()).toBe("2026-09-16T03:00:00.000Z");
  });

  it("a SAME-DAY startsAt override still wins over the negotiated time (and drops the negotiated end span)", async () => {
    // Agreed: 21:30 CDT on 2026-09-04. Override: 23:00 CDT the same day.
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-09-05T02:30:00.000Z"),
        proposedEndDate: new Date("2026-09-05T06:00:00.000Z"),
      }),
    });

    await createEventFromAgreement(deps, {
      ...baseInput,
      overrides: { startsAt: "2026-09-05T04:00:00.000Z" },
    });

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-09-05T04:00:00.000Z");
    // An override drops the negotiated end span → +3h.
    expect(draft.endsAt?.toISOString()).toBe("2026-09-05T07:00:00.000Z");
  });

  // booking-the-night review W1: the override moves the TIME, never the
  // agreed NIGHT — booking a day the terms never named would book a night
  // nobody agreed.
  it("an override on ANOTHER day than the agreed night → HOLD_DATE_MISMATCHES_EVENT, before any line change or mint", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-09-05T02:30:00.000Z"), // 2026-09-04 CDT
      }),
    });

    await expect(
      createEventFromAgreement(deps, {
        ...baseInput,
        overrides: { startsAt: "2026-10-01T01:00:00.000Z" }, // 2026-09-30 CDT
      }),
    ).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventDate: "2026-09-30", holdDate: "2026-09-04", reason: "override_on_another_day" },
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
    const holds = deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo;
    expect(holds.updateStatus).not.toHaveBeenCalled();
    expect(holds.create).not.toHaveBeenCalled();
  });

  it("degenerate proposedEndDate (== proposedDate — the header editor allows equality) falls back to +3h", async () => {
    const negotiated = new Date("2026-09-05T02:30:00.000Z");
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: negotiated,
        proposedEndDate: negotiated,
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.endsAt?.toISOString()).toBe("2026-09-05T05:30:00.000Z");
  });

  it("rejects unknown override keys (.strict())", async () => {
    const { deps } = buildDeps();

    await expect(
      createEventFromAgreement(deps, {
        ...baseInput,
        overrides: { title: "x", venueId: "nope" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue-hierarchy routing (FR-005 / FR-009): calendar-composed titles,
// template defaults, calendarId/spaceId stamping.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Owner by intent (venue-confirmation-and-booking-intents spec, docs/specs/
// 2026-08-27 "Who mints, who owns"): PERFORM → venue (today's behaviour);
// RENT / USE → the requester; the venue side may override either way. The
// venue stays the mint AUTHORITY — only the owner assignment changes.
// ─────────────────────────────────────────────────────────────────────────────

describe("createEventFromAgreement — owner by intent", () => {
  it("PERFORM (default): venue-owned exactly as before — org counterparty, org-owned draft, finalize attempted", async () => {
    const { deps, events, agreements } = buildDeps({ request: buildRequest({ intent: "PERFORM" }) });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(events.upsertDraft).toHaveBeenCalledWith(expect.objectContaining({ orgId: VENUE_ORG_ID, humanId: null }));
    expect(result).toMatchObject({ finalized: true });
    expect(agreements.record()?.eventId).toBe(NEW_EVENT_ID);
  });

  it.each(["RENT", "USE"] as const)("%s: the draft is owned by the REQUESTER (human sender) while the VENUE admin is the actor; finalize is deferred to the owner", async (intent) => {
    const { deps, events, eventHumans, agreements, audit } = buildDeps({ request: buildRequest({ intent }) });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "requester_owned",
    });
    // Owner = the request's sender, never the venue counterparty.
    expect(events.upsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: null, humanId: PERFORMER_ID, location: { kind: "place", placeId: PLACE_ID } }),
    );
    // The venue is still the actor of record and the anchor + lineup land as usual.
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    expect(agreements.record()?.eventId).toBeNull();
    expect(eventHumans.attach).toHaveBeenCalledWith(expect.objectContaining({ humanId: PERFORMER_ID, role: "PERFORMER" }));
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({ actorHumanId: VENUE_ADMIN_ID, ownerSide: "requester", ownerOverride: null }),
      }),
    );
    expect(deps.repos.payoutTerms.activate).not.toHaveBeenCalled();
  });

  it("RENT with an ORG sender: the draft is owned by that org (org save internals: quota + usage), the venue admin need hold no seat in it", async () => {
    const { deps, events } = buildDeps({
      request: buildRequest({
        intent: "RENT",
        performerOwnerType: "organization",
        performerOwnerId: PERFORMER_ORG_ID,
      }),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.finalizeBlocked).toBe("requester_owned");
    expect(events.upsertDraft).toHaveBeenCalledWith(expect.objectContaining({ orgId: PERFORMER_ORG_ID, humanId: null }));
    expect(deps.repos.resourceQuotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "ORG", subjectId: PERFORMER_ORG_ID }),
    );
    // The actor's membership in the REQUESTER org was never asked for.
    expect(deps.repos.authz.getOrgMembership).not.toHaveBeenCalledWith(
      expect.objectContaining({ orgId: PERFORMER_ORG_ID }),
    );
  });

  it("ownerOverride: 'requester' on a PERFORM request → requester-owned; 'place' on a RENT request → place-owned and finalized", async () => {
    const toRequester = buildDeps({ request: buildRequest({ intent: "PERFORM" }) });
    const a = await createEventFromAgreement(toRequester.deps, { ...baseInput, ownerOverride: "requester" });
    expect(a.finalizeBlocked).toBe("requester_owned");
    expect(toRequester.events.upsertDraft).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, humanId: PERFORMER_ID }));
    expect(toRequester.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ownerSide: "requester", ownerOverride: "requester" }) }),
    );

    const toVenue = buildDeps({ request: buildRequest({ intent: "RENT" }) });
    const b = await createEventFromAgreement(toVenue.deps, { ...baseInput, ownerOverride: "place" });
    expect(b.finalized).toBe(true);
    expect(toVenue.events.upsertDraft).toHaveBeenCalledWith(expect.objectContaining({ orgId: VENUE_ORG_ID, humanId: null }));
  });

  it("the hold entry passes ownerOverride through to the shared mint", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      request: buildRequest({ intent: "PERFORM", status: "ACCEPTED" }),
    });
    await createEventFromAgreementForHold(deps, {
      ...baseInput,
      hold: {
        id: "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d",
        calendarId: DEFAULT_CALENDAR_ID,
        spaceId: null,
        date: "2026-07-10",
        startsAt: new Date("2026-07-11T01:00:00.000Z"),
        endsAt: null,
      },
      ownerOverride: "requester",
    });
    expect(events.upsertDraft).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, humanId: PERFORMER_ID }));
  });

  it("W1: the venue ADMIN minting a requester-owned draft manages the place, so the save stamps the venue confirmation (with the minted start)", async () => {
    const { deps, events } = buildDeps({ request: buildRequest({ intent: "RENT" }) });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(deps.authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: VENUE_ADMIN_ID,
      placeId: PLACE_ID,
    });
    expect(events.setVenueConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: result.eventId,
        placeId: PLACE_ID,
        confirmedByHumanId: VENUE_ADMIN_ID,
      }),
    );
    const row = (await events.getById(result.eventId)) as Record<string, unknown>;
    expect(row.venueConfirmedStartsAt).toEqual(row.startsAt);
  });

  it("the requester-owned mint still needs VENUE authority: a requester (no venue access) is NOT_RESOURCE_OWNER and nothing is minted", async () => {
    const { deps, events } = buildDeps({ request: buildRequest({ intent: "RENT" }) });
    await expect(
      createEventFromAgreement(deps, { ...baseInput, actorHumanId: PERFORMER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("a requester-owned mint from an anonymous / unclaimed request is refused (INVALID_STATUS requester_not_owned) before any save", async () => {
    const { deps, events } = buildDeps({
      request: buildRequest({
        intent: "RENT",
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Jamie Doe",
        contactEmail: "jamie@example.com",
        source: "EMBED",
      }),
    });
    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "requester_not_owned",
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("a requester-owned mint keeps the place LIVENESS gate: a SUSPENDED place → PLACE_NOT_ACTIVE before any save", async () => {
    const { deps, events } = buildDeps({
      request: buildRequest({ intent: "RENT" }),
      place: buildPlace({ status: "SUSPENDED" }),
    });
    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("the requester ORG's quota refusal reaches the venue as forbidden/quota_exceeded_for_requester (same code + meta, a message the venue can act on)", async () => {
    const { deps, events } = buildDeps({
      request: buildRequest({ intent: "RENT", performerOwnerType: "organization", performerOwnerId: PERFORMER_ORG_ID }),
    });
    vi.mocked(deps.repos.resourceQuotas.getEffectiveQuota).mockResolvedValueOnce({ limitValue: 1n, currentUsage: 1n } as never);

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "forbidden",
      message: "quota_exceeded_for_requester",
      meta: expect.objectContaining({ subjectType: "ORG", subjectId: PERFORMER_ORG_ID }),
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  // holds-without-a-request FR-002: was "a grant-holder minting a
  // requester-owned draft … is stamped venue-confirmed (H1)". A grantee is
  // not staff; the USE mint is refused and nothing is stamped.
  it("a booking grantee minting a requester-owned (USE) draft is refused; nothing saved or stamped", async () => {
    const { deps, events } = buildDeps({
      request: buildRequest({ intent: "USE" }),
      place: buildPlace({ orgIdsWithAccess: [], humanIdsWithAccess: [VENUE_OWNER_ID] }),
    });
    const grants = (deps.repos as unknown as { placeBookingGrants: FakePlaceBookingGrantsRepo }).placeBookingGrants;
    grants.seed({ placeId: PLACE_ID, humanId: OUTSIDER_ID });

    await expect(
      createEventFromAgreement(deps, { ...baseInput, actorHumanId: OUTSIDER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
    expect(events.setVenueConfirmation).not.toHaveBeenCalled();
  });
});

describe("createEventFromAgreement — calendar routing (venue hierarchy)", () => {
  const CALENDAR_ID = "ca1e0da1-1111-4111-8111-111111111111";
  const SPACE_ACTIVE_ID = "0000f00d-1111-4111-8111-111111111111";
  const SPACE_RETIRED_ID = "0000f00d-2222-4222-8222-222222222222";
  const CATEGORY_ID = "cate6011-1111-4111-8111-111111111111";

  /**
   * Minimal calendars fake for `listByPlace` (the only method the routing
   * uses): one calendar joined to a RETIRED space (sortOrder 0) and an ACTIVE
   * space (sortOrder 1) — the ACTIVE one must win despite sorting second.
   */
  const makeCalendarsFake = (overrides: Record<string, unknown> = {}) => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [
            {
              id: CALENDAR_ID,
              placeId: PLACE_ID,
              name: "Social Club",
              slug: "social-club",
              description: null,
              isDefault: true,
              defaultStartTime: null,
              defaultCategoryId: null,
              eventTemplate: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              spaces: [
                {
                  id: SPACE_RETIRED_ID,
                  placeId: PLACE_ID,
                  name: "Old Space",
                  capacity: null,
                  sortOrder: 0,
                  status: "RETIRED",
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
                {
                  id: SPACE_ACTIVE_ID,
                  placeId: PLACE_ID,
                  name: "Main Space",
                  capacity: null,
                  sortOrder: 1,
                  status: "ACTIVE",
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ],
              ...overrides,
            },
          ]
        : [],
    ),
  });

  const routedRequest = () => buildRequest({ calendarId: CALENDAR_ID });

  it("composes the title as '{act} at {calendar.name}' and stamps calendarId + first ACTIVE space", async () => {
    const calendars = makeCalendarsFake();
    const { deps, events } = buildDeps({
      calendars,
      request: routedRequest(),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    // Title: calendar name, not place name.
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.title).toBe("The Fake Band at Social Club");

    // Placement stamp: calendarId + the ACTIVE space (retired sortOrder-0
    // sibling skipped); no categoryId (calendar has no default).
    expect(events.setVenuePlacement).toHaveBeenCalledTimes(1);
    expect(events.setVenuePlacement).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      calendarId: CALENDAR_ID,
      spaceId: SPACE_ACTIVE_ID,
    });
  });

  it("anonymous inquiry without an actName falls back to the existing '{contact} at {place}' title", async () => {
    const calendars = makeCalendarsFake();
    const { deps, events } = buildDeps({
      calendars,
      request: buildRequest({
        calendarId: CALENDAR_ID,
        actName: null,
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Jane Doe",
        contactEmail: "jane@example.com",
        source: "EMBED",
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.title).toBe("Jane Doe at Test Venue");
    // Placement still stamps — routing is independent of the title fallback.
    expect(events.setVenuePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: CALENDAR_ID }),
    );
  });

  it("applies the calendar's defaultStartTime + defaultCategoryId ONLY as defaults", async () => {
    const calendars = makeCalendarsFake({
      defaultStartTime: "20:30",
      defaultCategoryId: CATEGORY_ID,
    });
    const { deps, events } = buildDeps({
      calendars,
      request: routedRequest(),
    });

    await createEventFromAgreement(deps, baseInput);

    // 20:30 America/Chicago (CDT, UTC-5) on 2026-07-10 → 01:30Z next day.
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-07-11T01:30:00.000Z");

    // Draft has no category of its own → the calendar default applies.
    expect(events.setVenuePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: CATEGORY_ID }),
    );
  });

  it.each([
    ["INACTIVE", { active: false }],
    ["deleted", null],
  ] as const)(
    "leaves the event uncategorised when the calendar's default category is %s, and still places it",
    async (_label, defaultCategory) => {
      const calendars = makeCalendarsFake({ defaultCategoryId: CATEGORY_ID });
      const { deps, events } = buildDeps({
        calendars,
        request: routedRequest(),
        defaultCategory,
      });

      const result = await createEventFromAgreement(deps, baseInput);

      // The mint is not refused, and the calendar + space still stamp.
      expect(result.eventId).toBe(NEW_EVENT_ID);
      const placement = events.setVenuePlacement.mock.calls[0]![0]!;
      expect(placement).toMatchObject({ calendarId: CALENDAR_ID });
      // No categoryId key at all: `setEventCategory` would refuse this
      // category, so the mint must not write it either.
      expect(placement).not.toHaveProperty("categoryId");
    },
  );

  it("a NEGOTIATED proposedDate beats the calendar's defaultStartTime (default, not override)", async () => {
    const negotiated = new Date("2026-08-01T21:00:00.000Z");
    const calendars = makeCalendarsFake({ defaultStartTime: "20:30" });
    const { deps, events } = buildDeps({
      calendars,
      request: routedRequest(),
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: negotiated,
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe(negotiated.toISOString());
  });

  it("an explicit title override beats the composed title", async () => {
    const calendars = makeCalendarsFake();
    const { deps, events } = buildDeps({
      calendars,
      request: routedRequest(),
    });

    await createEventFromAgreement(deps, {
      ...baseInput,
      overrides: { title: "Hand-picked Title" },
    });

    expect(events.upsertDraft.mock.calls[0]![0]!.title).toBe(
      "Hand-picked Title",
    );
  });

  it("calendar with NO active spaces: stamps calendarId with spaceId null, REPORTS, never fails the mint", async () => {
    const calendars = makeCalendarsFake();
    // All spaces retired.
    const onlyRetired = await calendars.listByPlace(PLACE_ID);
    onlyRetired[0]!.spaces = onlyRetired[0]!.spaces.map((r: { status: string }) => ({
      ...r,
      status: "RETIRED",
    }));
    calendars.listByPlace.mockResolvedValue(onlyRetired);

    const { deps, events, reportError } = buildDeps({
      calendars,
      request: routedRequest(),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(events.setVenuePlacement).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      calendarId: CALENDAR_ID,
      spaceId: null,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "createEventFromAgreement" },
        extra: expect.objectContaining({ calendarId: CALENDAR_ID }),
      }),
    );
  });

  it("a THROWING reporter on the no-active-spaces branch never fails the mint", async () => {
    const calendars = makeCalendarsFake();
    const onlyRetired = await calendars.listByPlace(PLACE_ID);
    onlyRetired[0]!.spaces = onlyRetired[0]!.spaces.map((r: { status: string }) => ({
      ...r,
      status: "RETIRED",
    }));
    calendars.listByPlace.mockResolvedValue(onlyRetired);

    const { deps } = buildDeps({ calendars, request: routedRequest() });
    (deps.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("reporter down");
    });

    await expect(
      createEventFromAgreement(deps, baseInput),
    ).resolves.toMatchObject({ eventId: NEW_EVENT_ID });
  });

  it("a THROWING calendars repo degrades to the pre-hierarchy mint and reports", async () => {
    const calendars = {
      listByPlace: vi.fn(async () => {
        throw new Error("calendars unavailable");
      }),
    };
    const { deps, events, reportError } = buildDeps({
      calendars,
      request: routedRequest(),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    // Full fallback: place-name title, no placement stamp.
    expect(events.upsertDraft.mock.calls[0]![0]!.title).toBe(
      "The Fake Band at Test Venue",
    );
    expect(events.setVenuePlacement).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "createEventFromAgreement" },
      }),
    );
  });

  it("cross-place calendarId resolves to NOTHING: fallback title + DEFAULT-calendar placement (isolation, no spaceless mint)", async () => {
    // The routed calendar belongs to another place: listByPlace(PLACE_ID)
    // simply doesn't contain it. The title/template prefills fall back to the
    // pre-hierarchy shape, but the PLACEMENT falls through to the place's
    // default calendar + first ACTIVE space (spaceless-mint guard).
    const calendars = makeCalendarsFake();
    const { deps, events, reportError } = buildDeps({
      calendars,
      request: buildRequest({
        calendarId: "ca1e0da1-9999-4999-8999-999999999999",
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    expect(events.upsertDraft.mock.calls[0]![0]!.title).toBe(
      "The Fake Band at Test Venue",
    );
    expect(events.setVenuePlacement).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      calendarId: CALENDAR_ID,
      spaceId: SPACE_ACTIVE_ID,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("UNROUTED request (null calendarId): place-name title, but placement falls back to the DEFAULT calendar + first ACTIVE space", async () => {
    const calendars = makeCalendarsFake();
    const { deps, events, reportError } = buildDeps({
      calendars,
      request: buildRequest(),
    });

    await createEventFromAgreement(deps, baseInput);

    // Prefills stay pre-hierarchy: the fallback is placement-only, never a
    // restyle (no calendar-composed title, no template defaults).
    expect(events.upsertDraft.mock.calls[0]![0]!.title).toBe(
      "The Fake Band at Test Venue",
    );
    expect(events.setVenuePlacement).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      calendarId: CALENDAR_ID,
      spaceId: SPACE_ACTIVE_ID,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("UNROUTED request, default calendar has NO active spaces: stays spaceless AND is reported", async () => {
    const calendars = makeCalendarsFake();
    const onlyRetired = await calendars.listByPlace(PLACE_ID);
    onlyRetired[0]!.spaces = onlyRetired[0]!.spaces.map((r: { status: string }) => ({
      ...r,
      status: "RETIRED",
    }));
    calendars.listByPlace.mockResolvedValue(onlyRetired);

    const { deps, events, reportError } = buildDeps({
      calendars,
      request: buildRequest(),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(events.setVenuePlacement).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "createEventFromAgreement" },
        extra: expect.objectContaining({
          placeId: PLACE_ID,
          reason: "default_calendar_has_no_active_spaces",
        }),
      }),
    );
  });

  it("UNROUTED request, NO default calendar at the place: stays spaceless AND is reported", async () => {
    const calendars = makeCalendarsFake({ isDefault: false });
    const { deps, events, reportError } = buildDeps({
      calendars,
      request: buildRequest(),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(events.setVenuePlacement).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ reason: "no_default_calendar" }),
      }),
    );
  });

  it("UNROUTED request with the DEFAULT deps: fallback placement stamps the default calendar + space silently", async () => {
    // The calendars repo is REQUIRED on the aggregate (Step 5) — the old
    // "repo not wired" staging path is gone. buildDeps' default fake mirrors
    // a real venue (one default calendar, one ACTIVE space), so an unrouted
    // mint lands in the space system without any report.
    const { deps, events, reportError } = buildDeps({ request: buildRequest() });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(events.setVenuePlacement).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      calendarId: DEFAULT_CALENDAR_ID,
      spaceId: DEFAULT_SPACE_ID,
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue timezone anchoring (venue-hierarchy FR-004): the place's
// address-derived timezone anchors the default wall-clock start AND is stored
// on the event — always together.
// ─────────────────────────────────────────────────────────────────────────────

describe("createEventFromAgreement — venue timezone (FR-004)", () => {
  it("anchors the default start in the place's timezone and stamps that zone on the event", async () => {
    const { deps, events } = buildDeps({
      place: buildPlace({ timezone: "America/New_York" }),
    });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    // 19:00 America/New_York (EDT, UTC-4) on 2026-07-10 → 23:00Z — one hour
    // EARLIER on the clock than the platform-default Chicago anchor, proving
    // the venue zone (not the default) did the anchoring.
    expect(draft.startsAt.toISOString()).toBe("2026-07-10T23:00:00.000Z");
    // The SAME zone is stored on the event, so the instant and its display
    // label can never disagree.
    expect(draft.timezone).toBe("America/New_York");
  });

  it("resolves the calendar's defaultStartTime wall-clock in the venue zone", async () => {
    const calendars = makeDefaultCalendarsFake();
    const [calendar] = await calendars.listByPlace(PLACE_ID);
    calendars.listByPlace.mockResolvedValue([
      { ...calendar!, defaultStartTime: "20:30" },
    ]);

    const { deps, events } = buildDeps({
      calendars,
      place: buildPlace({ timezone: "America/New_York" }),
      request: buildRequest({ calendarId: DEFAULT_CALENDAR_ID }),
    });

    await createEventFromAgreement(deps, baseInput);

    // 20:30 America/New_York (EDT, UTC-4) on 2026-07-10 → 00:30Z next day.
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-07-11T00:30:00.000Z");
    expect(draft.timezone).toBe("America/New_York");
  });

  it("honors a preferred date that CARRIES a time, over the calendar's default", async () => {
    // `bookingPreferredDateSchema` started admitting `YYYY-MM-DDTHH:MM` after
    // this fallback was written, and the fallback used to re-anchor at the
    // calendar default — silently discarding the slot the act had picked out
    // of the venue's own availability. It now honours it, matching what the
    // ACCEPT seeds into `proposedDate`.
    const calendars = makeDefaultCalendarsFake();
    const [calendar] = await calendars.listByPlace(PLACE_ID);
    calendars.listByPlace.mockResolvedValue([
      { ...calendar!, defaultStartTime: "20:30" },
    ]);

    const { deps, events } = buildDeps({
      calendars,
      place: buildPlace({ timezone: "America/New_York" }),
      request: buildRequest({
        calendarId: DEFAULT_CALENDAR_ID,
        preferredDates: ["2026-07-10T21:15"],
      }),
    });

    await createEventFromAgreement(deps, baseInput);

    // 21:15 America/New_York (EDT) → 01:15Z next day.
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe("2026-07-11T01:15:00.000Z");
  });

  it("a place WITHOUT a derived timezone keeps the platform default", async () => {
    const { deps, events } = buildDeps();

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe(EXPECTED_DEFAULT_STARTS_AT);
    expect(draft.timezone).toBe("America/Chicago");
  });

  it("a MALFORMED stored timezone degrades to the platform default (never fails the mint)", async () => {
    const { deps, events } = buildDeps({
      place: buildPlace({ timezone: "Not/A_Zone" }),
    });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe(EXPECTED_DEFAULT_STARTS_AT);
    expect(draft.timezone).toBe("America/Chicago");
  });
  // ── Booking timeline (step 2) ─────────────────────────────────────────────

  it("logs booking_event.created then booking_agreement.finalized on the request's thread", async () => {
    const { deps } = buildDeps({
      // Finalizable: no confirmation-gated lines, so the finalize inside the
      // create actually runs and stamps the money link.
      lines: [],
    });

    await createEventFromAgreement(deps, baseInput);

    expect(systemEntriesFor(deps.repos, REQUEST_ID)).toEqual([
      {
        // "the moment the booking becomes a show" — startsAt is SNAPSHOTTED so
        // the entry still reads correctly after a later reschedule.
        systemKind: "booking_event.created",
        systemData: {
          eventId: NEW_EVENT_ID,
          agreementId: AGREEMENT_ID,
          startsAt: EXPECTED_DEFAULT_STARTS_AT,
        },
        authorHumanId: VENUE_ADMIN_ID,
        authorSide: "SYSTEM",
      },
      {
        systemKind: "booking_agreement.finalized",
        systemData: { agreementId: AGREEMENT_ID, eventId: NEW_EVENT_ID },
        authorHumanId: VENUE_ADMIN_ID,
        authorSide: "SYSTEM",
      },
    ]);
  });

  it("a finalize BLOCKED on payout readiness still logs the event, and no finalize entry", async () => {
    // The designed partial outcome: the draft event exists, the agreement is
    // not finalized. The ledger must say exactly that — not imply a deal
    // closed that has not.
    const { deps } = buildDeps({
      lines: [buildLineRecord({ requiresConfirmation: true })],
    });

    const result = await createEventFromAgreement(deps, baseInput);
    expect(result.finalized).toBe(false);

    expect(
      systemEntriesFor(deps.repos, REQUEST_ID).map((e) => e.systemKind),
    ).toEqual(["booking_event.created"]);
  });

  it("an ALREADY-LINKED agreement returns its event without re-logging", async () => {
    const linkedEventId = "12121212-1212-4121-8121-121212121212";
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({
        status: "FULFILLED",
        eventId: linkedEventId,
        draftEventId: linkedEventId,
      }),
    });
    events.getById.mockImplementation(async (id: string) =>
      id === linkedEventId ? ({ id, status: "PUBLISHED", startsAt: new Date("2026-07-11T01:00:00.000Z") } as never) : null,
    );

    await createEventFromAgreement(deps, baseInput);

    // The short-circuit returns before any transaction opens, so a venue
    // clicking "create event" twice does not stutter the ledger.
    expect(systemEntriesFor(deps.repos, REQUEST_ID)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds FR-008 — the INTERNAL hold-confirm variant. Same envelope,
// anchor CAS, lineup attach and ledger as the public path; differs ONLY in
// the status gate (open negotiation allowed), the placement source (the
// hold's calendar/space), the start (the hold's instant) and the finalize
// attempt (skipped — terms are not agreed).
// ─────────────────────────────────────────────────────────────────────────────

describe("createEventFromAgreementForHold (booking-holds FR-008)", () => {
  const HOLD_ID = "0b01d000-1111-4111-8111-111111111111";
  const HOLD_CALENDAR_ID = "ca1e0da1-2222-4222-8222-222222222222";
  const HOLD_SPACE_ID = "0000f00d-3333-4333-8333-333333333333";
  const OTHER_SPACE_ID = "0000f00d-4444-4444-8444-444444444444";
  /** 20:00 America/Chicago on 2026-10-13 (CDT). */
  const HOLD_STARTS_AT = new Date("2026-10-14T01:00:00.000Z");

  const calendarsFake = () => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [
            {
              id: HOLD_CALENDAR_ID,
              placeId: PLACE_ID,
              name: "Patio",
              slug: "patio",
              description: null,
              isDefault: false,
              defaultStartTime: "20:00",
              defaultCategoryId: null,
              eventTemplate: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              spaces: [
                { id: OTHER_SPACE_ID, placeId: PLACE_ID, name: "Front", capacity: null, sortOrder: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() },
                { id: HOLD_SPACE_ID, placeId: PLACE_ID, name: "Back", capacity: null, sortOrder: 1, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() },
              ],
            },
          ]
        : [],
    ),
  });

  const holdArgs = (spaceId: string | null = HOLD_SPACE_ID, endsAt: Date | null = null) => ({
    actorHumanId: VENUE_ADMIN_ID,
    agreementId: AGREEMENT_ID,
    hold: { id: HOLD_ID, calendarId: HOLD_CALENDAR_ID, spaceId, date: "2026-10-13", startsAt: HOLD_STARTS_AT, endsAt },
  });

  it("mints on a DRAFT agreement at the hold's instant, on the hold's calendar + the NAMED space, and does not attempt finalize", async () => {
    const { deps, agreements, events, audit } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT", proposedDate: new Date("2026-11-01T01:00:00.000Z") }),
      calendars: calendarsFake(),
    });

    const result = await createEventFromAgreementForHold(deps, holdArgs());

    expect(result).toEqual({ eventId: NEW_EVENT_ID, alreadyLinked: false, finalized: false });
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    // The hold pins the night — even over the negotiated proposedDate.
    expect(draft.startsAt.toISOString()).toBe(HOLD_STARTS_AT.toISOString());
    expect(draft.endsAt?.toISOString()).toBe(new Date(HOLD_STARTS_AT.getTime() + 3 * 3600_000).toISOString());
    expect(events.setVenuePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: NEW_EVENT_ID, calendarId: HOLD_CALENDAR_ID, spaceId: HOLD_SPACE_ID }),
    );
    // Anchored on a DRAFT agreement; NOT finalize-linked.
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    expect(agreements.record()?.eventId).toBeNull();
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "booking_agreement.finalized" }));
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({ holdId: HOLD_ID, calendarId: HOLD_CALENDAR_ID, spaceId: HOLD_SPACE_ID }),
      }),
    );
    expect(systemEntriesFor(deps.repos, REQUEST_ID).map((e) => e.systemKind)).toEqual(["booking_event.created"]);
  });

  it("a spaceless hold falls back to the calendar's first ACTIVE space; a repeat call returns the same draft without minting or finalizing", async () => {
    const { deps, events, agreements } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      calendars: calendarsFake(),
    });

    const first = await createEventFromAgreementForHold(deps, holdArgs(null));
    expect(events.setVenuePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: HOLD_CALENDAR_ID, spaceId: OTHER_SPACE_ID }),
    );

    const second = await createEventFromAgreementForHold(deps, holdArgs(null));
    expect(second).toEqual({ eventId: first.eventId, alreadyLinked: true, finalized: false });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(agreements.record()?.eventId).toBeNull();
  });

  it("hold.endsAt (the end confirm wrote to the header) becomes the draft's endsAt; an end not after the start falls back to +3h", async () => {
    const withEnd = buildDeps({ agreement: buildAgreementRecord({ status: "DRAFT" }), calendars: calendarsFake() });
    const holdEnd = new Date(HOLD_STARTS_AT.getTime() + 90 * 60_000);
    await createEventFromAgreementForHold(withEnd.deps, holdArgs(HOLD_SPACE_ID, holdEnd));
    expect(withEnd.events.upsertDraft.mock.calls[0]![0]!.endsAt?.toISOString()).toBe(holdEnd.toISOString());

    const degenerate = buildDeps({ agreement: buildAgreementRecord({ status: "DRAFT" }), calendars: calendarsFake() });
    await createEventFromAgreementForHold(degenerate.deps, holdArgs(HOLD_SPACE_ID, HOLD_STARTS_AT));
    expect(degenerate.events.upsertDraft.mock.calls[0]![0]!.endsAt?.toISOString()).toBe(
      new Date(HOLD_STARTS_AT.getTime() + 3 * 3600_000).toISOString(),
    );
  });

  it("a CANCELLED draft anchor is dead: the next call mints FRESH and swaps the anchor (replacingDraftEventId), never handing back the dead id", async () => {
    const { deps, events, agreements, audit } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      calendars: calendarsFake(),
    });
    const first = await createEventFromAgreementForHold(deps, holdArgs());
    expect(agreements.record()?.draftEventId).toBe(first.eventId);

    // Venue cancels the draft: the row stays, the anchor stays (no SetNull).
    const serve = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) => {
      const row = await serve(id);
      return row && id === first.eventId ? { ...row, status: "CANCELLED" } : row;
    });

    const second = await createEventFromAgreementForHold(deps, holdArgs());

    expect(second.alreadyLinked).toBe(false);
    expect(second.eventId).toBe(NEW_EVENT_IDS[1]);
    expect(second.eventId).not.toBe(first.eventId);
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_IDS[1]);
    const stamps = vi.mocked(deps.repos.agreements.setDraftEvent).mock.calls.map(([input]) => input);
    expect(stamps[0]).toMatchObject({ draftEventId: first.eventId, replacingDraftEventId: null });
    expect(stamps[1]).toMatchObject({ draftEventId: NEW_EVENT_IDS[1], replacingDraftEventId: first.eventId });
    // The swap is on the audit trail of the fresh mint.
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({ eventId: NEW_EVENT_IDS[1], replacedDraftEventId: first.eventId }),
      }),
    );

    // A third call short-circuits on the LIVE replacement.
    const third = await createEventFromAgreementForHold(deps, holdArgs());
    expect(third).toEqual({ eventId: NEW_EVENT_IDS[1], alreadyLinked: true, finalized: false });
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
  });

  it("cancelled (not deleted) draft — sibling of the deleted-draft generation test: the cached envelope record is not honored, the `:after:<id>` generation is claimed, a fresh draft is minted", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      calendars: calendarsFake(),
    });
    const first = await createEventFromAgreementForHold(deps, holdArgs());
    // The envelope cached {E1}; the venue cancels E1 — row stays, anchor stays.
    const serve = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) => {
      const row = await serve(id);
      return row && id === first.eventId ? { ...row, status: "CANCELLED" } : row;
    });
    const begin = vi.spyOn(deps.idempotency, "begin");

    const second = await createEventFromAgreementForHold(deps, holdArgs());

    expect(second).toEqual({ eventId: NEW_EVENT_IDS[1], alreadyLinked: false, finalized: false });
    expect(begin).toHaveBeenCalledWith(
      `bookingAgreement:createEvent:${AGREEMENT_ID}:after:${first.eventId}`,
      expect.any(Number),
    );
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
  });

  it("anchored draft GONE between the agreement read and the event read (FK SetNull already landed): mints fresh with the plain empty-anchor stamp, never hands back the gone id", async () => {
    const { deps, events, agreements, deleteEvent } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      calendars: calendarsFake(),
    });
    const first = await createEventFromAgreementForHold(deps, holdArgs());
    // The race: the use case reads the agreement (anchor = E1), THEN the
    // venue's delete commits (row gone + SetNull), THEN the event read runs.
    const serve = events.getById.getMockImplementation()!;
    let raced = false;
    events.getById.mockImplementation(async (id: string) => {
      if (id === first.eventId && !raced) {
        raced = true;
        deleteEvent(id);
      }
      return serve(id);
    });

    const second = await createEventFromAgreementForHold(deps, holdArgs());

    expect(second).toEqual({ eventId: NEW_EVENT_IDS[1], alreadyLinked: false, finalized: false });
    expect(second.eventId).not.toBe(first.eventId);
    expect(events.upsertDraft).toHaveBeenCalledTimes(2);
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_IDS[1]);
    const stamps = vi.mocked(deps.repos.agreements.setDraftEvent).mock.calls.map(([input]) => input);
    expect(stamps[1]).toMatchObject({ draftEventId: NEW_EVENT_IDS[1], replacingDraftEventId: null });
  });

  it("refuses a terminal agreement, keeps the public status gate, and is not reachable through the public input schema", async () => {
    const declined = buildDeps({ agreement: buildAgreementRecord({ status: "DECLINED" }), calendars: calendarsFake() });
    await expect(createEventFromAgreementForHold(declined.deps, holdArgs())).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "agreement_terminal",
    });

    // The public path still demands ACCEPTED for the same DRAFT agreement.
    const draft = buildDeps({ agreement: buildAgreementRecord({ status: "DRAFT" }), calendars: calendarsFake() });
    await expect(createEventFromAgreement(draft.deps, baseInput)).rejects.toMatchObject({ code: "AGREEMENT_NOT_ACCEPTED" });
    // …and the public input schema has no `hold` key (.strict()).
    await expect(
      createEventFromAgreement(draft.deps, { ...baseInput, hold: holdArgs().hold }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("the hold-confirm mint runs the SAME bill flow-through (confirmed + free text only)", async () => {
    const acts = createFakeBookingRequestActs({
      senderOf: () => ({ ownerType: "human", ownerId: PERFORMER_ID }),
    });
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: BILL_TAGGED_PENDING_ID, sortOrder: 1 },
      { source: "EXTERNAL", externalName: "Support Act", sortOrder: 2 },
    ]);
    const { deps, eventHumans } = buildDeps({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      calendars: calendarsFake(),
      acts,
    });

    await createEventFromAgreementForHold(deps, holdArgs());

    expect(eventHumans.attach.mock.calls.map(([row]) => [row.humanId, row.externalName, row.sortOrder])).toEqual([
      [PERFORMER_ID, "The Fake Band", 0],
      [null, "Support Act", 1],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bill flows into the event (lineup-booking-requests v2, FR-006)
// ─────────────────────────────────────────────────────────────────────────────

const BILL_TAGGED_CONFIRMED_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const BILL_TAGGED_PENDING_ID = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const BILL_TAGGED_DECLINED_ID = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";

describe("createEventFromAgreement — the bill flows into the event (FR-006)", () => {
  /** SELF (human sender), confirmed / pending / declined tags, free text. */
  async function mixedBill(sender: { ownerType: "human" | "organization"; ownerId: string } = {
    ownerType: "human",
    ownerId: PERFORMER_ID,
  }) {
    const acts = createFakeBookingRequestActs({ senderOf: () => sender });
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: BILL_TAGGED_PENDING_ID, sortOrder: 1 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: BILL_TAGGED_CONFIRMED_ID, sortOrder: 2, role: "DJ" },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: BILL_TAGGED_DECLINED_ID, sortOrder: 3 },
      {
        source: "EXTERNAL",
        externalName: "The Weeds",
        externalUrl: "https://theweeds.example",
        sortOrder: 4,
      },
    ]);
    const answer = (actOwnerId: string, to: "CONFIRMED" | "DECLINED") =>
      acts.setActConfirmation({
        bookingRequestId: REQUEST_ID,
        actOwnerType: "human",
        actOwnerId,
        expectedFrom: "PENDING",
        to,
        respondedAt: new Date("2026-06-05T00:00:00.000Z"),
      });
    await answer(BILL_TAGGED_CONFIRMED_ID, "CONFIRMED");
    await answer(BILL_TAGGED_DECLINED_ID, "DECLINED");
    return acts;
  }

  it("attaches exactly SELF + the confirmed tag + free text, in bill order, numbered 0..n-1", async () => {
    const acts = await mixedBill();
    const { deps, eventHumans, audit } = buildDeps({ acts });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach.mock.calls.map(([row]) => row)).toEqual([
      {
        eventId: NEW_EVENT_ID,
        humanId: PERFORMER_ID,
        orgId: null,
        // SELF maps exactly as the pre-bill headliner did: the stage name rides along.
        externalName: "The Fake Band",
        externalUrl: null,
        role: "PERFORMER",
        customRoleLabel: null,
        sortOrder: 0,
      },
      {
        eventId: NEW_EVENT_ID,
        humanId: BILL_TAGGED_CONFIRMED_ID,
        orgId: null,
        externalName: null,
        externalUrl: null,
        role: "DJ",
        customRoleLabel: null,
        sortOrder: 1,
      },
      {
        eventId: NEW_EVENT_ID,
        humanId: null,
        orgId: null,
        externalName: "The Weeds",
        externalUrl: "https://theweeds.example",
        role: "PERFORMER",
        customRoleLabel: null,
        sortOrder: 2,
      },
    ]);
    // Neither the pending nor the declined artist is on the event.
    const attachedHumans = eventHumans.attach.mock.calls.map(([row]) => row.humanId);
    expect(attachedHumans).not.toContain(BILL_TAGGED_PENDING_ID);
    expect(attachedHumans).not.toContain(BILL_TAGGED_DECLINED_ID);

    // One attach audit per row, and the mint audit says what happened.
    const attachedAudits = audit.log.mock.calls.filter(
      ([entry]) => (entry as { entity: string }).entity === "event_human",
    );
    expect(attachedAudits).toHaveLength(3);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({
          performerHumanId: PERFORMER_ID,
          lineup: { source: "bill", attached: 3, skippedPending: 1, skippedDeclined: 1 },
        }),
      }),
    );
  });

  it("reads the bill UNDER its lock, both on the TX bag (the root bag only for the title prefill)", async () => {
    const acts = await mixedBill();
    const { deps, eventHumans } = buildDeps({ acts });
    const order: string[] = [];
    type BillSlice = {
      lockBill: (id: string) => Promise<void>;
      listActsForRequests: (ids: readonly string[]) => Promise<unknown>;
    };
    const root = deps.repos.bookingRequests as unknown as BillSlice;
    // The root bag's lock is never touched by the mint. Its bill READ is
    // the title prefill only (v3 L20, before the event is saved) — it
    // returns NOTHING here, so if the lineup were planned off it, nothing
    // would be attached.
    root.lockBill = vi.fn(async () => {
      order.push("root:lockBill");
    });
    root.listActsForRequests = vi.fn(async () => {
      order.push("root:listActsForRequests");
      return [];
    });
    // Every transaction gets a DISTINCT bag whose bill methods are recorded.
    const txBookingRequests = {
      ...(deps.repos.bookingRequests as object),
      lockBill: vi.fn(async (id: string) => {
        order.push(`tx:lockBill:${id}`);
      }),
      listActsForRequests: vi.fn(async (ids: readonly string[]) => {
        order.push("tx:listActsForRequests");
        return acts.listActsForRequests(ids);
      }),
    };
    const txBag = { ...deps.repos, bookingRequests: txBookingRequests };
    deps.repos = {
      ...deps.repos,
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txBag)),
    } as unknown as CreateEventFromAgreementDeps["repos"];

    await createEventFromAgreement(deps, baseInput);

    expect(order).toEqual([
      // The title prefill, BEFORE the transaction (and the save) begins.
      "root:listActsForRequests",
      `tx:lockBill:${REQUEST_ID}`,
      "tx:listActsForRequests",
    ]);
    // …and the bill it read under the lock is what flowed.
    expect(eventHumans.attach).toHaveBeenCalledTimes(3);
  });

  const orgRequest = () =>
    buildRequest({
      performerOwnerType: "organization",
      performerOwnerId: PERFORMER_ORG_ID,
      actName: null,
    });
  const orgSelfBill = async () => {
    const acts = createFakeBookingRequestActs({
      senderOf: () => ({ ownerType: "organization", ownerId: PERFORMER_ORG_ID }),
    });
    await acts.addActs(REQUEST_ID, [{ source: "SELF", sortOrder: 0 }]);
    return acts;
  };

  it("an ORG sender's SELF row is the org as free text WITH its public page as an absolute externalUrl", async () => {
    const { deps, eventHumans } = buildDeps({
      acts: await orgSelfBill(),
      orgName: "Band Org",
      request: orgRequest(),
      publicAppUrl: "https://ithasfire.test/",
      orgPages: { [PERFORMER_ORG_ID]: { slug: "band-org", visibility: "PUBLIC" } },
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledTimes(1);
    expect(eventHumans.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: null,
        externalName: "Band Org",
        // Absolute, http(s), trailing slash on the base normalized away.
        externalUrl: "https://ithasfire.test/orgs/band-org",
        sortOrder: 0,
      }),
    );
  });

  it("no PUBLIC org page, or no base URL → the org SELF row has no link", async () => {
    for (const options of [
      { publicAppUrl: "https://ithasfire.test", orgPages: { [PERFORMER_ORG_ID]: { slug: "band-org", visibility: "PRIVATE" as const } } },
      { orgPages: { [PERFORMER_ORG_ID]: { slug: "band-org", visibility: "PUBLIC" as const } } },
    ]) {
      const { deps, eventHumans } = buildDeps({
        acts: await orgSelfBill(),
        orgName: "Band Org",
        request: orgRequest(),
        ...options,
      });
      await createEventFromAgreement(deps, baseInput);
      expect(eventHumans.attach).toHaveBeenCalledWith(
        expect.objectContaining({ externalName: "Band Org", externalUrl: null }),
      );
    }
  });

  it("a LEGACY org request keeps today's headliner exactly — no link, even with a public page", async () => {
    const { deps, eventHumans } = buildDeps({
      acts: createFakeBookingRequestActs(),
      orgName: "Band Org",
      request: orgRequest(),
      publicAppUrl: "https://ithasfire.test",
      orgPages: { [PERFORMER_ORG_ID]: { slug: "band-org", visibility: "PUBLIC" } },
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: null, externalName: "Band Org", externalUrl: null }),
    );
  });

  it("a bill with nothing confirmed attaches nothing (consent carries through)", async () => {
    const acts = createFakeBookingRequestActs();
    await acts.addActs(REQUEST_ID, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: BILL_TAGGED_PENDING_ID, sortOrder: 0 },
    ]);
    const { deps, eventHumans } = buildDeps({ acts });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(eventHumans.attach).not.toHaveBeenCalled();
  });

  it("a legacy request (no act rows) attaches exactly the pre-bill headliner", async () => {
    const { deps, eventHumans, audit } = buildDeps({ acts: createFakeBookingRequestActs() });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledTimes(1);
    expect(eventHumans.attach).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      humanId: PERFORMER_ID,
      orgId: null,
      externalName: "The Fake Band",
      externalUrl: null,
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 0,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({
          lineup: { source: "legacy", attached: 1, skippedPending: 0, skippedDeclined: 0 },
        }),
      }),
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Lineup v3 at the mint (FR-006, FR-015, L12, L13, L18, L20)
// ─────────────────────────────────────────────────────────────────────────────

describe("createEventFromAgreement — lineup v3: groups, labels, empty bills, the title", () => {
  const GROUP_ID = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
  const JOINED_HUMAN_ID = "b1b1b1b1-0000-4000-8000-000000000001";
  const INVITED_HUMAN_ID = "b1b1b1b1-0000-4000-8000-000000000002";
  const PASSED_HUMAN_ID = "b1b1b1b1-0000-4000-8000-000000000003";
  const GROUP_EDITOR_ID = "b1b1b1b1-0000-4000-8000-000000000004";
  const APP_URL = "https://ithasfire.test";

  const NAMES: Record<string, string> = {
    [JOINED_HUMAN_ID]: "Della Wire",
    [INVITED_HUMAN_ID]: "Invited Ivy",
    [PASSED_HUMAN_ID]: "Passed Paz",
    [GROUP_ID]: "Paper Moth",
  };

  /**
   * The identity reads the v3 mint adds (group names in-tx, the title's
   * joined act): batched human / org / page lookups over the same bag.
   */
  function withIdentityReads(deps: CreateEventFromAgreementDeps) {
    const repos = deps.repos as unknown as Record<string, Record<string, unknown>>;
    repos.humans!.getByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: NAMES[id] ?? "Someone", status: "ACTIVE" })),
    );
    repos.organizations!.getByIds = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: NAMES[id] ?? "Org", status: "ACTIVE" })),
    );
    repos.entityPages!.getByOwners = vi.fn(async (ownerType: string, ids: string[]) =>
      ownerType === "ORGANIZATION" && ids.includes(GROUP_ID)
        ? [
            {
              id: "page-moth",
              ownerType,
              ownerId: GROUP_ID,
              slug: "paper-moth",
              displayName: null,
              visibility: "PUBLIC",
            },
          ]
        : [],
    );
  }

  const senderActs = (ownerType: "human" | "organization" = "human") =>
    createFakeBookingRequestActs({
      senderOf: (id) =>
        id === REQUEST_ID
          ? { ownerType, ownerId: ownerType === "human" ? PERFORMER_ID : PERFORMER_ORG_ID }
          : undefined,
    });

  const answer = (
    acts: FakeBookingRequestActs,
    owner: { actOwnerType: "human" | "organization"; actOwnerId: string },
    to: "CONFIRMED" | "DECLINED",
  ) =>
    acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      ...owner,
      expectedFrom: "PENDING",
      to,
      respondedAt: new Date("2026-06-05T00:00:00.000Z"),
    });

  it("a JOINED tagged group lands as { orgId } with its role + label and its name/page as the fallback display; an invited group does not", async () => {
    const acts = senderActs();
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      {
        source: "TAGGED",
        actOwnerType: "organization",
        actOwnerId: GROUP_ID,
        sortOrder: 1,
        role: "OTHER",
        customRoleLabel: "Backing band",
      },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: INVITED_HUMAN_ID, sortOrder: 2 },
    ]);
    await answer(acts, { actOwnerType: "organization", actOwnerId: GROUP_ID }, "CONFIRMED");
    const { deps, eventHumans } = buildDeps({ acts, publicAppUrl: APP_URL });
    withIdentityReads(deps);

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach.mock.calls.map(([row]) => row)).toEqual([
      expect.objectContaining({ humanId: PERFORMER_ID, orgId: null, sortOrder: 0 }),
      {
        eventId: NEW_EVENT_ID,
        humanId: null,
        orgId: GROUP_ID,
        externalName: "Paper Moth",
        externalUrl: `${APP_URL}/orgs/paper-moth`,
        role: "OTHER",
        customRoleLabel: "Backing band",
        sortOrder: 1,
      },
    ]);
    // Consent carries through (NFR-002): the invited act is a suggestion,
    // never a lineup row.
    const attached = eventHumans.attach.mock.calls.map(([row]) => row);
    expect(attached.map((row) => row.humanId)).not.toContain(INVITED_HUMAN_ID);
  });

  it("an ORG sender's SELF row lands as { orgId } — the group itself, not free text", async () => {
    const acts = senderActs("organization");
    await acts.addActs(REQUEST_ID, [{ source: "SELF", sortOrder: 0 }]);
    const { deps, eventHumans } = buildDeps({
      acts,
      request: buildRequest({
        performerOwnerType: "organization",
        performerOwnerId: PERFORMER_ORG_ID,
        actName: null,
      }),
      publicAppUrl: APP_URL,
      orgPages: { [PERFORMER_ORG_ID]: { slug: "band-org", visibility: "PUBLIC" } },
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledTimes(1);
    expect(eventHumans.attach).toHaveBeenCalledWith({
      eventId: NEW_EVENT_ID,
      humanId: null,
      orgId: PERFORMER_ORG_ID,
      externalName: "Band Org",
      externalUrl: `${APP_URL}/orgs/band-org`,
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 0,
    });
  });

  it("a bill whose acts were ALL removed mints an EMPTY lineup — never the pre-bill headliner", async () => {
    const acts = senderActs();
    const [self, other] = await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "EXTERNAL", externalName: "Junco", sortOrder: 1 },
    ]);
    const at = new Date("2026-06-06T00:00:00.000Z");
    await acts.softRemoveAct({ bookingRequestId: REQUEST_ID, actId: self!.id, at });
    await acts.softRemoveAct({ bookingRequestId: REQUEST_ID, actId: other!.id, at });
    const { deps, eventHumans, audit } = buildDeps({ acts });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(eventHumans.attach).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({
          lineup: { source: "bill", attached: 0, skippedPending: 0, skippedDeclined: 0 },
        }),
      }),
    );
  });

  it("an EMPTY v3 bill (L12: `billRecorded`, no act rows at all) mints an EMPTY lineup — never the pre-bill headliner", async () => {
    const { deps, eventHumans, events, audit } = buildDeps({
      acts: senderActs(),
      request: buildRequest({ billRecorded: true, actName: null }),
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_agreement.event_created",
        data: expect.objectContaining({
          lineup: { source: "bill", attached: 0, skippedPending: 0, skippedDeclined: 0 },
        }),
      }),
    );
    // L20 with no act at all: the sender's name.
    const title = (events.upsertDraft.mock.calls[0]![0] as { title: string }).title;
    expect(title).toBe("Perry Former at Test Venue");
  });

  it("the SAME zero rows WITHOUT `billRecorded` (sent before bills) keeps the pre-bill headliner", async () => {
    const { deps, eventHumans } = buildDeps({
      acts: senderActs(),
      request: buildRequest({ billRecorded: false }),
    });

    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach).toHaveBeenCalledTimes(1);
    expect(eventHumans.attach).toHaveBeenCalledWith(
      expect.objectContaining({ humanId: PERFORMER_ID, externalName: "The Fake Band", sortOrder: 0 }),
    );
  });

  it("L20: the title names the FIRST act that JOINED — skipping an invited act ahead of it", async () => {
    const acts = senderActs();
    await acts.addActs(REQUEST_ID, [
      // No SELF: a promoter's bill.
      { source: "TAGGED", actOwnerType: "human", actOwnerId: INVITED_HUMAN_ID, sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: PASSED_HUMAN_ID, sortOrder: 1 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: JOINED_HUMAN_ID, sortOrder: 2 },
      { source: "EXTERNAL", externalName: "Junco", sortOrder: 3 },
    ]);
    await answer(acts, { actOwnerType: "human", actOwnerId: PASSED_HUMAN_ID }, "DECLINED");
    await answer(acts, { actOwnerType: "human", actOwnerId: JOINED_HUMAN_ID }, "CONFIRMED");
    const { deps, events } = buildDeps({ acts, request: buildRequest({ actName: "Junco" }) });
    withIdentityReads(deps);

    await createEventFromAgreement(deps, baseInput);

    const title = (events.upsertDraft.mock.calls[0]![0] as { title: string }).title;
    expect(title).toBe("Della Wire at Test Venue");
    expect(title).not.toContain("Invited Ivy");
    expect(title).not.toContain("Passed Paz");
  });

  it("L20: with NO act joined, the title falls back to the SENDER's name — never an invited act, never a stale actName", async () => {
    const acts = senderActs();
    await acts.addActs(REQUEST_ID, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: INVITED_HUMAN_ID, sortOrder: 0 },
    ]);
    const { deps, events } = buildDeps({ acts, request: buildRequest({ actName: "Old Act Name" }) });
    withIdentityReads(deps);

    await createEventFromAgreement(deps, baseInput);

    const title = (events.upsertDraft.mock.calls[0]![0] as { title: string }).title;
    // humans.getById → "Perry Former" is the sender.
    expect(title).toBe("Perry Former at Test Venue");
  });

  it("END TO END: a band is tagged at create → an editor of the band joins AS the band → the mint attaches the band { orgId }", async () => {
    const acts = senderActs();
    const actMethods = {
      addActs: acts.addActs,
      listActsForRequests: acts.listActsForRequests,
      getActForOwner: acts.getActForOwner,
      setActConfirmation: acts.setActConfirmation,
      lockBill: acts.lockBill,
      promoteActToSelf: acts.promoteActToSelf,
      softRemoveAct: acts.softRemoveAct,
      restoreAct: acts.restoreAct,
      setActSortOrders: acts.setActSortOrders,
      setActRole: acts.setActRole,
    };
    const orgsRepo = {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: NAMES[id] ?? "Org", status: "ACTIVE" })),
      ),
    };
    const pagesRepo = {
      getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
        ids
          .filter((id) => id === INVITED_HUMAN_ID || (ownerType === "ORGANIZATION" && id === GROUP_ID))
          .map((id) => ({
            id: `page-${id}`,
            ownerType,
            ownerId: id,
            slug: id === GROUP_ID ? "paper-moth" : "invited-ivy",
            displayName: null,
            visibility: "PUBLIC",
          })),
      ),
      getByOwner: vi.fn(async () => null),
    };
    const humansRepo = {
      getById: vi.fn(async (id: string) => ({ id, genreTags: [], name: "Perry Former" })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: NAMES[id] ?? "Perry Former", status: "ACTIVE" })),
      ),
    };

    // 1. The sender tags the band (role OTHER, labelled) and a person.
    const createDeps: CreateBookingRequestDeps = {
      repos: withRequestTx({
        bookingRequests: {
          findOpenByPerformerAndPlace: vi.fn(async () => null),
          countOpenParkedForSender: vi.fn(async () => 0),
          create: vi.fn(async () => buildRequest({ status: "PENDING", agreementId: null })),
          ...actMethods,
        },
        performerProfiles: { getByOwner: vi.fn(async () => buildPerformerProfile()) },
        places: { getById: vi.fn(async () => buildRequestPlaceRecord()) },
        humans: humansRepo,
        entityPages: pagesRepo,
        organizations: orgsRepo,
        authz: { getOrgMembership: vi.fn(async () => null) },
        audit: { log: vi.fn(async () => {}) },
        humanStats: { findByHumanId: vi.fn(async () => null) },
        events: {
          listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
          listPublishedOccurrencesByPlace: vi.fn(async () => []),
        },
        calendars: {
          listByPlace: vi.fn(async () => []),
          listAvailabilityForPlace: vi.fn(async () => []),
          countAvailabilityForPlace: vi.fn(async () => 1),
        },
      }) as unknown as CreateBookingRequestDeps["repos"],
      clock: { now: () => new Date("2026-06-01T00:00:00.000Z") },
    };
    await createBookingRequest(createDeps, {
      actorHumanId: PERFORMER_ID,
      performerOwnerType: "human",
      performerOwnerId: PERFORMER_ID,
      placeId: PLACE_ID,
      message: "Three acts, one night.",
      preferredDates: ["2026-07-10"],
      bill: {
        includeSelf: true,
        acts: [
          { kind: "tagged", orgId: GROUP_ID, role: "OTHER", customRoleLabel: "Backing band" },
          { kind: "tagged", humanId: INVITED_HUMAN_ID },
        ],
      },
    });

    // 2. An editor of the band joins AS the band.
    const answerDeps = {
      repos: withRequestTx({
        bookingRequests: {
          getById: vi.fn(async () => buildRequest({ status: "ACCEPTED" })),
          ...actMethods,
        },
        authz: {
          getOrgMemberships: vi.fn(async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
            humanId === GROUP_EDITOR_ID && orgIds.includes(GROUP_ID)
              ? [{ orgId: GROUP_ID, humanId, role: "EDITOR" }]
              : [],
          ),
        },
        humans: humansRepo,
        organizations: orgsRepo,
        entityPages: pagesRepo,
        agreements: { getById: vi.fn(async () => null) },
        events: { getById: vi.fn(async () => null) },
        eventHumans: { listByEvent: vi.fn(async () => []) },
        audit: { log: vi.fn(async () => {}) },
      }) as unknown as AnswerBookingRequestActDeps["repos"],
      clock: { now: () => new Date("2026-06-03T00:00:00.000Z") },
    } satisfies AnswerBookingRequestActDeps;
    await expect(
      joinBookingRequestAct(answerDeps, {
        actorHumanId: GROUP_EDITOR_ID,
        bookingRequestId: REQUEST_ID,
        asOrgId: GROUP_ID,
      }),
    ).resolves.toMatchObject({ confirmation: "CONFIRMED", changed: true });

    // The create recorded a bill (v3 L12).
    expect(createDeps.repos.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ billRecorded: true }),
    );

    // 3. The terms are agreed and the event is minted.
    const { deps, eventHumans } = buildDeps({
      acts,
      request: buildRequest({ billRecorded: true }),
      publicAppUrl: APP_URL,
    });
    withIdentityReads(deps);
    await createEventFromAgreement(deps, baseInput);

    expect(eventHumans.attach.mock.calls.map(([row]) => row)).toEqual([
      expect.objectContaining({ humanId: PERFORMER_ID, orgId: null, sortOrder: 0 }),
      expect.objectContaining({
        humanId: null,
        orgId: GROUP_ID,
        role: "OTHER",
        customRoleLabel: "Backing band",
        sortOrder: 1,
      }),
    ]);
    // The person who never answered stays a suggestion.
    expect(
      eventHumans.attach.mock.calls.map(([row]) => row.humanId),
    ).not.toContain(INVITED_HUMAN_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night: the agree-mint placement (FR-001) and the event-first
// link (N11).
// ─────────────────────────────────────────────────────────────────────────────

describe("createEventFromAgreementOnNight (booking-the-night FR-001)", () => {
  const NIGHT_CALENDAR_ID = "ca1e0da1-5555-4555-8555-555555555555";
  const NIGHT_SPACE_ID = "0000f00d-6666-4666-8666-666666666666";
  /** The agreed instant: 21:30 CDT on 2026-10-13. */
  const AGREED_AT = new Date("2026-10-14T02:30:00.000Z");

  const nightCalendars = () => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [
            {
              id: NIGHT_CALENDAR_ID,
              placeId: PLACE_ID,
              name: "Back Room",
              slug: "back-room",
              description: null,
              isDefault: false,
              defaultStartTime: "20:00",
              defaultCategoryId: null,
              eventTemplate: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              spaces: [
                { id: NIGHT_SPACE_ID, placeId: PLACE_ID, name: "Back", capacity: null, sortOrder: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() },
              ],
            },
          ]
        : [],
    ),
  });

  it("is the public path (ACCEPTED, the agreed instant, finalize attempted) placed on the BOOKED night's calendar", async () => {
    const { deps, events, agreements, payoutTerms } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT }),
      calendars: nightCalendars(),
      // The request routes nowhere: only the night says where.
      request: buildRequest({ calendarId: null }),
    });

    const result = await createEventFromAgreementOnNight(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
      night: { calendarId: NIGHT_CALENDAR_ID, spaceId: null, date: "2026-10-13" },
    });

    expect(result).toMatchObject({ eventId: NEW_EVENT_ID, alreadyLinked: false });
    const draft = events.upsertDraft.mock.calls[0]![0]!;
    expect(draft.startsAt.toISOString()).toBe(AGREED_AT.toISOString());
    expect(events.setVenuePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: NEW_EVENT_ID, calendarId: NIGHT_CALENDAR_ID, spaceId: NIGHT_SPACE_ID }),
    );
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    // Terms are agreed, so the finalize is attempted (unlike the hold variant).
    expect(payoutTerms.listLines).toHaveBeenCalled();
  });

  it("refuses terms that are not ACCEPTED (it is the public gate)", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "PROPOSED", proposedDate: AGREED_AT }),
      calendars: nightCalendars(),
    });

    await expect(
      createEventFromAgreementOnNight(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
        night: { calendarId: NIGHT_CALENDAR_ID, spaceId: null, date: "2026-10-13" },
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_ACCEPTED" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("idempotent on the draft anchor, so the venue's \"Create event\" is the retry", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT }),
      calendars: nightCalendars(),
    });
    const args = {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
      night: { calendarId: NIGHT_CALENDAR_ID, spaceId: null, date: "2026-10-13" },
    };

    const first = await createEventFromAgreementOnNight(deps, args);
    const retry = await createEventFromAgreement(deps, baseInput);

    expect(retry).toMatchObject({ eventId: first.eventId, alreadyLinked: true });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });
});

describe("createEventFromAgreement — event-first requests link, never mint (booking-the-night N11)", () => {
  const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

  function eventFirst(originStatus = "DRAFT") {
    const built = buildDeps({ request: buildRequest({ originEventId: ORIGIN_ID }) });
    const realGetById = built.events.getById.getMockImplementation()!;
    built.events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID
        ? { id: ORIGIN_ID, status: originStatus, startsAt: new Date("2026-07-11T01:00:00.000Z") }
        : realGetById(id),
    );
    return built;
  }

  it("anchors the ORIGIN event as the draft, hands it back, mints nothing, and defers finalize to its owner", async () => {
    const { deps, events, agreements, audit } = eventFirst();

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: ORIGIN_ID,
      alreadyLinked: true,
      finalized: false,
      finalizeBlocked: "requester_owned",
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
    expect(agreements.repo.setDraftEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGREEMENT_ID, draftEventId: ORIGIN_ID, expectedFrom: ["ACCEPTED"] }),
    );
    expect(agreements.record()?.draftEventId).toBe(ORIGIN_ID);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_agreement.event_linked", data: expect.objectContaining({ eventId: ORIGIN_ID }) }),
    );
    // No "event created" on the thread — nothing was created.
    expect(systemEntriesFor(deps.repos, REQUEST_ID)).toEqual([]);
  });

  it("a second call (the venue's \"Create event\") returns the same event and writes nothing", async () => {
    const { deps, events, agreements } = eventFirst();
    await createEventFromAgreement(deps, baseInput);
    agreements.repo.setDraftEvent.mockClear();

    const again = await createEventFromAgreement(deps, baseInput);

    expect(again.eventId).toBe(ORIGIN_ID);
    expect(agreements.repo.setDraftEvent).not.toHaveBeenCalled();
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("a CANCELLED origin is refused rather than replaced by a fresh mint", async () => {
    const { deps, events } = eventFirst("CANCELLED");

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "event_first_origin_not_live",
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("the hold variant links too (book without terms on an event-first request)", async () => {
    const { deps, events, agreements } = eventFirst();
    agreements.set({ ...agreements.record()!, status: "DRAFT" });

    const result = await createEventFromAgreementForHold(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
      hold: {
        id: "0b01d000-1111-4111-8111-111111111111",
        calendarId: DEFAULT_CALENDAR_ID,
        spaceId: null,
        date: "2026-07-10",
        startsAt: new Date("2026-07-11T01:00:00.000Z"),
        endsAt: null,
      },
    });

    expect(result.eventId).toBe(ORIGIN_ID);
    expect(events.upsertDraft).not.toHaveBeenCalled();
    expect(agreements.repo.setDraftEvent).toHaveBeenCalledWith(
      expect.objectContaining({ draftEventId: ORIGIN_ID, expectedFrom: expect.arrayContaining(["DRAFT"]) }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night review: the manual "Create event" guards its night
// (W1, NFR-001), sits on this request's booked hold (W2), and the agree-mint
// never hands back a draft on another night (B1c).
// ─────────────────────────────────────────────────────────────────────────────

describe("createEventFromAgreement — the manual mint's night (booking-the-night review W1 / W2)", () => {
  const MAIN_ID = "ca1e0da1-7777-4777-8777-777777777777";
  const PATIO_ID = "ca1e0da1-8888-4888-8888-888888888888";
  const MAIN_SPACE = "0000f00d-7777-4777-8777-777777777777";
  const PATIO_SPACE = "0000f00d-8888-4888-8888-888888888888";
  const OTHER_REQUEST = "45454545-4545-4545-8545-454545454545";
  /** The first preferred date — the night the manual mint falls back to. */
  const NIGHT = "2026-07-10";

  const space = (id: string) => ({ id, placeId: PLACE_ID, name: id, capacity: null, sortOrder: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() });
  const calendar = (id: string, isDefault: boolean, spaceId: string) => ({
    id, placeId: PLACE_ID, name: id, slug: id, description: null, isDefault,
    defaultStartTime: null, defaultCategoryId: null, eventTemplate: null,
    createdAt: new Date(), updatedAt: new Date(), spaces: [space(spaceId)],
  });
  const twoCalendars = () => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID ? [calendar(MAIN_ID, true, MAIN_SPACE), calendar(PATIO_ID, false, PATIO_SPACE)] : [],
    ),
  });
  const holdsOf = (deps: ReturnType<typeof buildDeps>["deps"]) =>
    deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo;

  // Date-less (legacy) terms: this read-only check runs under the line lock
  // but RELEASES it before the save — it is not the guarantee. The mint's
  // anchor transaction re-checks under the lock (W3, pinned in the round-3
  // describe below); between the two a booking can still land, which is
  // refused there and leaves the saved draft unanchored (reported).
  it("date-less terms: another request's CONFIRMED hold on the night's line → NIGHT_TAKEN (venue side, booked) from the pre-save check, read under the line lock; nothing minted", async () => {
    const { deps, events } = buildDeps({
      calendars: twoCalendars(),
      request: buildRequest({ calendarId: MAIN_ID }),
    });
    const theirs = holdsOf(deps).seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT, status: "CONFIRMED" });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: NIGHT, booked: true, aheadHoldId: null, position: theirs.position },
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
    const lockAt = vi.mocked(holdsOf(deps).lockLine).mock.invocationCallOrder[0]!;
    expect(vi.mocked(holdsOf(deps).lockLine)).toHaveBeenCalledWith({ calendarId: MAIN_ID, date: NIGHT });
    for (const at of vi.mocked(holdsOf(deps).listLine).mock.invocationCallOrder) expect(lockAt).toBeLessThan(at);
  });

  it("another party's CONFIRMED hold on a DIFFERENT room's line the same day does not block (lines are per calendar)", async () => {
    const { deps, events } = buildDeps({
      calendars: twoCalendars(),
      request: buildRequest({ calendarId: MAIN_ID }),
    });
    holdsOf(deps).seed({ bookingRequestId: OTHER_REQUEST, calendarId: PATIO_ID, date: NIGHT, status: "CONFIRMED" });

    await createEventFromAgreement(deps, baseInput);
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  // Review round 4 nit 4: date-less terms name no day, so the BOOKED night
  // stands — the event mints on it, never on the pitch's first preferred
  // date (2026-07-10 here).
  it("date-less terms and a request that booked ANOTHER night than its first preferred date → the booked night stands: the event mints on it", async () => {
    const { deps, events } = buildDeps({ calendars: twoCalendars() });
    holdsOf(deps).seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    await createEventFromAgreement(deps, baseInput);

    const draft = events.upsertDraft.mock.calls[0]![0]!;
    // 19:00 CDT on the booked night (no calendar default start).
    expect(draft.startsAt.toISOString()).toBe("2026-07-18T00:00:00.000Z");
    expect(events.setVenuePlacement).toHaveBeenCalledWith(expect.objectContaining({ calendarId: MAIN_ID }));
  });

  it("AGREED terms for another day than the booked night → BOOKING_ALREADY_HAS_NIGHT, even with an override on the booked day (the override never masks the terms' day)", async () => {
    const { deps, events } = buildDeps({
      calendars: twoCalendars(),
      // Agreed: 20:00 CDT on 2026-07-10.
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: new Date("2026-07-11T01:00:00.000Z") }),
    });
    holdsOf(deps).seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    await expect(
      createEventFromAgreement(deps, {
        ...baseInput,
        overrides: { startsAt: "2026-07-18T02:00:00.000Z" }, // 21:00 CDT on the booked night
      }),
    ).rejects.toMatchObject({ code: "BOOKING_ALREADY_HAS_NIGHT" });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("W2: the request is routed to Main but its BOOKED hold is on Patio → the event goes on Patio's calendar and room", async () => {
    const { deps, events } = buildDeps({
      calendars: twoCalendars(),
      request: buildRequest({ calendarId: MAIN_ID }),
    });
    holdsOf(deps).seed({
      bookingRequestId: REQUEST_ID,
      calendarId: PATIO_ID,
      spaceId: PATIO_SPACE,
      date: NIGHT,
      status: "CONFIRMED",
    });

    await createEventFromAgreement(deps, baseInput);

    expect(events.setVenuePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: PATIO_ID, spaceId: PATIO_SPACE }),
    );
  });

  // Review B1c / W1: the night is settled BEFORE the draft short-circuit and
  // the event-first link — a live draft is no longer handed back blindly.
  const UNFINALIZED = {
    // A pending payee line blocks finalize, so the first call leaves a DRAFT
    // anchor (a finalized link would be handed back before any night check).
    lines: [buildLineRecord({ payeeId: THIRD_PARTY_PAYEE_ID, confirmationStatus: "PENDING" }), PARTY_LINE],
  };

  it("a live draft is NOT handed back once another party has booked its night (date-less terms: the line is checked first)", async () => {
    const { deps, events, agreements } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput);
    expect(agreements.record()).toMatchObject({ draftEventId: NEW_EVENT_ID, eventId: null });
    holdsOf(deps).seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT, status: "CONFIRMED" });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: NIGHT, booked: true },
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  // Review round 6 BLOCKING: date-less terms name no night, and with nothing
  // booked the fallback day is NOT a night a draft must sit on — a draft the
  // venue moved stays the request's event, and finalize is re-attempted.
  it("date-less ACCEPTED terms, no holds, a live draft the venue MOVED off the first preferred date → handed back (alreadyLinked) and finalize re-attempted", async () => {
    vi.useFakeTimers();
    const { deps, events, agreements, payoutTerms } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput); // draft on NIGHT (2026-07-10), finalize blocked
    expect(agreements.record()).toMatchObject({ draftEventId: NEW_EVENT_ID, eventId: null });
    vi.advanceTimersByTime(1_100); // finalize's deterministic-failure marker lapses
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) => {
      const row = await real(id);
      // The venue moved the draft to 2026-07-17 (20:00 CDT).
      return id === NEW_EVENT_ID && row ? ({ ...row, startsAt: new Date("2026-07-18T01:00:00.000Z") } as never) : row;
    });
    const listedBefore = payoutTerms.listLines.mock.calls.length;

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toEqual({
      eventId: NEW_EVENT_ID,
      alreadyLinked: true,
      finalized: false,
      finalizeBlocked: "lines_unconfirmed",
    });
    expect(payoutTerms.listLines.mock.calls.length).toBeGreaterThan(listedBefore); // finalize ran again
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    expect([...holdsOf(deps).rows.values()]).toEqual([]);
  });

  // P2b review carry a (P2c): with date-less terms the pre-save guard runs
  // only when the plan SAVES. A draft it hands back is guarded on its OWN
  // line — the fallback day only anchors a fresh save.
  const moveDraft = (
    events: ReturnType<typeof buildDeps>["events"],
    over: Record<string, unknown>,
  ) => {
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) => {
      const row = await real(id);
      return id === NEW_EVENT_ID && row ? ({ ...row, ...over } as never) : row;
    });
  };
  /** 20:00 CDT on 2026-07-17 — a week after the fallback day. */
  const MOVED_AT = new Date("2026-07-18T01:00:00.000Z");

  it("carry a: a MOVED draft is handed back even though ANOTHER request booked the fallback day — the fallback line is not checked", async () => {
    vi.useFakeTimers();
    const { deps, events } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput); // draft on NIGHT (2026-07-10)
    vi.advanceTimersByTime(1_100);
    moveDraft(events, { startsAt: MOVED_AT });
    holdsOf(deps).seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT, status: "CONFIRMED" });
    vi.mocked(holdsOf(deps).lockLine).mockClear();

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toMatchObject({ eventId: NEW_EVENT_ID, alreadyLinked: true });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    // The draft's OWN line (routing: Main, the moved day) — never the fallback day's.
    expect(vi.mocked(holdsOf(deps).lockLine).mock.calls).toEqual([
      [{ calendarId: MAIN_ID, date: "2026-07-17" }],
    ]);
  });

  it("carry a: a MOVED draft whose OWN day another request booked → NIGHT_TAKEN (its line, under its lock)", async () => {
    vi.useFakeTimers();
    const { deps, events } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput);
    vi.advanceTimersByTime(1_100);
    moveDraft(events, { startsAt: MOVED_AT });
    holdsOf(deps).seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: "2026-07-17", booked: true },
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("carry a: the handed-back draft's own CALENDAR wins over the request's routing — a booking on Main that day does not block a draft on Patio", async () => {
    vi.useFakeTimers();
    const { deps, events } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput);
    vi.advanceTimersByTime(1_100);
    moveDraft(events, { startsAt: MOVED_AT, calendarId: PATIO_ID });
    holdsOf(deps).seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toMatchObject({ eventId: NEW_EVENT_ID, alreadyLinked: true });
    expect(vi.mocked(holdsOf(deps).lockLine)).toHaveBeenLastCalledWith({
      calendarId: PATIO_ID,
      date: "2026-07-17",
    });
  });

  it("date-less terms, no holds: an override on ANOTHER day than the live draft is no night check either — the draft is handed back", async () => {
    vi.useFakeTimers();
    const { deps, events } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput); // draft on 2026-07-10
    vi.advanceTimersByTime(1_100);

    const result = await createEventFromAgreement(deps, {
      ...baseInput,
      overrides: { startsAt: "2026-07-21T01:00:00.000Z" }, // 2026-07-20 CDT
    });

    expect(result).toMatchObject({ eventId: NEW_EVENT_ID, alreadyLinked: true });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("the manual retry of an OFF-NIGHT draft is refused: the request booked another night than the draft's", async () => {
    const { deps, events, agreements } = buildDeps({ calendars: twoCalendars(), ...UNFINALIZED });
    await createEventFromAgreement(deps, baseInput); // draft on NIGHT (date-less terms)
    expect(agreements.record()?.draftEventId).toBe(NEW_EVENT_ID);
    // The request's booked night is elsewhere (e.g. booked without terms).
    // Date-less terms: the booked night is the night (nit 4), and the live
    // draft on another day is not handed back.
    holdsOf(deps).seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: NEW_EVENT_ID, eventDate: "2026-07-10", holdDate: "2026-07-17" },
    });
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  it("the manual retry of an OFF-NIGHT draft on AGREED terms: the booked night is the night, the draft on another day is refused HOLD_DATE_MISMATCHES_EVENT", async () => {
    // Agreed terms for 2026-07-17 (20:00 CDT), booked; a live draft from an
    // earlier mint sits on 2026-07-10.
    const DRAFT_ID = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e8";
    const { deps, events } = buildDeps({
      calendars: twoCalendars(),
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: new Date("2026-07-18T01:00:00.000Z"),
        draftEventId: DRAFT_ID,
      }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === DRAFT_ID
        ? { id: DRAFT_ID, status: "DRAFT", startsAt: new Date("2026-07-11T01:00:00.000Z") }
        : real(id),
    );
    holdsOf(deps).seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: DRAFT_ID, eventDate: "2026-07-10", holdDate: "2026-07-17" },
    });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("the manual retry of an event-first request whose ORIGIN event moved off the booked night is refused (no link)", async () => {
    const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    const { deps, events, agreements } = buildDeps({
      calendars: twoCalendars(),
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: new Date("2026-07-18T01:00:00.000Z") }),
      request: buildRequest({ originEventId: ORIGIN_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID
        ? { id: ORIGIN_ID, status: "DRAFT", startsAt: new Date("2026-07-19T01:00:00.000Z") } // 07-18
        : real(id),
    );
    holdsOf(deps).seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: "2026-07-17", status: "CONFIRMED" });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: ORIGIN_ID, eventDate: "2026-07-18", holdDate: "2026-07-17" },
    });
    expect(agreements.repo.setDraftEvent).not.toHaveBeenCalled();
  });
});

describe("createEventFromAgreement — the manual Create event BOOKS agreed terms' night (booking-the-night NFR-001, review W1)", () => {
  const MAIN_ID = "ca1e0da1-7777-4777-8777-777777777777";
  const PATIO_ID = "ca1e0da1-8888-4888-8888-888888888888";
  const OTHER_REQUEST = "45454545-4545-4545-8545-454545454545";
  /** Agreed: 20:00 CDT on 2026-07-17. */
  const AGREED_AT = new Date("2026-07-18T01:00:00.000Z");
  const NIGHT = "2026-07-17";

  const space = (id: string) => ({ id, placeId: PLACE_ID, name: id, capacity: null, sortOrder: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() });
  const calendar = (id: string, isDefault: boolean) => ({
    id, placeId: PLACE_ID, name: id, slug: id, description: null, isDefault,
    defaultStartTime: null, defaultCategoryId: null, eventTemplate: null,
    createdAt: new Date(), updatedAt: new Date(), spaces: [space(`${id.slice(0, 8)}-space`)],
  });
  const calendars = () => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID ? [calendar(MAIN_ID, true), calendar(PATIO_ID, false)] : [],
    ),
  });
  const agreed = (over: Record<string, unknown> = {}) =>
    buildDeps({
      calendars: calendars(),
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT }),
      ...over,
    });
  const holdsOf = (deps: ReturnType<typeof buildDeps>["deps"]) =>
    deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo;

  it("books the night FIRST: this request's hold CONFIRMED, the act behind loses the date, siblings go; then the event mints on that line; the notices ride the output", async () => {
    const { deps, events } = agreed();
    const holds = holdsOf(deps);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });
    const sibling = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: PATIO_ID, date: "2026-07-24" });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(holds.rows.get(mine.id)).toMatchObject({ status: "CONFIRMED" });
    expect(holds.rows.get(behind.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(holds.rows.get(sibling.id)).toMatchObject({ status: "RELEASED", releasedReason: "SIBLING_CONFIRMED" });
    // The line moved BEFORE anything was minted.
    const takeAt = vi.mocked(holds.updateStatus).mock.invocationCallOrder[0]!;
    expect(takeAt).toBeLessThan(events.upsertDraft.mock.invocationCallOrder[0]!);
    expect(events.setVenuePlacement).toHaveBeenCalledWith(expect.objectContaining({ calendarId: MAIN_ID }));
    // Ledger: the booked night (terms exist, so no `withoutTerms`), then the event.
    const kinds = systemEntriesFor(deps.repos, REQUEST_ID).map((e) => [e.systemKind, e.systemData]);
    expect(kinds).toContainEqual(["booking_hold.confirmed", { holdId: mine.id, eventId: null }]);
    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(result.notificationIntents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "hold.confirmed", holdId: mine.id, audience: "act" }),
        expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id, bookingRequestId: OTHER_REQUEST }),
      ]),
    );
    expect(result.staffRecipientHint).toMatchObject({ placeId: PLACE_ID });
  });

  it("no hold on the night → a CONFIRMED hold is written, placed by the VENUE actor", async () => {
    const { deps } = agreed();

    await createEventFromAgreement(deps, baseInput);

    const written = [...holdsOf(deps).rows.values()].find((h) => h.bookingRequestId === REQUEST_ID && h.date === NIGHT);
    expect(written).toMatchObject({ status: "CONFIRMED", calendarId: MAIN_ID, placedByHumanId: VENUE_ADMIN_ID });
  });

  it("another party AHEAD on the night → NIGHT_TAKEN in pre-flight: no transaction, nothing on the line, nothing minted", async () => {
    const { deps, events } = agreed();
    const holds = holdsOf(deps);
    const ahead = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: NIGHT, aheadHoldId: ahead.id, booked: false },
    });
    expect(holds.updateStatus).not.toHaveBeenCalled();
    expect(holds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("the booking's event (event-first origin) on another day → HOLD_DATE_MISMATCHES_EVENT before ANY line change", async () => {
    const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    const { deps, events, agreements } = agreed({ request: buildRequest({ originEventId: ORIGIN_ID }) });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID ? { id: ORIGIN_ID, status: "DRAFT", startsAt: new Date("2026-07-19T01:00:00.000Z") } : real(id),
    );
    const holds = holdsOf(deps);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: ORIGIN_ID, eventDate: "2026-07-18", holdDate: NIGHT },
    });
    expect(holds.updateStatus).not.toHaveBeenCalled();
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(agreements.repo.setDraftEvent).not.toHaveBeenCalled();
  });

  it("the mint fails AFTER the booking committed → the booking stands and the error carries the committed notices", async () => {
    const { deps, events } = agreed();
    const holds = holdsOf(deps);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });
    events.upsertDraft.mockRejectedValueOnce(new Error("save down"));

    const error = await createEventFromAgreement(deps, baseInput).catch((e: unknown) => e);

    // The mint's own wrapping of an unknown failure, carried through.
    expect(error).toMatchObject({ message: "create_event_from_agreement" });
    expect(holds.rows.get(mine.id)?.status).toBe("CONFIRMED");
    const committed = committedHoldIntentsOf(error);
    expect(committed?.notificationIntents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id })]),
    );

    // A retry finds the night already this request's: it books nothing more
    // and owes nothing (the "already booked" branch — pinned above).
    const releasedOnce = [...holds.rows.values()].filter((h) => h.status === "RELEASED").length;
    expect(releasedOnce).toBe(1);
  });

  it("two requests' manual Create event on one night: the first books it, the second is refused NIGHT_TAKEN (booked) — one CONFIRMED hold, one event", async () => {
    const first = agreed();
    await createEventFromAgreement(first.deps, baseInput);
    // The second request (same venue, same line) — its agreement and request
    // read the SAME hold table.
    const second = agreed({ request: buildRequest({ id: OTHER_REQUEST }) });
    Object.assign(second.deps.repos, { bookingHolds: first.deps.repos.bookingHolds });
    (second.deps.repos.tx as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn({ ...(second.deps.repos as object), bookingHolds: first.deps.repos.bookingHolds }),
    );

    await expect(createEventFromAgreement(second.deps, baseInput)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { booked: true },
    });
    const confirmed = [...holdsOf(first.deps).rows.values()].filter((h) => h.date === NIGHT && h.status === "CONFIRMED");
    expect(confirmed.map((h) => h.bookingRequestId)).toEqual([REQUEST_ID]);
    expect(second.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("date-less legacy terms keep the old behaviour (pinned): nothing booked, the event mints on the first preferred date", async () => {
    const { deps, events } = buildDeps({ calendars: calendars() });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result.notificationIntents).toBeUndefined();
    expect([...holdsOf(deps).rows.values()]).toEqual([]);
    expect(events.upsertDraft.mock.calls[0]![0]!.startsAt.toISOString()).toBe(EXPECTED_DEFAULT_STARTS_AT);
  });
});

describe("createEventFromAgreement — review round 3 (spec N11 gone origin; W1, W2, W3, W5, W6)", () => {
  const MAIN_ID = "ca1e0da1-7777-4777-8777-777777777777";
  const OTHER_REQUEST = "45454545-4545-4545-8545-454545454545";
  const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const CO_OWNER_ID = "32323232-3232-4323-8323-323232323232";
  /** Agreed: 20:00 CDT on 2026-07-17. */
  const AGREED_AT = new Date("2026-07-18T01:00:00.000Z");
  const NIGHT = "2026-07-17";

  const space = (id: string) => ({ id, placeId: PLACE_ID, name: id, capacity: null, sortOrder: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() });
  const calendars = () => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [{
            id: MAIN_ID, placeId: PLACE_ID, name: "Main", slug: "main", description: null, isDefault: true,
            defaultStartTime: null, defaultCategoryId: null, eventTemplate: null,
            createdAt: new Date(), updatedAt: new Date(), spaces: [space("0000f00d-7777-4777-8777-777777777777")],
          }]
        : [],
    ),
  });
  const agreed = (over: Record<string, unknown> = {}) =>
    buildDeps({
      calendars: calendars(),
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT }),
      ...over,
    });
  const holdsOf = (deps: ReturnType<typeof buildDeps>["deps"]) =>
    deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo;
  const confirmedEntries = (deps: ReturnType<typeof buildDeps>["deps"]) =>
    systemEntriesFor(deps.repos, REQUEST_ID).filter((e) => e.systemKind === "booking_hold.confirmed");

  it.each([["CANCELLED"], ["ARCHIVED"], [null]])(
    "N11: an event-first request whose origin is gone (%s) → refused BEFORE the line moves; nothing booked, nothing minted, nothing linked",
    async (status) => {
      const { deps, events, agreements } = agreed({ request: buildRequest({ originEventId: ORIGIN_ID }) });
      const real = events.getById.getMockImplementation()!;
      events.getById.mockImplementation(async (id: string) =>
        id === ORIGIN_ID ? (status ? { id: ORIGIN_ID, status, startsAt: AGREED_AT } : null) : real(id),
      );
      const holds = holdsOf(deps);
      const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
      const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

      await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
        code: "INVALID_STATUS",
        message: "event_first_origin_not_live",
        meta: { eventId: ORIGIN_ID },
      });
      expect(holds.updateStatus).not.toHaveBeenCalled();
      expect(holds.rows.get(mine.id)?.status).toBe("ACTIVE");
      expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
      expect(events.upsertDraft).not.toHaveBeenCalled();
      expect(agreements.repo.setDraftEvent).not.toHaveBeenCalled();
    },
  );

  it("W1: two concurrent manual mints of ONE request with no live holds — both lock the same line, only one books: one CONFIRMED hold, one ledger entry, one event", async () => {
    const { deps, events } = agreed();
    const holds = holdsOf(deps);
    // The second call runs to completion while the first waits for the lock.
    const lockLine = vi.mocked(holds.lockLine);
    const realLock = lockLine.getMockImplementation()!;
    type MintResult = Awaited<ReturnType<typeof createEventFromAgreement>>;
    const pending: { second: Promise<MintResult> | null } = { second: null };
    lockLine.mockImplementation(async (key) => {
      if (!pending.second) {
        pending.second = createEventFromAgreement(deps, baseInput);
        await pending.second;
      }
      return realLock(key);
    });

    const first = await createEventFromAgreement(deps, baseInput);
    const other = await pending.second!;

    const onNight = [...holds.rows.values()].filter((h) => h.date === NIGHT);
    expect(onNight.map((h) => h.status)).toEqual(["CONFIRMED"]);
    expect(confirmedEntries(deps)).toHaveLength(1);
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(first.eventId).toBe(other.eventId);
    // Only the call that booked owes notices; the other finds the night its own.
    expect(first.notificationIntents ?? []).toEqual([]);
  });

  it("W2: a co-owner who is NOT the agreement's human counterparty is refused BEFORE any line change (the mint would refuse after)", async () => {
    const { deps, events } = agreed({
      place: buildPlace({ orgIdsWithAccess: [], humanIdsWithAccess: [VENUE_OWNER_ID, CO_OWNER_ID] }),
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: AGREED_AT,
        counterpartyType: "human",
        counterpartyId: VENUE_OWNER_ID,
      }),
    });
    const holds = holdsOf(deps);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    await expect(
      createEventFromAgreement(deps, { ...baseInput, actorHumanId: CO_OWNER_ID }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "agreement_counterparty", counterpartyId: VENUE_OWNER_ID },
    });
    expect(holds.updateStatus).not.toHaveBeenCalled();
    expect(holds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("W2: a retired place is refused BEFORE any line change", async () => {
    const { deps, events } = agreed({ place: buildPlace({ status: "SUSPENDED" } as never) });
    const holds = holdsOf(deps);
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT, position: 2 });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "PLACE_NOT_ACTIVE",
    });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(holds.updateStatus).not.toHaveBeenCalled();
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("W3: date-less terms — a booking that lands on the line between the guard and the anchor is caught IN the anchor transaction: NIGHT_TAKEN, no anchor, no placement, the orphan draft reported", async () => {
    const { deps, events, agreements, reportError } = buildDeps({ calendars: calendars() });
    const holds = holdsOf(deps);
    const realSave = events.upsertDraft.getMockImplementation()!;
    events.upsertDraft.mockImplementation(async (input) => {
      // Another request books the night while the save runs.
      holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: "2026-07-10", status: "CONFIRMED" });
      return realSave(input);
    });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "NIGHT_TAKEN",
      meta: { date: "2026-07-10", booked: true },
    });
    expect(agreements.record()?.draftEventId).toBeNull();
    expect(events.setVenuePlacement).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "NIGHT_TAKEN" }),
      expect.objectContaining({ extra: expect.objectContaining({ orphanEventId: NEW_EVENT_ID }) }),
    );
  });

  it("W5: the hold-path mint re-checks the event at LINK time — an origin that moved off the hold's night is refused, not anchored", async () => {
    const { deps, events, agreements } = agreed({
      agreement: buildAgreementRecord({ status: "DRAFT" }),
      request: buildRequest({ originEventId: ORIGIN_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID ? { id: ORIGIN_ID, status: "DRAFT", startsAt: new Date("2026-07-19T01:00:00.000Z") } : real(id),
    );

    await expect(
      createEventFromAgreementForHold(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
        hold: { id: "0b01d000-1111-4111-8111-111111111111", calendarId: MAIN_ID, spaceId: null, date: NIGHT, startsAt: AGREED_AT, endsAt: null },
      }),
    ).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: ORIGIN_ID, eventDate: "2026-07-18", holdDate: NIGHT },
    });
    expect(agreements.repo.setDraftEvent).not.toHaveBeenCalled();
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  it("W5: the hold-path draft short-circuit re-checks too — a live draft on another day is never handed back", async () => {
    const DRAFT_ID = "e9e9e9e9-e9e9-4e9e-8e9e-e9e9e9e9e9e9";
    const { deps, events } = agreed({ agreement: buildAgreementRecord({ status: "DRAFT", draftEventId: DRAFT_ID }) });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === DRAFT_ID ? { id: DRAFT_ID, status: "DRAFT", startsAt: new Date("2026-07-11T01:00:00.000Z") } : real(id),
    );

    await expect(
      createEventFromAgreementForHold(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
        hold: { id: "0b01d000-1111-4111-8111-111111111111", calendarId: MAIN_ID, spaceId: null, date: NIGHT, startsAt: AGREED_AT, endsAt: null },
      }),
    ).rejects.toMatchObject({ code: "HOLD_DATE_MISMATCHES_EVENT", meta: { eventId: DRAFT_ID, eventDate: "2026-07-10" } });
  });

  it("W6: re-running the manual Create event books nothing twice — one booking_hold.confirmed entry, no notices owed the second time", async () => {
    const { deps, events } = agreed();
    const holds = holdsOf(deps);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT }); // first in line
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    const first = await createEventFromAgreement(deps, baseInput);
    const second = await createEventFromAgreement(deps, baseInput);

    expect(first.notificationIntents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id })]),
    );
    expect(second.notificationIntents ?? []).toEqual([]);
    expect(second.eventId).toBe(first.eventId);
    expect(confirmedEntries(deps)).toHaveLength(1);
    expect([...holds.rows.values()].filter((h) => h.status === "CONFIRMED")).toHaveLength(1);
    expect(events.upsertDraft).toHaveBeenCalledTimes(1);
  });

  // booking-the-night N15 / FR-011 (P2c) supersedes W6's mint-through-
  // confirm: the request variant of venue confirmation is refused for a
  // request that was not built from an event — before anything is minted,
  // booked or stamped. "Create event" is the venue's mint path.
  it("FR-011: confirmVenueEvent's request variant on a request with no origin event → VENUE_CONFIRMATION_NOT_FOR_REQUESTS; nothing minted, booked or stamped", async () => {
    const { deps, events } = agreed();
    const holds = holdsOf(deps);
    const mine = holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });
    const confirmDeps = deps as unknown as ConfirmVenueEventDeps;

    await expect(
      confirmVenueEvent(confirmDeps, {
        actorHumanId: VENUE_ADMIN_ID,
        bookingRequestId: REQUEST_ID,
        expectedStartsAt: AGREED_AT.toISOString(),
      }),
    ).rejects.toMatchObject({
      code: "VENUE_CONFIRMATION_NOT_FOR_REQUESTS",
      meta: { bookingRequestId: REQUEST_ID },
    });

    expect(events.upsertDraft).not.toHaveBeenCalled();
    expect(holds.rows.get(mine.id)?.status).toBe("ACTIVE");
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(confirmedEntries(deps)).toHaveLength(0);
  });
});

describe("createEventFromAgreement — review round 4 (the shared booking pre-flight; N11 rulings; W3–W5)", () => {
  const MAIN_ID = "ca1e0da1-7777-4777-8777-777777777777";
  const OTHER_REQUEST = "45454545-4545-4545-8545-454545454545";
  const ORIGIN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const DRAFT_ID = "e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7";
  const CO_OWNER_ID = "32323232-3232-4323-8323-323232323232";
  /** Agreed: 20:00 CDT on 2026-07-17. */
  const AGREED_AT = new Date("2026-07-18T01:00:00.000Z");
  const NIGHT = "2026-07-17";

  const space = (id: string) => ({ id, placeId: PLACE_ID, name: id, capacity: null, sortOrder: 0, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date() });
  const calendars = () => ({
    listByPlace: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID
        ? [{
            id: MAIN_ID, placeId: PLACE_ID, name: "Main", slug: "main", description: null, isDefault: true,
            defaultStartTime: null, defaultCategoryId: null, eventTemplate: null,
            createdAt: new Date(), updatedAt: new Date(), spaces: [space("0000f00d-7777-4777-8777-777777777777")],
          }]
        : [],
    ),
  });
  const agreed = (over: Record<string, unknown> = {}) =>
    buildDeps({
      calendars: calendars(),
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT }),
      ...over,
    });
  const holdsOf = (deps: ReturnType<typeof buildDeps>["deps"]) =>
    deps.repos.bookingHolds as unknown as FakeBookingHoldsRepo;
  const quotasOf = (deps: ReturnType<typeof buildDeps>["deps"]) =>
    (deps.repos as unknown as { resourceQuotas: { getEffectiveQuota: ReturnType<typeof vi.fn> } }).resourceQuotas;
  const AT_LIMIT = { limitValue: 5n, currentUsage: 5n };
  /** Venue-owned by a HUMAN owner; a second direct owner who is not the counterparty. */
  const humanVenue = {
    place: buildPlace({ orgIdsWithAccess: [], humanIdsWithAccess: [VENUE_OWNER_ID, CO_OWNER_ID] }),
  };

  it("owner ruling 2026-10-01: a dead origin refuses even with a LIVE legacy draft on the night — nothing booked, linked or finalized", async () => {
    const { deps, events, agreements } = agreed({
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT, draftEventId: DRAFT_ID }),
      request: buildRequest({ originEventId: ORIGIN_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID
        ? { id: ORIGIN_ID, status: "CANCELLED", startsAt: AGREED_AT }
        : id === DRAFT_ID
          ? { id: DRAFT_ID, status: "DRAFT", startsAt: AGREED_AT }
          : real(id),
    );
    const holds = holdsOf(deps);
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "event_first_origin_not_live",
      meta: { eventId: ORIGIN_ID },
    });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(agreements.repo.setDraftEvent).not.toHaveBeenCalled();
  });

  it("W4: a LIVE legacy draft on the night will be FINALIZED — a co-owner who is not the counterparty is refused BEFORE the line moves", async () => {
    const { deps, events } = agreed({
      ...humanVenue,
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: AGREED_AT,
        draftEventId: DRAFT_ID,
        counterpartyType: "human",
        counterpartyId: VENUE_OWNER_ID,
      }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === DRAFT_ID ? { id: DRAFT_ID, status: "DRAFT", startsAt: AGREED_AT, humanId: VENUE_OWNER_ID } : real(id),
    );
    const holds = holdsOf(deps);
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    await expect(
      createEventFromAgreement(deps, { ...baseInput, actorHumanId: CO_OWNER_ID }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "agreement_counterparty", counterpartyId: VENUE_OWNER_ID },
    });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
  });

  // Review round 6 nit 1: the link reports the deferral only for an origin
  // the REQUESTER owns.
  it.each([
    ["requester-owned", { orgId: null, humanId: PERFORMER_ID }, { finalizeBlocked: "requester_owned" }],
    ["venue-owned", { orgId: VENUE_ORG_ID, humanId: null }, {}],
  ] as const)("linking a %s origin reports finalizeBlocked accordingly", async (_label, owner, blocked) => {
    const { deps, events } = agreed({ request: buildRequest({ originEventId: ORIGIN_ID }) });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID ? { id: ORIGIN_ID, status: "DRAFT", startsAt: AGREED_AT, ...owner } : real(id),
    );
    holdsOf(deps).seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toMatchObject({ eventId: ORIGIN_ID, alreadyLinked: true, finalized: false });
    expect(result.finalizeBlocked).toBe((blocked as { finalizeBlocked?: string }).finalizeBlocked);
  });

  it("W5: an event-first request only LINKS its origin — a co-owner who is not the counterparty books the night and links it", async () => {
    const { deps, events, agreements } = agreed({
      ...humanVenue,
      agreement: buildAgreementRecord({
        status: "ACCEPTED",
        proposedDate: AGREED_AT,
        counterpartyType: "human",
        counterpartyId: VENUE_OWNER_ID,
      }),
      request: buildRequest({ originEventId: ORIGIN_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === ORIGIN_ID ? { id: ORIGIN_ID, status: "DRAFT", startsAt: AGREED_AT, humanId: PERFORMER_ID } : real(id),
    );
    const holds = holdsOf(deps);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });

    const result = await createEventFromAgreement(deps, { ...baseInput, actorHumanId: CO_OWNER_ID });

    expect(result).toMatchObject({ eventId: ORIGIN_ID, alreadyLinked: true, finalized: false });
    expect([...holds.rows.values()].filter((h) => h.status === "CONFIRMED").map((h) => h.bookingRequestId)).toEqual([REQUEST_ID]);
    expect(agreements.repo.setDraftEvent).toHaveBeenCalledWith(expect.objectContaining({ draftEventId: ORIGIN_ID }));
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  // Review round 5 W2: finalize follows who REALLY owns the handed-back
  // draft, not the request's intent.
  it("W2: intent PERFORM, but the live draft is the REQUESTER's → the night is booked, the draft handed back, finalize deferred (requester_owned)", async () => {
    const { deps, events, payoutTerms } = agreed({
      agreement: buildAgreementRecord({ status: "ACCEPTED", proposedDate: AGREED_AT, draftEventId: DRAFT_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === DRAFT_ID ? { id: DRAFT_ID, status: "DRAFT", startsAt: AGREED_AT, orgId: null, humanId: PERFORMER_ID } : real(id),
    );
    const holds = holdsOf(deps);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });

    const result = await createEventFromAgreement(deps, baseInput);

    expect(result).toMatchObject({ eventId: DRAFT_ID, alreadyLinked: true, finalized: false, finalizeBlocked: "requester_owned" });
    expect(payoutTerms.activate).not.toHaveBeenCalled();
    expect([...holds.rows.values()].filter((h) => h.status === "CONFIRMED").map((h) => h.bookingRequestId)).toEqual([REQUEST_ID]);
  });

  it("the venue org's EVENTS_PER_ORG quota is read in pre-flight: at the limit → forbidden quota_exceeded BEFORE the line moves", async () => {
    const { deps, events } = agreed();
    quotasOf(deps).getEffectiveQuota.mockResolvedValue(AT_LIMIT);
    const holds = holdsOf(deps);
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    await expect(createEventFromAgreement(deps, baseInput)).rejects.toMatchObject({
      code: "forbidden",
      message: "quota_exceeded",
      meta: { subjectId: VENUE_ORG_ID, kind: "EVENTS_PER_ORG" },
    });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(holds.rows.get(behind.id)?.status).toBe("ACTIVE");
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });

  // W3: a refusal that can still arrive after the take (a race with the
  // pre-flight's read — here the quota used up between the two) is
  // reported, and the night stays booked with its notices on the error.
  it("W3: a refusal AFTER the manual take is reported (guarded) — the night stays booked, the notices ride the error", async () => {
    const { deps, events, reportError } = agreed();
    quotasOf(deps).getEffectiveQuota
      // The plan before the night, and again as the booking pre-flight…
      .mockResolvedValueOnce({ limitValue: BigInt("9007199254740991"), currentUsage: 0n })
      .mockResolvedValueOnce({ limitValue: BigInt("9007199254740991"), currentUsage: 0n })
      // …then the quota is used up before the mint runs its plan again.
      .mockResolvedValue(AT_LIMIT);
    const holds = holdsOf(deps);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    const error = await createEventFromAgreement(deps, baseInput).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "forbidden", message: "quota_exceeded" });
    expect(holds.rows.get(behind.id)?.status).toBe("RELEASED");
    expect([...holds.rows.values()].filter((h) => h.status === "CONFIRMED").map((h) => h.bookingRequestId)).toEqual([REQUEST_ID]);
    expect(events.upsertDraft).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "forbidden", message: "quota_exceeded" }),
      expect.objectContaining({
        tags: { useCase: "createEventFromAgreement", step: "post_commit_mint" },
        extra: expect.objectContaining({ agreementId: AGREEMENT_ID, bookingRequestId: REQUEST_ID }),
      }),
    );
    expect(committedHoldIntentsOf(error)?.notificationIntents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id })]),
    );
  });

  it("W3: a throwing reporter never changes that outcome", async () => {
    const { deps, reportError } = agreed();
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    quotasOf(deps).getEffectiveQuota
      .mockResolvedValueOnce({ limitValue: BigInt("9007199254740991"), currentUsage: 0n })
      .mockResolvedValueOnce({ limitValue: BigInt("9007199254740991"), currentUsage: 0n })
      .mockResolvedValue(AT_LIMIT);
    const holds = holdsOf(deps);
    holds.seed({ bookingRequestId: REQUEST_ID, calendarId: MAIN_ID, date: NIGHT });
    const behind = holds.seed({ bookingRequestId: OTHER_REQUEST, calendarId: MAIN_ID, date: NIGHT });

    const error = await createEventFromAgreement(deps, baseInput).catch((e: unknown) => e);

    expect(reportError).toHaveBeenCalled();
    expect(error).toMatchObject({ code: "forbidden", message: "quota_exceeded" });
    expect(committedHoldIntentsOf(error)?.notificationIntents).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "hold.lost_date", holdId: behind.id })]),
    );
  });
});

describe("createEventFromAgreementOnNight — an anchored draft must sit on the booked night (review B1c)", () => {
  const DRAFT_ID = "e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7";

  it("a live draft on ANOTHER night → HOLD_DATE_MISMATCHES_EVENT, never handed back as this booking's event", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED", draftEventId: DRAFT_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === DRAFT_ID
        ? { id: DRAFT_ID, status: "DRAFT", startsAt: new Date("2026-10-18T01:00:00.000Z") } // Oct 17, 20:00 CDT
        : real(id),
    );

    await expect(
      createEventFromAgreementOnNight(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
        night: { calendarId: DEFAULT_CALENDAR_ID, spaceId: null, date: "2026-10-24" },
      }),
    ).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: DRAFT_ID, eventDate: "2026-10-17", holdDate: "2026-10-24" },
    });
  });

  it("a live draft ON the booked night is handed back", async () => {
    const { deps, events } = buildDeps({
      agreement: buildAgreementRecord({ status: "ACCEPTED", draftEventId: DRAFT_ID }),
    });
    const real = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) =>
      id === DRAFT_ID ? { id: DRAFT_ID, status: "DRAFT", startsAt: new Date("2026-10-18T01:00:00.000Z"), orgId: VENUE_ORG_ID, humanId: null } : real(id),
    );

    await expect(
      createEventFromAgreementOnNight(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
        night: { calendarId: DEFAULT_CALENDAR_ID, spaceId: null, date: "2026-10-17" },
      }),
    ).resolves.toMatchObject({ eventId: DRAFT_ID, alreadyLinked: true });
    expect(events.upsertDraft).not.toHaveBeenCalled();
  });
});

// ── P3b (asks) ───────────────────────────────────────────────────────────────
// venue-booking-standards v1.1 V10 / FR-009d: at the mint, the booking's
// "use as the event image" answer becomes the new event's hero (through the
// event image pipeline), and a failed copy never fails the mint.
describe("createEventFromAgreement — the booking's image answer becomes the hero (P3b)", () => {
  const P3B_ASK_ID = "a5a5a5a5-0000-4000-8000-0000000000b1";
  const P3B_FILE_ID = "a11a11a1-0000-4000-8000-0000000000b1";

  function withAskImage() {
    const built = buildDeps();
    const ask: BookingRequestAskRecord = {
      id: P3B_ASK_ID,
      bookingRequestId: REQUEST_ID,
      kind: "IMAGE",
      label: "Poster",
      note: null,
      standardField: null,
      useAsEventImage: true,
      status: "ANSWERED",
      askedByHumanId: VENUE_ADMIN_ID,
      askedAt: new Date("2026-06-01T00:00:00.000Z"),
      answerAttachmentId: P3B_FILE_ID,
      answerUrl: null,
      answerText: null,
      answerMinutes: null,
      answeredByHumanId: PERFORMER_ID,
      answeredAt: new Date("2026-06-02T00:00:00.000Z"),
      answerRevision: 1,
      withdrawnByHumanId: null,
      withdrawnAt: null,
      eventImageEventId: null,
      eventImageId: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    };
    built.bookingRequests.listAsks.mockResolvedValue([ask]);
    built.bookingRequests.getAttachment.mockResolvedValue({
      id: P3B_FILE_ID,
      bookingRequestId: REQUEST_ID,
      storageKey: `booking-requests/${REQUEST_ID}/poster.png`,
      fileName: "poster.png",
      contentType: "image/png",
      sizeBytes: 2048,
      uploadedBySide: "PERFORMER",
      uploadedByHumanId: PERFORMER_ID,
      askId: P3B_ASK_ID,
      deletedAt: null,
      createdAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    const setHeroImageIfEmpty = vi.fn(async () => true);
    Object.assign(built.events, { setHeroImageIfEmpty });
    const images = {
      create: vi.fn(async (input: Record<string, unknown>) => input),
      markUploaded: vi.fn(async () => ({})),
      attach: vi.fn(async () => undefined),
    };
    const imageModerationRecords = { create: vi.fn(async () => ({})) };
    // The image writes ride the mint's own transaction bag.
    const repos = built.deps.repos as unknown as Record<string, unknown> & {
      tx: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    const tx = repos.tx;
    repos.tx = (fn) =>
      tx((inner) =>
        fn({ ...(inner as object), images, imageModerationRecords }),
      );
    const storage = {
      // A real PNG: the copy strips metadata, so the bytes must parse.
      getObject: vi.fn(async () => ({ content: cleanPng(), contentType: "image/png" })),
      putObject: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn.test/${key}` })),
      getObjectUrl: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn.test/${key}` })),
    };
    return {
      ...built,
      deps: { ...built.deps, storage },
      storage,
      images,
      imageModerationRecords,
      setHeroImageIfEmpty,
    };
  }

  it("copies the answer into events/{id}/images/, queues EVENT_HERO moderation, sets the empty hero", async () => {
    const t = withAskImage();
    const result = await createEventFromAgreement(t.deps, baseInput);

    expect(result.eventId).toBe(NEW_EVENT_ID);
    expect(t.storage.getObject).toHaveBeenCalledWith({
      key: `booking-requests/${REQUEST_ID}/poster.png`,
    });
    expect(t.storage.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `events/${NEW_EVENT_ID}/images/booking-ask-${P3B_ASK_ID}-${P3B_FILE_ID}.png`,
        options: { contentType: "image/png", public: true },
      }),
    );
    expect(t.images.create).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "EVENT", ownerId: NEW_EVENT_ID, eventId: NEW_EVENT_ID }),
    );
    expect(t.imageModerationRecords.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "EVENT_HERO", subjectType: "EVENT", subjectId: NEW_EVENT_ID }),
    );
    expect(t.setHeroImageIfEmpty).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: NEW_EVENT_ID }),
    );
    expect(t.bookingRequests.stampAskEventImage).toHaveBeenCalledWith(
      expect.objectContaining({ id: P3B_ASK_ID, attachmentId: P3B_FILE_ID, eventId: NEW_EVENT_ID }),
    );
    expect(t.reportError).not.toHaveBeenCalled();
  });

  it("a failed copy never fails the mint: the event is returned, the failure reported", async () => {
    const t = withAskImage();
    t.storage.getObject.mockRejectedValueOnce(new Error("r2 down"));
    await expect(createEventFromAgreement(t.deps, baseInput)).resolves.toMatchObject({
      eventId: NEW_EVENT_ID,
    });
    expect(t.images.create).not.toHaveBeenCalled();
    expect(t.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "createEventFromAgreement", step: "ask_image_mapping" },
      }),
    );
  });

  it("without storage wired the mint maps nothing and reports nothing", async () => {
    const t = withAskImage();
    const { storage: _omit, ...deps } = t.deps;
    await createEventFromAgreement(deps, baseInput);
    expect(t.images.create).not.toHaveBeenCalled();
    expect(t.reportError).not.toHaveBeenCalled();
  });
});
