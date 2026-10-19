import { describe, it, expect, vi, beforeEach } from "vitest";

import type { EventDateRecord } from "@th/ports/repos/event-dates";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { createFakeBookingHoldsRepo } from "../booking-holds/__tests__/fakes";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import {
  detectConflicts,
  getVenueCalendar,
  getVenueCalendarInputSchema,
  type GetVenueCalendarDeps,
  type GetVenueCalendarOutput,
} from "./get-venue-calendar";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "aaaaaaaa-1111-1111-a111-aaaaaaaaaaaa";
const EVENT_ID_1 = "bbbbbbbb-1111-1111-a111-bbbbbbbbbbbb";
const EVENT_ID_2 = "bbbbbbbb-2222-2222-a222-bbbbbbbbbbbb";
/**
 * The venue's owning org. Fixtures default to VENUE-OWNED events (event.orgId
 * === the place's org) so they are venue-confirmed by construction
 * (docs/specs/2026-08-27) and the pre-existing expectations hold; the
 * venue-confirmation suite below opts individual events OUT.
 */
const VENUE_ORG_ID = "aaaaaaaa-2222-2222-a222-aaaaaaaaaaaa";
const THIRD_PARTY_ORG_ID = "aaaaaaaa-3333-3333-a333-aaaaaaaaaaaa";

const now = new Date("2026-03-15T12:00:00Z");

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Fillmore",
    formattedAddress: "1805 Geary Blvd",
    addressLine1: "1805 Geary Blvd",
    addressLine2: null,
    city: "San Francisco",
    region: "CA",
    postalCode: "94115",
    countryCode: "US",
    capacity: 1150,
    lat: 37.784,
    lng: -122.433,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [VENUE_ORG_ID],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID_1,
    orgId: VENUE_ORG_ID,
    humanId: null,
    title: "Test Concert",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date("2026-04-01T20:00:00Z"),
    endsAt: new Date("2026-04-01T23:00:00Z"),
    placeId: PLACE_ID,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: "test-concert",
    shortId: null,
    regionCode: "us-ca",
    publishedAt: new Date("2026-03-01T10:00:00Z"),
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    waitlistStatus: "DISABLED",
    heroImageUrl: "https://example.com/hero.jpg",
    locality: "San Francisco",
    region: "CA",
    ...overrides,
  };
}

function makePageResult(events: EventRecord[], total?: number) {
  return {
    items: events,
    pageInfo: {
      total: total ?? events.length,
      limit: 20,
      offset: 0,
      count: events.length,
      hasMore: false,
    },
  };
}

function makeDeps(
  overrides: {
    placeById?: PlaceRecord | null;
    pageResult?: ReturnType<typeof makePageResult>;
    allEvents?: EventRecord[];
    /** SCHEDULED/CANCELLED EventDate rows the batched read returns (FR-003). */
    eventDates?: EventDateRecord[];
    statusByKey?: Record<string, ImageModerationStatus>;
    bookingHolds?: ReturnType<typeof createFakeBookingHoldsRepo>;
    bookingRequestById?: (id: string) => unknown;
    humansByIds?: (ids: string[]) => unknown[];
  } = {},
): GetVenueCalendarDeps & {
  resolveByKeys: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
} {
  const defaultPlace = makePlace();
  const gate = makeImageModerationGateFake(overrides.statusByKey ?? {});
  return {
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
    repos: {
      imageModerationRecords: gate.imageModerationRecords,
      places: {
        getById: vi
          .fn()
          .mockResolvedValue(
            overrides.placeById !== undefined
              ? overrides.placeById
              : defaultPlace,
          ),
      },
      events: {
        listPublishedByPlace: vi
          .fn()
          .mockResolvedValue(
            overrides.pageResult ?? makePageResult([makeEvent()]),
          ),
        listAllByPlace: vi
          .fn()
          .mockResolvedValue(overrides.allEvents ?? [makeEvent()]),
      },
      eventDates: {
        listByEventIds: vi.fn().mockResolvedValue(overrides.eventDates ?? []),
      },
      authz: {
        getOrgMemberships: vi.fn().mockResolvedValue([]),
      },
      seriesOccurrences: {
        getCalendarInfoForEventIds: vi.fn().mockResolvedValue([]),
      },
      bookingHolds: overrides.bookingHolds ?? createFakeBookingHoldsRepo(),
      bookingRequests: {
        getById: vi.fn(async (id: string) => overrides.bookingRequestById?.(id) ?? null),
      },
      humans: { getByIds: vi.fn(async (ids: string[]) => overrides.humansByIds?.(ids) ?? []) },
      organizations: { getByIds: vi.fn(async () => []) },
    } as unknown as GetVenueCalendarDeps["repos"],
    reportError: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      child: vi.fn().mockReturnThis(),
      withTime: vi.fn((_name, f) => f()),
    } as unknown as GetVenueCalendarDeps["logger"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendarInputSchema (public mode)", () => {
  it("requires mode to be present", () => {
    const result = getVenueCalendarInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("requires a placeId", () => {
    const result = getVenueCalendarInputSchema.safeParse({ mode: "public" });
    expect(result.success).toBe(false);
  });

  it("accepts placeId alone", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.success).toBe(true);
  });

  // `Place.slug` is deprecated — a multi-segment DIRECTORY key no route ever
  // resolved — so the public calendar takes an id and nothing else. A caller
  // still sending the old key is REJECTED, not silently ignored: the schema is
  // `.strict()`, and a silently-dropped slug would resolve some other venue's
  // calendar (or none) with no signal.
  it("rejects a placeSlug — the deprecated Place.slug input is gone", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeId: PLACE_ID,
      placeSlug: "us/ca/the-fillmore--a1b2c3d4e5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a placeSlug even when it is the ONLY identifier given", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeSlug: "us/ca/the-fillmore--a1b2c3d4e5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects from >= to", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeId: PLACE_ID,
      from: new Date("2026-04-10T00:00:00Z"),
      to: new Date("2026-04-01T00:00:00Z"),
    });
    expect(result.success).toBe(false);
  });

  it("defaults limit to 20 and offset to 0", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.mode === "public") {
      expect(result.data.limit).toBe(20);
      expect(result.data.offset).toBe(0);
    }
  });

  it("rejects limit > 50", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeId: PLACE_ID,
      limit: 51,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid placeId", () => {
    const result = getVenueCalendarInputSchema.safeParse({
      mode: "public",
      placeId: "the-fillmore",
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Place resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — place resolution", () => {
  it("resolves by placeId", async () => {
    const deps = makeDeps();
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(deps.repos.places.getById).toHaveBeenCalledWith(PLACE_ID);
    expect(result.events).toHaveLength(1);
  });

  // The ONLY resolution path. `places.getBySlug` no longer exists on the port;
  // if a slug branch is ever reintroduced here, the fake below has no such
  // method and the id path stops being the one that ran.
  it("resolves a place by id and by nothing else", async () => {
    const deps = makeDeps();
    await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID });
    expect(deps.repos.places.getById).toHaveBeenCalledTimes(1);
    expect(deps.repos.places).not.toHaveProperty("getBySlug");
  });

  it("throws not_found when place does not exist (by id)", async () => {
    const deps = makeDeps({ placeById: null });
    await expect(
      getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Visibility gating
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — visibility gating", () => {
  it("throws not_found for UNVERIFIED place", async () => {
    const deps = makeDeps({
      placeById: makePlace({ verificationStatus: "UNVERIFIED" }),
    });
    await expect(
      getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });
  });

  it("throws not_found for PENDING place", async () => {
    const deps = makeDeps({
      placeById: makePlace({ verificationStatus: "PENDING" }),
    });
    await expect(
      getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });
  });

  it("throws not_found for REJECTED place", async () => {
    const deps = makeDeps({
      placeById: makePlace({ verificationStatus: "REJECTED" }),
    });
    await expect(
      getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_VERIFIED" });
  });

  it("throws not_found for SUSPENDED place", async () => {
    const deps = makeDeps({
      placeById: makePlace({ status: "SUSPENDED" }),
    });
    await expect(
      getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
  });

  it("throws not_found for ARCHIVED place", async () => {
    const deps = makeDeps({
      placeById: makePlace({ status: "ARCHIVED" }),
    });
    await expect(
      getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
  });

  it("allows VERIFIED + ACTIVE place", async () => {
    const deps = makeDeps();
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — happy path", () => {
  it("returns events with correct shape", async () => {
    const event = makeEvent({
      id: EVENT_ID_1,
      slug: "my-concert",
      title: "My Concert",
      startsAt: new Date("2026-05-01T19:00:00Z"),
      endsAt: new Date("2026-05-01T22:00:00Z"),
      heroImageUrl: "https://example.com/img.jpg",
      locality: "San Francisco",
      region: "CA",
    });
    const deps = makeDeps({ pageResult: makePageResult([event]) });

    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });

    expect(result.events).toHaveLength(1);
    const e = result.events[0]!;
    expect(e.eventId).toBe(EVENT_ID_1);
    expect(e.slug).toBe("my-concert");
    expect(e.title).toBe("My Concert");
    expect(e.startsAt).toEqual(new Date("2026-05-01T19:00:00Z"));
    expect(e.endsAt).toEqual(new Date("2026-05-01T22:00:00Z"));
    expect(e.primaryImageUrl).toBe("https://example.com/img.jpg");
    expect(e.city).toBe("San Francisco");
    expect(e.region).toBe("CA");
    // Price range and sold-out deferred until batch ticket aggregation
    expect(e.priceRange).toBeNull();
    expect(e.soldOut).toBeNull();
    // event-calendar-redesign FR-001 / FR-003
    expect(e.timezone).toBe("America/Chicago");
    expect(e.occurrence).toBeNull();
    expect(result.venueTimezone).toBe("America/Chicago");
  });

  it("returns empty list when no events", async () => {
    const deps = makeDeps({ pageResult: makePageResult([]) });
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events).toHaveLength(0);
    expect(result.pageInfo!.total).toBe(0);
  });

  it("uses default time window when from/to not provided", async () => {
    const deps = makeDeps();
    await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID });

    const call = vi.mocked(deps.repos.events.listPublishedByPlace).mock
      .calls[0]![0];
    // from should be approximately now
    expect(call.from).toBeInstanceOf(Date);
    // to should be ~90 days after from
    const windowMs = call.to.getTime() - call.from.getTime();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(windowMs).toBe(ninetyDaysMs);
  });

  it("passes explicit from/to to the repo", async () => {
    const from = new Date("2026-05-01T00:00:00Z");
    const to = new Date("2026-06-01T00:00:00Z");
    const deps = makeDeps();
    await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
      from,
      to,
    });

    const call = vi.mocked(deps.repos.events.listPublishedByPlace).mock
      .calls[0]![0];
    expect(call.from).toEqual(from);
    expect(call.to).toEqual(to);
  });

  it("passes limit and offset through", async () => {
    const deps = makeDeps();
    await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
      limit: 5,
      offset: 10,
    });

    const call = vi.mocked(deps.repos.events.listPublishedByPlace).mock
      .calls[0]![0];
    expect(call.limit).toBe(5);
    expect(call.offset).toBe(10);
  });

  it("always queries upcoming (not past) events", async () => {
    const deps = makeDeps();
    await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID });

    const call = vi.mocked(deps.repos.events.listPublishedByPlace).mock
      .calls[0]![0];
    expect(call.status).toBe("upcoming");
  });

  it("returns correct pageInfo with hasMore", async () => {
    const event = makeEvent();
    const deps = makeDeps({
      pageResult: {
        items: [event],
        pageInfo: { total: 25, limit: 10, offset: 0, count: 10, hasMore: true },
      },
    });

    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
      limit: 10,
    });
    expect(result.pageInfo!.total).toBe(25);
    expect(result.pageInfo!.limit).toBe(10);
    expect(result.pageInfo!.offset).toBe(0);
    expect(result.pageInfo!.hasMore).toBe(true);
  });

  it("handles events without heroImageUrl gracefully", async () => {
    const event = makeEvent({ heroImageUrl: undefined });
    const deps = makeDeps({ pageResult: makePageResult([event]) });
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events[0]!.primaryImageUrl).toBeNull();
  });

  it("falls back to regionCode when region is null", async () => {
    const event = makeEvent({ region: null, regionCode: "us-ca" });
    const deps = makeDeps({ pageResult: makePageResult([event]) });
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events[0]!.region).toBe("us-ca");
  });

  it("returns multiple events in order", async () => {
    const events = [
      makeEvent({
        id: EVENT_ID_1,
        title: "First",
        startsAt: new Date("2026-04-01T20:00:00Z"),
      }),
      makeEvent({
        id: EVENT_ID_2,
        title: "Second",
        startsAt: new Date("2026-04-15T20:00:00Z"),
      }),
    ];
    const deps = makeDeps({
      pageResult: makePageResult(events, 2),
    });
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.title).toBe("First");
    expect(result.events[1]!.title).toBe("Second");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — logging", () => {
  it("logs the query metadata", async () => {
    const deps = makeDeps();
    await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID });
    expect(deps.logger!.info).toHaveBeenCalledWith(
      "events.get_venue_calendar",
      expect.objectContaining({
        placeId: PLACE_ID,
        resultCount: expect.any(Number),
        total: expect.any(Number),
      }),
    );
  });
});

// ── Hero moderation gate (FR-005) ────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds FR-014 / NFR-001: the PUBLIC read is byte-identical with and
// without holds present, and never touches the hold repo.
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — public output is byte-identical with holds present", () => {
  const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
  const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("PUBLIC (placeId): same bytes before and after a live hold lands in the window; no hold read", async () => {
    const bookingHolds = createFakeBookingHoldsRepo();
    const deps = makeDeps({ bookingHolds });
    const input = {
      mode: "public" as const,
      placeId: PLACE_ID,
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-05-01T00:00:00Z"),
    };

    const before = await getVenueCalendar(deps, input);
    const hold = bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-03-20" });
    // Even a repo that WOULD return the hold must never be asked.
    bookingHolds.listLiveForPlaceRange = vi.fn(async () => [hold]);
    const after = await getVenueCalendar(deps, input);

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).not.toHaveProperty("holds");
    expect(bookingHolds.listLiveForPlaceRange).not.toHaveBeenCalled();
    expect(bookingHolds.listLiveForCalendarRange).not.toHaveBeenCalled();
    expect(bookingHolds.listLine).not.toHaveBeenCalled();
  });

  it("PUBLIC (second read): identical, and the output never carries the hold's ids", async () => {
    const bookingHolds = createFakeBookingHoldsRepo();
    const deps = makeDeps({ bookingHolds });
    const input = { mode: "public" as const, placeId: PLACE_ID };

    const before = await getVenueCalendar(deps, input);
    const hold = bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-03-20" });
    const after = await getVenueCalendar(deps, input);

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(JSON.stringify(after)).not.toContain(hold.id);
    expect(JSON.stringify(after)).not.toContain(REQUEST_ID);
  });
});

// Booking-holds FR-014: the ADMIN overlay carries the sender's resolved
// platform name next to the pitched act name (batched, degrading).
describe("getVenueCalendar — admin hold overlay performer display name", () => {
  const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
  const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const HUMAN_ID = "55555555-5555-4555-8555-555555555555";
  const ACTOR = "cccccccc-1111-1111-a111-cccccccccccc";
  const ownedRequest = (id: string) =>
    id === REQUEST_ID
      ? { id, actName: null, performerOwnerType: "human", performerOwnerId: HUMAN_ID, contactName: null, contactEmail: null }
      : null;
  const adminInput = {
    mode: "admin" as const,
    placeId: PLACE_ID,
    actorHumanId: ACTOR,
    from: new Date("2026-03-01T00:00:00Z"),
    to: new Date("2026-05-01T00:00:00Z"),
  };

  it("resolves the owner's name off the request's owner pair", async () => {
    const bookingHolds = createFakeBookingHoldsRepo();
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      bookingHolds,
      bookingRequestById: ownedRequest,
      humansByIds: (ids) => (ids.includes(HUMAN_ID) ? [{ id: HUMAN_ID, name: "Willa" }] : []),
    });
    const hold = bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-03-20" });
    // The fake has no calendar→place index; the place read is the range read.
    bookingHolds.listLiveForPlaceRange = vi.fn(async () => [hold]);

    const result = await getVenueCalendar(deps, adminInput);
    expect("holds" in result && result.holds.map((h) => [h.id, h.actName, h.performerDisplayName])).toEqual([
      [hold.id, null, "Willa"],
    ]);
    expect(deps.repos.humans.getByIds).toHaveBeenCalledTimes(1);
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("degrades to a null name and reports when the name lookup throws — the calendar still renders", async () => {
    const bookingHolds = createFakeBookingHoldsRepo();
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      bookingHolds,
      bookingRequestById: ownedRequest,
      humansByIds: () => {
        throw new Error("humans down");
      },
    });
    const hold = bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-03-20" });
    // The fake has no calendar→place index; the place read is the range read.
    bookingHolds.listLiveForPlaceRange = vi.fn(async () => [hold]);

    const result = await getVenueCalendar(deps, adminInput);
    expect("holds" in result && result.holds.map((h) => [h.id, h.performerDisplayName])).toEqual([[hold.id, null]]);
    expect(deps.reportError).toHaveBeenCalledTimes(1);
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "humans down" }),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "booking-hold-overlay" }) }),
    );
  });

  it("the PUBLIC read never resolves names and never carries the resolved name", async () => {
    const bookingHolds = createFakeBookingHoldsRepo();
    const deps = makeDeps({
      bookingHolds,
      bookingRequestById: ownedRequest,
      humansByIds: () => [{ id: HUMAN_ID, name: "Willa" }],
    });
    bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-03-20" });
    const result = await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID, from: adminInput.from, to: adminInput.to });
    expect(result).not.toHaveProperty("holds");
    expect(JSON.stringify(result)).not.toContain("Willa");
    expect(deps.repos.humans.getByIds).not.toHaveBeenCalled();
    expect(deps.repos.bookingRequests.getById).not.toHaveBeenCalled();
  });
});

describe("getVenueCalendar — hero moderation gate", () => {
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";
  const ACTOR = "cccccccc-1111-1111-a111-cccccccccccc";
  const heroEvent = () =>
    makeEvent({ heroImageUrl: HERO_URL, heroImageKey: HERO_KEY });

  it("PUBLIC: shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const deps = makeDeps({
      pageResult: makePageResult([heroEvent()]),
      statusByKey: { [HERO_KEY]: "APPROVED" },
    });
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events[0]!.primaryImageUrl).toBe(HERO_URL);
    expect(deps.resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "PUBLIC: omits a %s hero",
    async (status) => {
      const deps = makeDeps({
        pageResult: makePageResult([heroEvent()]),
        statusByKey: { [HERO_KEY]: status },
      });
      const result = await getVenueCalendar(deps, {
        mode: "public",
        placeId: PLACE_ID,
      });
      expect(result.events[0]!.primaryImageUrl).toBeNull();
    },
  );

  it("PUBLIC: shows a legacy hero with NO moderation record", async () => {
    const deps = makeDeps({
      pageResult: makePageResult([heroEvent()]),
    });
    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
    });
    expect(result.events[0]!.primaryImageUrl).toBe(HERO_URL);
  });

  it("ADMIN (owner): does NOT gate — a FLAGGED hero is still shown to the owner", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [heroEvent()],
      statusByKey: { [HERO_KEY]: "FLAGGED" },
    });
    const result = await getVenueCalendar(deps, {
      mode: "admin",
      placeId: PLACE_ID,
      actorHumanId: ACTOR,
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.events[0]!.primaryImageUrl).toBe(HERO_URL);
    // Owner view never runs the gate.
    expect(deps.resolveByKeys).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectConflicts — double-booking overlap arithmetic
//
// The overlap MINUTES this returns are rendered verbatim to venue operators
// (chip tooltip, agenda caption, the conflict icon's aria-label), so a wrong
// number is a wrong claim about their calendar — not just an internal detail.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// event-calendar-redesign FR-001 (timezone) + FR-003 (EventDate expansion)
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — FR-001 timezone on both legs", () => {
  const ACTOR = "cccccccc-1111-1111-a111-cccccccccccc";

  it("PUBLIC: venueTimezone is the place's zone; each event carries its own", async () => {
    const deps = makeDeps({
      placeById: makePlace({ timezone: "America/New_York" }),
      pageResult: makePageResult([
        makeEvent({ id: EVENT_ID_1, timezone: "America/New_York" }),
        makeEvent({ id: EVENT_ID_2, timezone: "Europe/Berlin" }),
      ]),
    });
    const result = await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID });
    expect(result.venueTimezone).toBe("America/New_York");
    expect(result.events.map((e) => e.timezone)).toEqual(["America/New_York", "Europe/Berlin"]);
  });

  it("ADMIN: same fields, plus holds — and a null/invalid Place.timezone resolves to the platform default", async () => {
    const deps = makeDeps({
      placeById: makePlace({ timezone: null, humanIdsWithAccess: [ACTOR] }),
      allEvents: [makeEvent({ timezone: "Europe/Berlin" })],
    });
    const result = (await getVenueCalendar(deps, {
      mode: "admin",
      placeId: PLACE_ID,
      actorHumanId: ACTOR,
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-05-01T00:00:00Z"),
    })) as Extract<GetVenueCalendarOutput, { holds: unknown }>;
    expect(result.venueTimezone).toBe("America/Chicago");
    expect(result.events[0]!.timezone).toBe("Europe/Berlin");
    expect(result).toHaveProperty("holds");
  });
});

describe("getVenueCalendar — FR-003 EventDate expansion", () => {
  const ACTOR = "cccccccc-1111-1111-a111-cccccccccccc";
  const LISTING = "bbbbbbbb-3333-3333-a333-bbbbbbbbbbbb";
  const D1 = "dddddddd-0001-4001-8001-dddddddddddd";
  const D2 = "dddddddd-0002-4002-8002-dddddddddddd";
  const D3 = "dddddddd-0003-4003-8003-dddddddddddd";
  const FROM = new Date("2026-04-05T00:00:00Z");
  const TO = new Date("2026-04-20T00:00:00Z");

  const dateRow = (
    id: string,
    startsAt: string,
    status: "SCHEDULED" | "CANCELLED" = "SCHEDULED",
  ): EventDateRecord => ({
    id,
    eventId: LISTING,
    ordinal: 0,
    startsAt: new Date(startsAt),
    endsAt: null,
    status,
    createdAt: now,
    updatedAt: now,
  });

  // A community listing pinned to 2026-04-01 (OUTSIDE the window) with
  // nights on 04-01, 04-08 (in), 04-15 (in), and a cancelled 04-12.
  const listing = makeEvent({
    id: LISTING,
    title: "Wednesday Residency",
    startsAt: new Date("2026-04-01T20:00:00Z"),
    endsAt: new Date("2026-04-01T23:00:00Z"),
  });
  const rows = [
    dateRow(D1, "2026-04-01T20:00:00Z"),
    dateRow(D2, "2026-04-08T20:00:00Z"),
    dateRow("dddddddd-0009-4009-8009-dddddddddddd", "2026-04-12T20:00:00Z", "CANCELLED"),
    dateRow(D3, "2026-04-15T20:00:00Z"),
  ];

  it("ADMIN: opts the repo into EventDate matching, expands one chip per in-window night, and keeps Date N of M over ALL scheduled nights", async () => {
    const single = makeEvent({
      id: EVENT_ID_2,
      title: "One-off",
      startsAt: new Date("2026-04-10T20:00:00Z"),
      endsAt: new Date("2026-04-10T23:00:00Z"),
    });
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [listing, single],
      eventDates: rows,
    });

    const result = await getVenueCalendar(deps, {
      mode: "admin",
      placeId: PLACE_ID,
      actorHumanId: ACTOR,
      from: FROM,
      to: TO,
    });

    expect(deps.repos.events.listAllByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ includeDateOccurrences: true }),
    );
    expect(deps.repos.eventDates.listByEventIds).toHaveBeenCalledWith({
      eventIds: [LISTING, EVENT_ID_2],
      statuses: ["SCHEDULED"],
    });
    // Chronological; the pinned 04-01 night is outside the window and gone;
    // the cancelled 04-12 is neither a chip nor counted.
    expect(
      result.events.map((e) => [e.eventId, e.startsAt.toISOString(), e.occurrence]),
    ).toEqual([
      [LISTING, "2026-04-08T20:00:00.000Z", { index: 2, total: 3, eventDateId: D2 }],
      [EVENT_ID_2, "2026-04-10T20:00:00.000Z", null],
      [LISTING, "2026-04-15T20:00:00.000Z", { index: 3, total: 3, eventDateId: D3 }],
    ]);
    // Every occurrence still carries the parent's fields.
    expect(result.events[0]).toMatchObject({ title: "Wednesday Residency", timezone: "America/Chicago" });
  });

  it("PUBLIC: same expansion behind the published-only read, window-trimmed, pagination still event-shaped", async () => {
    const deps = makeDeps({
      pageResult: makePageResult([listing], 1),
      eventDates: rows,
    });

    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
      from: FROM,
      to: TO,
    });

    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ includeDateOccurrences: true, from: FROM, to: TO }),
    );
    expect(result.events.map((e) => e.occurrence?.eventDateId)).toEqual([D2, D3]);
    expect(result.pageInfo).toMatchObject({ total: 1 });
  });

  it("PUBLIC (place page): still hides cancelled shows — the feed-only cancelled read never leaks in", async () => {
    const deps = makeDeps({
      pageResult: makePageResult([listing], 1),
      eventDates: rows,
    });

    const result = await getVenueCalendar(deps, {
      mode: "public",
      placeId: PLACE_ID,
      from: FROM,
      to: TO,
    });

    const [input] = vi.mocked(deps.repos.events.listPublishedByPlace).mock.calls[0]!;
    expect(input.statuses).toBeUndefined(); // PUBLISHED-only default
    expect(input.cancelledWhilePublished).toBeUndefined();
    expect(input.dateOccurrenceStatuses).toBeUndefined(); // SCHEDULED-only default
    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledTimes(1);
    expect(deps.repos.eventDates.listByEventIds).toHaveBeenCalledWith({
      eventIds: [LISTING],
      statuses: ["SCHEDULED"],
    });
    // The cancelled 04-12 night is not a chip.
    expect(result.events.some((e) => e.startsAt.toISOString().startsWith("2026-04-12"))).toBe(false);
  });

  it("series occurrences are untouched: no EventDate rows → occurrence null, series info still attached", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [makeEvent({ startsAt: new Date("2026-04-10T20:00:00Z"), endsAt: new Date("2026-04-10T22:00:00Z") })],
    });
    (deps.repos.seriesOccurrences.getCalendarInfoForEventIds as ReturnType<typeof vi.fn>).mockResolvedValue([
      { eventId: EVENT_ID_1, seriesId: "eeeeeeee-4444-4444-8444-eeeeeeeeeeee", seriesName: "Friday Jazz" },
    ]);

    const result = await getVenueCalendar(deps, {
      mode: "admin",
      placeId: PLACE_ID,
      actorHumanId: ACTOR,
      from: FROM,
      to: TO,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventId: EVENT_ID_1,
      occurrence: null,
      seriesName: "Friday Jazz",
    });
  });

  it("PUBLIC leg never reads holds even with expansion in play (NFR-001 posture unchanged)", async () => {
    const holds = createFakeBookingHoldsRepo();
    const deps = makeDeps({ pageResult: makePageResult([listing]), eventDates: rows, bookingHolds: holds });
    const result = await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID, from: FROM, to: TO });
    expect(holds.listLiveForPlaceRange).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("holds");
  });
});

describe("detectConflicts", () => {
  const at = (iso: string) => new Date(iso);
  // Default space: conflicts are SPACE-keyed (venue-hierarchy FR-006). Every
  // legacy scenario below runs with all events on ONE shared space — after
  // the Step-1 backfill that is exactly what a one-space place looks like, so
  // these cases double as the per-place ≡ per-space equivalence pins.
  const SPACE_A = "space-aaaa";
  const SPACE_B = "space-bbbb";
  const ev = (
    id: string,
    startsAt: string,
    endsAt: string | null,
    spaceId: string | null = SPACE_A,
  ) => ({
    id,
    startsAt: at(startsAt),
    endsAt: endsAt === null ? null : at(endsAt),
    spaceId,
  });

  it("reports the CONTAINED booking's own duration, not the container's tail", () => {
    // Regression: the old formula was `a.endsAt - b.startsAt`, which assumed
    // `b` outlasts `a`. A 12:00–23:00 festival with a 19:00–20:00 side-space
    // set was reported as a 4h overlap; the true overlap is 1h.
    const conflicts = detectConflicts([
      ev("festival", "2026-03-10T12:00:00Z", "2026-03-10T23:00:00Z"),
      ev("side-space", "2026-03-10T19:00:00Z", "2026-03-10T20:00:00Z"),
    ]);

    expect(conflicts).toEqual([
      { eventAId: "festival", eventBId: "side-space", overlapMinutes: 60 },
    ]);
  });

  it("reports the shared window for a PARTIAL overlap", () => {
    // 20:00–23:00 and 22:00–01:00 share 22:00–23:00 = 1h.
    const conflicts = detectConflicts([
      ev("early", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z"),
      ev("late", "2026-03-10T22:00:00Z", "2026-03-11T01:00:00Z"),
    ]);

    expect(conflicts).toEqual([
      { eventAId: "early", eventBId: "late", overlapMinutes: 60 },
    ]);
  });

  it("does NOT flag exact-boundary touching (endsAt === next startsAt)", () => {
    // Back-to-back bookings are the normal case for a turned-over space.
    expect(
      detectConflicts([
        ev("first", "2026-03-10T18:00:00Z", "2026-03-10T20:00:00Z"),
        ev("second", "2026-03-10T20:00:00Z", "2026-03-10T22:00:00Z"),
      ]),
    ).toEqual([]);
  });

  it("does NOT flag fully disjoint bookings", () => {
    expect(
      detectConflicts([
        ev("first", "2026-03-10T18:00:00Z", "2026-03-10T20:00:00Z"),
        ev("second", "2026-03-10T21:00:00Z", "2026-03-10T22:00:00Z"),
      ]),
    ).toEqual([]);
  });

  it("reports one pair per conflicting combination when an event clashes with two others", () => {
    // Container 12:00–23:00 vs a contained 13:00–14:00 and a tail-overlapping
    // 22:00–02:00; the two inner bookings do not clash with each other.
    const conflicts = detectConflicts([
      ev("container", "2026-03-10T12:00:00Z", "2026-03-10T23:00:00Z"),
      ev("inner", "2026-03-10T13:00:00Z", "2026-03-10T14:00:00Z"),
      ev("tail", "2026-03-10T22:00:00Z", "2026-03-11T02:00:00Z"),
    ]);

    expect(conflicts).toEqual([
      { eventAId: "container", eventBId: "inner", overlapMinutes: 60 },
      { eventAId: "container", eventBId: "tail", overlapMinutes: 60 },
    ]);
  });

  it("excludes unbounded events (no endsAt) from conflict analysis", () => {
    expect(
      detectConflicts([
        ev("bounded", "2026-03-10T12:00:00Z", "2026-03-10T23:00:00Z"),
        ev("unbounded", "2026-03-10T13:00:00Z", null),
      ]),
    ).toEqual([]);
  });

  it("handles identical windows (full mutual containment)", () => {
    const conflicts = detectConflicts([
      ev("a", "2026-03-10T20:00:00Z", "2026-03-10T22:00:00Z"),
      ev("b", "2026-03-10T20:00:00Z", "2026-03-10T22:00:00Z"),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.overlapMinutes).toBe(120);
  });

  it("returns nothing for a single event or an empty calendar", () => {
    expect(detectConflicts([])).toEqual([]);
    expect(
      detectConflicts([
        ev("solo", "2026-03-10T20:00:00Z", "2026-03-10T22:00:00Z"),
      ]),
    ).toEqual([]);
  });

  // ── Space re-key (venue-hierarchy FR-006) ──────────────────────────────────

  it("flags overlapping events on the SAME space", () => {
    const conflicts = detectConflicts([
      ev("a", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z", SPACE_A),
      ev("b", "2026-03-10T21:00:00Z", "2026-03-11T00:00:00Z", SPACE_A),
    ]);
    expect(conflicts).toEqual([
      { eventAId: "a", eventBId: "b", overlapMinutes: 120 },
    ]);
  });

  it("does NOT flag overlapping events on DIFFERENT spaces of the same place", () => {
    // Main stage + back bar, same night, same place — the whole point of the
    // space re-key: two spaces can host simultaneously without a warning.
    expect(
      detectConflicts([
        ev("main-stage", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z", SPACE_A),
        ev("back-bar", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z", SPACE_B),
      ]),
    ).toEqual([]);
  });

  it("EXEMPTS spaceless events (null spaceId) from conflict detection entirely", () => {
    // Freeform-address / pre-hierarchy rows sit outside the space system —
    // they neither conflict with each other nor with spaceful events.
    expect(
      detectConflicts([
        ev("spaceless-1", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z", null),
        ev("spaceless-2", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z", null),
        ev("spaceful", "2026-03-10T20:00:00Z", "2026-03-10T23:00:00Z", SPACE_A),
      ]),
    ).toEqual([]);
  });

  it("EXEMPTS events with an ABSENT spaceId (legacy projections without the field)", () => {
    expect(
      detectConflicts([
        { id: "legacy-1", startsAt: at("2026-03-10T20:00:00Z"), endsAt: at("2026-03-10T23:00:00Z") },
        { id: "legacy-2", startsAt: at("2026-03-10T21:00:00Z"), endsAt: at("2026-03-11T00:00:00Z") },
      ]),
    ).toEqual([]);
  });

  it("one-space place: per-space detection is IDENTICAL to the old per-place detection", () => {
    // Step-1 backfill invariant: every place-linked event got the place's
    // single default space, so a one-space place must behave exactly as the
    // pre-hierarchy per-place detector did. This is the named behavioural
    // equivalence pin — a mixed bag of contained, partial, disjoint,
    // boundary-touching and unbounded events, all on one space.
    const scenario = (spaceId: string | null) => [
      ev("festival", "2026-03-10T12:00:00Z", "2026-03-10T23:00:00Z", spaceId),
      ev("inner", "2026-03-10T13:00:00Z", "2026-03-10T14:00:00Z", spaceId),
      ev("tail", "2026-03-10T22:00:00Z", "2026-03-11T02:00:00Z", spaceId),
      ev("next-day", "2026-03-11T03:00:00Z", "2026-03-11T05:00:00Z", spaceId),
      ev("unbounded", "2026-03-10T13:00:00Z", null, spaceId),
    ];

    // The old per-place expectation for this bag (real overlap arithmetic):
    const perPlaceExpectation = [
      { eventAId: "festival", eventBId: "inner", overlapMinutes: 60 },
      { eventAId: "festival", eventBId: "tail", overlapMinutes: 60 },
    ];

    expect(detectConflicts(scenario(SPACE_A))).toEqual(perPlaceExpectation);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation (docs/specs/2026-08-27): third-party events count ONLY
// when venue-confirmed. ADMIN returns them all, flagged, and excludes the
// unconfirmed from conflicts; PUBLIC pushes the same rule into SQL.
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — venue confirmation", () => {
  const ACTOR = "cccccccc-1111-1111-a111-cccccccccccc";
  const SPACE_ID = "dddddddd-1111-1111-a111-dddddddddddd";
  const STAMPED_AT = new Date("2026-03-10T12:00:00Z");
  const adminInput = {
    mode: "admin" as const,
    placeId: PLACE_ID,
    actorHumanId: ACTOR,
    from: new Date("2026-03-01T00:00:00Z"),
    to: new Date("2026-05-01T00:00:00Z"),
  };
  /** Overlapping the venue's own EVENT_ID_1 (20:00–23:00) on the same space. */
  const overlapping = (overrides: Partial<EventRecord>) =>
    makeEvent({
      id: EVENT_ID_2,
      title: "Third-party Night",
      startsAt: new Date("2026-04-01T21:00:00Z"),
      endsAt: new Date("2026-04-02T00:00:00Z"),
      spaceId: SPACE_ID,
      ...overrides,
    });
  const own = () => makeEvent({ id: EVENT_ID_1, spaceId: SPACE_ID });

  it("ADMIN: an UNCONFIRMED third-party event is returned flagged venueConfirmed:false and is ABSENT from conflicts", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [own(), overlapping({ orgId: THIRD_PARTY_ORG_ID })],
    });
    const result = await getVenueCalendar(deps, adminInput);
    expect(result.events.map((e) => [e.eventId, e.venueConfirmed])).toEqual([
      [EVENT_ID_1, true],
      [EVENT_ID_2, false],
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("ADMIN: a STAMPED third-party event is confirmed and conflicts like the venue's own", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [
        own(),
        overlapping({
          orgId: THIRD_PARTY_ORG_ID,
          venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: STAMPED_AT,
          venueConfirmedByHumanId: ACTOR,
          venueConfirmationWithdrawnAt: null,
        }),
      ],
    });
    const result = await getVenueCalendar(deps, adminInput);
    expect(result.events.find((e) => e.eventId === EVENT_ID_2)?.venueConfirmed).toBe(true);
    expect(result.conflicts).toEqual([
      { eventAId: EVENT_ID_1, eventBId: EVENT_ID_2, overlapMinutes: 120 },
    ]);
  });

  it("ADMIN: a WITHDRAWN stamp is unconfirmed — identical to never-confirmed", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [
        own(),
        overlapping({
          orgId: THIRD_PARTY_ORG_ID,
          venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: STAMPED_AT,
          venueConfirmationWithdrawnAt: new Date("2026-03-11T12:00:00Z"),
          venueConfirmationWithdrawnReason: "double booked",
        }),
      ],
    });
    const result = await getVenueCalendar(deps, adminInput);
    expect(result.events.find((e) => e.eventId === EVENT_ID_2)?.venueConfirmed).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  it("ADMIN: venue-owned events (org OR direct human owner) are confirmed by construction without a stamp", async () => {
    const HUMAN_OWNER = "cccccccc-9999-1111-a111-cccccccccccc";
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR, HUMAN_OWNER] }),
      allEvents: [own(), overlapping({ orgId: null, humanId: HUMAN_OWNER })],
    });
    const result = await getVenueCalendar(deps, adminInput);
    expect(result.events.every((e) => e.venueConfirmed)).toBe(true);
    expect(result.conflicts).toHaveLength(1);
  });

  it("venueOwned rides every row so the UI can offer withdraw ONLY on confirmed third-party chips", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [
        // venue-owned (default fixture: event.orgId === the place's org)
        own(),
        // stamped third-party
        overlapping({
          orgId: THIRD_PARTY_ORG_ID,
          venueConfirmedPlaceId: PLACE_ID,
          venueConfirmedAt: STAMPED_AT,
          venueConfirmationWithdrawnAt: null,
        }),
        // unconfirmed third-party
        makeEvent({
          id: "bbbbbbbb-3333-3333-a333-bbbbbbbbbbbb",
          orgId: THIRD_PARTY_ORG_ID,
          startsAt: new Date("2026-04-03T20:00:00Z"),
          endsAt: new Date("2026-04-03T22:00:00Z"),
        }),
      ],
    });
    const result = await getVenueCalendar(deps, adminInput);
    expect(result.events.map((e) => [e.venueOwned, e.venueConfirmed])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);

    // PUBLIC: confirmed-only, but venueOwned is still the real derivation.
    const pub = makeDeps({
      pageResult: makePageResult([
        own(),
        overlapping({ orgId: THIRD_PARTY_ORG_ID, venueConfirmedPlaceId: PLACE_ID, venueConfirmedAt: STAMPED_AT }),
      ]),
    });
    const publicResult = await getVenueCalendar(pub, { mode: "public", placeId: PLACE_ID });
    expect(publicResult.events.map((e) => [e.venueOwned, e.venueConfirmed])).toEqual([
      [true, true],
      [false, true],
    ]);
  });

  it("PUBLIC: passes venueConfirmedFor (the place's owner ids) to the repo and flags every row true", async () => {
    const deps = makeDeps({
      placeById: makePlace({
        orgIdsWithAccess: [VENUE_ORG_ID],
        humanIdsWithAccess: ["cccccccc-9999-1111-a111-cccccccccccc"],
      }),
    });
    const result = await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID });
    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        venueConfirmedFor: {
          orgIds: [VENUE_ORG_ID],
          humanIds: ["cccccccc-9999-1111-a111-cccccccccccc"],
          acceptsCommunityListings: false,
        },
      }),
    );
    expect(result.events.map((e) => e.venueConfirmed)).toEqual([true]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event.calendarId projection (event-calendar-redesign phase 2: filter chips)
// ─────────────────────────────────────────────────────────────────────────────

describe("getVenueCalendar — calendarId on every row", () => {
  const ACTOR = "cccccccc-1111-1111-a111-cccccccccccc";
  const FROM = new Date("2026-03-25T00:00:00Z");
  const TO = new Date("2026-04-20T00:00:00Z");
  const CALENDAR_A = "cccccccc-aaaa-4aaa-8aaa-cccccccccccc";

  it("ADMIN: rows carry Event.calendarId; null when the event is unplaced", async () => {
    const deps = makeDeps({
      placeById: makePlace({ humanIdsWithAccess: [ACTOR] }),
      allEvents: [
        makeEvent({ id: EVENT_ID_1, calendarId: CALENDAR_A }),
        makeEvent({ id: EVENT_ID_2, startsAt: new Date("2026-04-02T20:00:00Z"), endsAt: new Date("2026-04-02T23:00:00Z") }),
      ],
    });

    const result = await getVenueCalendar(deps, {
      mode: "admin",
      placeId: PLACE_ID,
      actorHumanId: ACTOR,
      from: FROM,
      to: TO,
    });

    expect(result.events.map((e) => [e.eventId, e.calendarId])).toEqual([
      [EVENT_ID_1, CALENDAR_A],
      [EVENT_ID_2, null],
    ]);
  });

  it("PUBLIC: same projection (a placement is not an internal)", async () => {
    const deps = makeDeps({
      pageResult: makePageResult([
        makeEvent({ id: EVENT_ID_1, calendarId: CALENDAR_A }),
        makeEvent({ id: EVENT_ID_2, startsAt: new Date("2026-04-02T20:00:00Z"), endsAt: new Date("2026-04-02T23:00:00Z") }),
      ]),
    });

    const result = await getVenueCalendar(deps, { mode: "public", placeId: PLACE_ID, from: FROM, to: TO });

    expect(result.events.map((e) => [e.eventId, e.calendarId])).toEqual([
      [EVENT_ID_1, CALENDAR_A],
      [EVENT_ID_2, null],
    ]);
  });
});
