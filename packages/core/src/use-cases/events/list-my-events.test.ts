import { describe, it, expect, vi, beforeEach } from "vitest";

import { listMyEvents, type ListMyEventsDeps } from "./list-my-events";
import type { EventRecord } from "@th/ports/repos/events";
import type { OffsetPaginatedResult } from "@th/ports/pagination";

// Use valid v4 UUIDs (version nibble = 4, variant nibble = 8-b)
const mockHumanId = "a1111111-1111-4111-a111-111111111111";
const mockOrgId = "b2222222-2222-4222-b222-222222222222";
const mockOtherHumanId = "c3333333-3333-4333-b333-333333333333";
// Event ids must be real UUIDs: the use case parses its output against
// `listMyEventsOutputSchema` (`id: z.string().uuid()`) before returning.
const EVENT_1 = "e1e1e1e1-0001-4001-8001-e1e1e1e1e1e1";
const EVENT_2 = "e2e2e2e2-0002-4002-8002-e2e2e2e2e2e2";

function createMockEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    orgId: null,
    humanId: mockHumanId,
    title: "Test Event",
    status: "DRAFT",
    visibility: "PUBLIC",
    // The real "no gate" value. ("OPEN" is not an EventGateType; the public
    // projector treats any value but NONE as a gate — label only.)
    gateType: "NONE",
    timezone: "America/Chicago",
    startsAt: new Date("2026-03-01T19:00:00Z"),
    endsAt: new Date("2026-03-01T23:00:00Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: "123 Test St",
    countryCode: "US",
    region: "CA",
    locality: "San Francisco",
    postalCode: "94102",
    lat: 37.7749,
    lng: -122.4194,
    slug: "test-event",
    shortId: "abc123",
    regionCode: "US-CA",
    publishedAt: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    defaultLocale: "en",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    refundCutoffAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    body: null,
    ...overrides,
  };
}

function createMockDeps(
  overrides: Partial<ListMyEventsDeps["repos"]> = {},
): ListMyEventsDeps {
  const mockEvents: EventRecord[] = [
    createMockEvent({ id: EVENT_1, title: "Event 1" }),
    createMockEvent({ id: EVENT_2, title: "Event 2", status: "PUBLISHED" }),
  ];

  const paginatedResult: OffsetPaginatedResult<EventRecord> = {
    items: mockEvents,
    pageInfo: {
      total: 2,
      count: 2,
      limit: 50,
      offset: 0,
      hasNextPage: false,
      nextOffset: null,
    },
  };

  return {
    repos: {
      events: {
        listByOwner: vi.fn().mockResolvedValue(paginatedResult),
        getPopularityStats: vi.fn().mockResolvedValue([]),
      },
      eventDates: {
        listByEventIds: vi.fn().mockResolvedValue([]),
      },
      seriesOccurrences: {
        getCalendarInfoForEventIds: vi.fn().mockResolvedValue([]),
      },
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi
          .fn()
          .mockResolvedValue({
            orgId: mockOrgId,
            humanId: mockHumanId,
            role: "ADMIN",
          }),
      },
      places: {
        getById: vi.fn().mockResolvedValue(null),
      },
      ...overrides,
    } as unknown as ListMyEventsDeps["repos"],
    logger: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ListMyEventsDeps["logger"],
  };
}

describe("listMyEvents", () => {
  describe("input validation", () => {
    it("should reject invalid actorHumanId", async () => {
      const deps = createMockDeps();
      await expect(
        listMyEvents(deps, {
          actorHumanId: "not-a-uuid",
          ownerType: "HUMAN",
          ownerId: mockHumanId,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    });

    it("should reject invalid ownerType", async () => {
      const deps = createMockDeps();
      await expect(
        listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "INVALID",
          ownerId: mockHumanId,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    });

    it("should reject limit exceeding max", async () => {
      const deps = createMockDeps();
      await expect(
        listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "HUMAN",
          ownerId: mockHumanId,
          limit: 101,
        }),
      ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
    });
  });

  describe("authorization", () => {
    it("should allow human to list their own events", async () => {
      const deps = createMockDeps();

      const result = await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
      });

      expect(result.items).toHaveLength(2);
      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith({
        ownerType: "HUMAN",
        ownerId: mockHumanId,
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it("should reject human listing another human's events", async () => {
      const deps = createMockDeps();

      await expect(
        listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "HUMAN",
          ownerId: mockOtherHumanId,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });

    // Owner ruling 2026-09-28: an edit-role delegate lists the principal's
    // events (the order-migration target picker in the principal's builder).
    it.each([
      ["EDITOR", true],
      ["VIEWER", false],
    ] as const)(
      "a %s delegate listing the principal's events → allowed=%s",
      async (role, allowed) => {
        const deps = createMockDeps();
        (
          deps.repos.authz.getHumanDelegation as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          orgId: mockOtherHumanId,
          humanId: mockHumanId,
          role,
        });

        const run = listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "HUMAN",
          ownerId: mockOtherHumanId,
        });
        if (allowed) {
          await expect(run).resolves.toBeDefined();
          expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
            expect.objectContaining({
              ownerType: "HUMAN",
              ownerId: mockOtherHumanId,
            }),
          );
        } else {
          await expect(run).rejects.toMatchObject({
            code: "NOT_RESOURCE_OWNER",
          });
        }
      },
    );

    it("should allow org member to list org events", async () => {
      const deps = createMockDeps();
      (
        deps.repos.authz.getOrgMembership as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        orgId: mockOrgId,
        humanId: mockHumanId,
        role: "ADMIN",
      });

      const result = await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "ORGANIZATION",
        ownerId: mockOrgId,
      });

      expect(result.items).toHaveLength(2);
      expect(deps.repos.authz.getOrgMembership).toHaveBeenCalledWith({
        humanId: mockHumanId,
        orgId: mockOrgId,
      });
    });

    it("should reject non-member from listing org events", async () => {
      const deps = createMockDeps();
      (
        deps.repos.authz.getOrgMembership as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      await expect(
        listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "ORGANIZATION",
          ownerId: mockOrgId,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    });
  });

  describe("filtering and pagination", () => {
    it("should pass status filter to repo", async () => {
      const deps = createMockDeps();

      await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
        status: ["DRAFT", "PUBLISHED"],
      });

      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ["DRAFT", "PUBLISHED"],
        }),
      );
    });

    it("should pass pagination params to repo", async () => {
      const deps = createMockDeps();

      await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
        limit: 10,
        offset: 20,
      });

      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          offset: 20,
        }),
      );
    });
  });

  // The repo applies the title/addressText match inside the SAME where-clause
  // it counts, so a searched listing reports a FILTERED pageInfo.total. That
  // is the whole point of doing this server-side: a client-side filter left
  // the admin pager claiming "Rows 1–25 of 128" above two visible rows.
  describe("search query", () => {
    it("should pass the query through to the repo", async () => {
      const deps = createMockDeps();

      await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
        query: "basement",
      });

      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({ query: "basement" }),
      );
    });

    it("should omit the query when absent", async () => {
      const deps = createMockDeps();

      await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
      });

      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({ query: undefined }),
      );
    });

    it("should trim the query before it reaches the repo", async () => {
      const deps = createMockDeps();

      await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
        query: "  basement  ",
      });

      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({ query: "basement" }),
      );
    });

    it("should reject a sub-minimum query (callers must send undefined instead)", async () => {
      const deps = createMockDeps();

      await expect(
        listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "HUMAN",
          ownerId: mockHumanId,
          query: "a",
        }),
      ).rejects.toThrow();
      expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    });

    it("should reject an over-long query (server cap 140)", async () => {
      const deps = createMockDeps();

      await expect(
        listMyEvents(deps, {
          actorHumanId: mockHumanId,
          ownerType: "HUMAN",
          ownerId: mockHumanId,
          query: "x".repeat(141),
        }),
      ).rejects.toThrow();
      expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
    });

    it("should thread the status scope alongside the query", async () => {
      const deps = createMockDeps();

      await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
        status: ["DRAFT"],
        query: "workshop",
      });

      expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({ status: ["DRAFT"], query: "workshop" }),
      );
    });
  });

  describe("output mapping", () => {
    it("should return mapped event items with essential fields", async () => {
      const deps = createMockDeps();

      const result = await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
      });

      expect(result.items[0]).toEqual({
        id: EVENT_1,
        title: "Event 1",
        status: "DRAFT",
        startsAt: expect.any(Date),
        endsAt: expect.any(Date),
        slug: "test-event",
        shortId: "abc123",
        visibility: "PUBLIC",
        addressText: "123 Test St",
        lat: 37.7749,
        lng: -122.4194,
        placeId: null,
        placeName: null,
        ticketsSold: 0,
        totalCapacity: null,
        timezone: "America/Chicago",
        occurrence: null,
        seriesId: null,
        seriesName: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    });

    it("should return pageInfo", async () => {
      const deps = createMockDeps();

      const result = await listMyEvents(deps, {
        actorHumanId: mockHumanId,
        ownerType: "HUMAN",
        ownerId: mockHumanId,
      });

      expect(result.pageInfo).toEqual({
        total: 2,
        limit: 50,
        offset: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });
  });

  // ── event-calendar-redesign FR-001 / FR-002 / FR-003 ─────────────────────
  describe("calendar data (FR-001 timezone, FR-002 totalCapacity, FR-003 expansion)", () => {
    const baseInput = {
      actorHumanId: mockHumanId,
      ownerType: "HUMAN" as const,
      ownerId: mockHumanId,
    };

    it("carries each event's own Event.timezone", async () => {
      const deps = createMockDeps({
        events: {
          listByOwner: vi.fn().mockResolvedValue({
            items: [
              createMockEvent({ id: EVENT_1, timezone: "America/New_York" }),
              createMockEvent({ id: EVENT_2, timezone: "Europe/London" }),
            ],
            pageInfo: { total: 2, count: 2, limit: 50, offset: 0, hasNextPage: false, nextOffset: null },
          }),
          getPopularityStats: vi.fn().mockResolvedValue([]),
        } as unknown as ListMyEventsDeps["repos"]["events"],
      });

      const result = await listMyEvents(deps, baseInput);
      expect(result.items.map((i) => i.timezone)).toEqual([
        "America/New_York",
        "Europe/London",
      ]);
    });

    it("totalCapacity mirrors the SAME getPopularityStats row as ticketsSold — one read, no second query", async () => {
      const deps = createMockDeps();
      (deps.repos.events.getPopularityStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { eventId: EVENT_1, ticketsSold: 42, waitlistCount: 0, totalCapacity: 200 },
        // event-2 has no stats row → capacity is UNKNOWN (null), not 0.
      ]);

      const result = await listMyEvents(deps, baseInput);

      expect(deps.repos.events.getPopularityStats).toHaveBeenCalledTimes(1);
      expect(deps.repos.events.getPopularityStats).toHaveBeenCalledWith([EVENT_1, EVENT_2]);
      expect(result.items.map((i) => [i.id, i.ticketsSold, i.totalCapacity])).toEqual([
        [EVENT_1, 42, 200],
        [EVENT_2, 0, null],
      ]);
    });

    describe("series info (phase-2 grouping/filtering)", () => {
      const SERIES_ID = "5e5e5e5e-0001-4001-8001-5e5e5e5e5e5e";
      const OCC_ID = "0c0c0c0c-0001-4001-8001-0c0c0c0c0c0c";

      it("ONE batched getCalendarInfoForEventIds read per page, keyed by the page's event ids", async () => {
        const deps = createMockDeps();
        await listMyEvents(deps, baseInput);
        expect(deps.repos.seriesOccurrences.getCalendarInfoForEventIds).toHaveBeenCalledTimes(1);
        expect(deps.repos.seriesOccurrences.getCalendarInfoForEventIds).toHaveBeenCalledWith([EVENT_1, EVENT_2]);
      });

      it("rows carry seriesId/seriesName when the repo links them; null otherwise", async () => {
        const deps = createMockDeps();
        (deps.repos.seriesOccurrences.getCalendarInfoForEventIds as ReturnType<typeof vi.fn>).mockResolvedValue([
          { eventId: EVENT_2, seriesId: SERIES_ID, seriesName: "Friday Jazz", occurrenceId: OCC_ID },
        ]);

        const result = await listMyEvents(deps, baseInput);

        expect(result.items.map((i) => [i.id, i.seriesId, i.seriesName])).toEqual([
          [EVENT_1, null, null],
          [EVENT_2, SERIES_ID, "Friday Jazz"],
        ]);
      });

      it("expanded EventDate occurrences inherit the parent event's series info; the read is still one call", async () => {
        const D1 = "dddddddd-0001-4001-8001-dddddddddddd";
        const D2 = "dddddddd-0002-4002-8002-dddddddddddd";
        const deps = createMockDeps();
        (deps.repos.eventDates.listByEventIds as ReturnType<typeof vi.fn>).mockResolvedValue([
          { id: D1, eventId: EVENT_2, ordinal: 1, startsAt: new Date("2026-04-01T19:00:00Z"), endsAt: null, status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
          { id: D2, eventId: EVENT_2, ordinal: 2, startsAt: new Date("2026-04-08T19:00:00Z"), endsAt: null, status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
        ]);
        (deps.repos.seriesOccurrences.getCalendarInfoForEventIds as ReturnType<typeof vi.fn>).mockResolvedValue([
          { eventId: EVENT_2, seriesId: SERIES_ID, seriesName: "Friday Jazz", occurrenceId: OCC_ID },
        ]);

        const result = await listMyEvents(deps, {
          ...baseInput,
          expandDates: true,
          dateRange: { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-04-30T23:59:59Z") },
        });

        expect(result.items.map((i) => [i.id, i.occurrence?.eventDateId ?? null, i.seriesId, i.seriesName])).toEqual([
          [EVENT_1, null, null, null],
          [EVENT_2, D1, SERIES_ID, "Friday Jazz"],
          [EVENT_2, D2, SERIES_ID, "Friday Jazz"],
        ]);
        expect(deps.repos.seriesOccurrences.getCalendarInfoForEventIds).toHaveBeenCalledTimes(1);
      });

      it("skips the series read entirely on an empty page", async () => {
        const deps = createMockDeps({
          events: {
            listByOwner: vi.fn().mockResolvedValue({
              items: [],
              pageInfo: { total: 0, count: 0, limit: 50, offset: 0, hasNextPage: false, nextOffset: null },
            }),
            getPopularityStats: vi.fn().mockResolvedValue([]),
          } as unknown as ListMyEventsDeps["repos"]["events"],
        });
        const result = await listMyEvents(deps, baseInput);
        expect(result.items).toEqual([]);
        expect(deps.repos.seriesOccurrences.getCalendarInfoForEventIds).not.toHaveBeenCalled();
      });
    });

    it("does not touch eventDates unless expandDates is set; every item then has occurrence: null", async () => {
      const deps = createMockDeps();
      const result = await listMyEvents(deps, baseInput);
      expect(deps.repos.eventDates.listByEventIds).not.toHaveBeenCalled();
      expect(result.items.every((i) => i.occurrence === null)).toBe(true);
    });

    it("expandDates: one item per SCHEDULED EventDate with index/total; single-date events unchanged; page order kept", async () => {
      const D1 = "dddddddd-0001-4001-8001-dddddddddddd";
      const D2 = "dddddddd-0002-4002-8002-dddddddddddd";
      const deps = createMockDeps();
      (deps.repos.eventDates.listByEventIds as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: D2, eventId: EVENT_2, ordinal: 2, startsAt: new Date("2026-04-08T19:00:00Z"), endsAt: null, status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
        { id: D1, eventId: EVENT_2, ordinal: 1, startsAt: new Date("2026-04-01T19:00:00Z"), endsAt: new Date("2026-04-01T22:00:00Z"), status: "SCHEDULED", createdAt: new Date(), updatedAt: new Date() },
        { id: "dddddddd-0009-4009-8009-dddddddddddd", eventId: EVENT_2, ordinal: 3, startsAt: new Date("2026-04-15T19:00:00Z"), endsAt: null, status: "CANCELLED", createdAt: new Date(), updatedAt: new Date() },
      ]);
      (deps.repos.events.getPopularityStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { eventId: EVENT_2, ticketsSold: 7, waitlistCount: 0, totalCapacity: 50 },
      ]);

      // `expandDates` requires a bounded window (see the schema refinement);
      // this one spans every fixture row so nothing here is trimmed.
      const result = await listMyEvents(deps, {
        ...baseInput,
        expandDates: true,
        dateRange: {
          from: new Date("2026-03-01T00:00:00Z"),
          to: new Date("2026-04-30T23:59:59Z"),
        },
      });

      expect(deps.repos.eventDates.listByEventIds).toHaveBeenCalledWith({
        eventIds: [EVENT_1, EVENT_2],
        statuses: ["SCHEDULED"],
      });
      expect(result.items.map((i) => [i.id, i.occurrence, i.startsAt?.toISOString()])).toEqual([
        [EVENT_1, null, "2026-03-01T19:00:00.000Z"],
        [EVENT_2, { index: 1, total: 2, eventDateId: D1 }, "2026-04-01T19:00:00.000Z"],
        [EVENT_2, { index: 2, total: 2, eventDateId: D2 }, "2026-04-08T19:00:00.000Z"],
      ]);
      // Sold/capacity are per EVENT, repeated on each of its nights.
      expect(result.items.slice(1).map((i) => [i.ticketsSold, i.totalCapacity])).toEqual([
        [7, 50],
        [7, 50],
      ]);
      // Pagination stays event-shaped.
      expect(result.pageInfo.total).toBe(2);
    });

    // A two-year-old weekly listing has 100+ SCHEDULED rows. Without a window
    // every one of them lands on the page ("Date 3 of 160" × 160 items).
    describe("dateRange", () => {
      const D = (n: number) =>
        `dddddddd-${String(n).padStart(4, "0")}-4001-8001-dddddddddddd`;
      const weekly = Array.from({ length: 12 }, (_, i) => ({
        id: D(i + 1),
        eventId: EVENT_2,
        ordinal: i + 1,
        startsAt: new Date(Date.UTC(2026, 3, 1 + i * 7, 19)),
        endsAt: null,
        status: "SCHEDULED" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      it("threads dateRange to the repo AND trims expanded nights to it; index/total stay ABSOLUTE", async () => {
        const deps = createMockDeps();
        (deps.repos.eventDates.listByEventIds as ReturnType<typeof vi.fn>).mockResolvedValue(weekly);
        const from = new Date("2026-05-01T00:00:00Z");
        const to = new Date("2026-05-31T23:59:59Z");

        const result = await listMyEvents(deps, {
          ...baseInput,
          expandDates: true,
          dateRange: { from, to },
        });

        // Repo arm: the same inclusive window on Event.startsAt.
        expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
          expect.objectContaining({ dateRange: { from, to } }),
        );
        // Rows fall on Apr 1 + 7·(n−1); May 2026 holds rows 6–9 (May 6, 13,
        // 20, 27). Only those are emitted, yet each still reads "Date N of 12".
        const nights = result.items.filter((i) => i.id === EVENT_2);
        expect(nights.map((i) => i.occurrence)).toEqual([
          { index: 6, total: 12, eventDateId: D(6) },
          { index: 7, total: 12, eventDateId: D(7) },
          { index: 8, total: 12, eventDateId: D(8) },
          { index: 9, total: 12, eventDateId: D(9) },
        ]);
        expect(nights.every((i) => i.startsAt! >= from && i.startsAt! <= to)).toBe(true);
        // The row-less event (repo-bounded) passes through untouched.
        expect(result.items.filter((i) => i.id === EVENT_1)).toHaveLength(1);
      });

      // The expansion has no row cap of its own — 100 events x every
      // scheduled night each — so an expanding read MUST bound both ends.
      // Rejected at the input boundary, before any repo read.
      it.each([
        ["no dateRange", undefined],
        ["from only", { from: new Date("2026-05-01T00:00:00Z") }],
        ["to only", { to: new Date("2026-05-31T23:59:59Z") }],
      ] as const)(
        "expandDates with %s is rejected (expand_dates_requires_bounded_date_range)",
        async (_label, dateRange) => {
          const deps = createMockDeps();

          await expect(
            listMyEvents(deps, {
              ...baseInput,
              expandDates: true,
              ...(dateRange ? { dateRange } : {}),
            }),
          ).rejects.toEqual(
            expect.objectContaining({
              code: "invalid_input",
              issues: [
                expect.objectContaining({
                  path: ["dateRange"],
                  message: "expand_dates_requires_bounded_date_range",
                }),
              ],
            }),
          );
          expect(deps.repos.events.listByOwner).not.toHaveBeenCalled();
        },
      );

      it("without expandDates, dateRange stays optional and half-open (table/picker callers unchanged)", async () => {
        const deps = createMockDeps();

        await expect(listMyEvents(deps, baseInput)).resolves.toBeDefined();
        await expect(
          listMyEvents(deps, { ...baseInput, expandDates: false }),
        ).resolves.toBeDefined();
        expect(deps.repos.events.listByOwner).toHaveBeenLastCalledWith(
          expect.objectContaining({ dateRange: undefined }),
        );
      });

      // The pin of a weekly listing mirrors only its FIRST upcoming night. A
      // month navigator two months out must still admit it, so the expanding
      // caller asks the repo to match on a SCHEDULED night as well.
      it("expandDates + dateRange: the repo receives includeDateOccurrences: true", async () => {
        const deps = createMockDeps();
        const from = new Date("2026-05-01T00:00:00Z");
        const to = new Date("2026-05-31T23:59:59Z");

        await listMyEvents(deps, { ...baseInput, expandDates: true, dateRange: { from, to } });

        expect(deps.repos.events.listByOwner).toHaveBeenCalledWith(
          expect.objectContaining({ dateRange: { from, to }, includeDateOccurrences: true }),
        );
      });

      it("without expandDates the repo argument carries NO includeDateOccurrences key (key-identical for table/picker callers)", async () => {
        const deps = createMockDeps();
        const from = new Date("2026-05-01T00:00:00Z");

        await listMyEvents(deps, { ...baseInput, dateRange: { from } });
        await listMyEvents(deps, { ...baseInput, expandDates: false, dateRange: { from } });

        const calls = (deps.repos.events.listByOwner as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toHaveLength(2);
        // `toHaveBeenCalledWith` treats an `undefined` value as equal to an
        // absent key, so pin the KEY itself.
        for (const [arg] of calls) {
          expect(Object.keys(arg)).not.toContain("includeDateOccurrences");
        }
      });

      it("half-open ranges are accepted; an unknown key inside dateRange is rejected (strict)", async () => {
        const deps = createMockDeps();
        await expect(
          listMyEvents(deps, { ...baseInput, dateRange: { from: new Date("2026-05-01T00:00:00Z") } }),
        ).resolves.toBeDefined();
        await expect(
          listMyEvents(deps, { ...baseInput, dateRange: { from: new Date(), tz: "UTC" } }),
        ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
      });
    });
  });
});

// ── M4: where a withheld event is, by role ─────────────────────────────────
// ANY org role may list the org's events; only the edit roles may see the
// stored street / pin of a withheld one. For a freeform OBSCURED event the
// row IS the house; for a venue event the venue is the floor.
describe("location by role (M4)", () => {
  const HOUSE_STREET = "1417 Shelby Ave, Nashville, TN 37206";
  const HOUSE_LAT = 36.1775;
  const HOUSE_LNG = -86.7412;
  const VENUE_ID = "d4d4d4d4-0004-4004-8004-d4d4d4d4d4d4";
  const EXACT_EVENT = "e3e3e3e3-0003-4003-8003-e3e3e3e3e3e3";

  /** Freeform, OBSCURED (a NEVER reveal is the same row). */
  const freeformObscured = createMockEvent({
    id: EVENT_1,
    orgId: mockOrgId,
    humanId: null,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East side",
    addressText: HOUSE_STREET,
    locality: "Nashville",
    region: "TN",
    postalCode: "37206",
    lat: HOUSE_LAT,
    lng: HOUSE_LNG,
  } as Partial<EventRecord>);
  /** Stored EXACT at a venue that has since withheld its address. */
  const atWithheldVenue = createMockEvent({
    id: EVENT_2,
    orgId: mockOrgId,
    humanId: null,
    placeId: VENUE_ID,
    locationMode: "EXACT",
    addressText: HOUSE_STREET,
    locality: "Nashville",
    region: "TN",
    lat: HOUSE_LAT,
    lng: HOUSE_LNG,
  } as Partial<EventRecord>);
  /** A public, EXACT event — unchanged for every role. */
  const exactEvent = createMockEvent({
    id: EXACT_EVENT,
    orgId: mockOrgId,
    humanId: null,
    locationMode: "EXACT",
    addressText: "1 Broadway, Nashville, TN 37203",
    lat: 36.16,
    lng: -86.77,
  } as Partial<EventRecord>);

  const VENUE = {
    id: VENUE_ID,
    name: "The Shelby House",
    locationMode: "OBSCURED",
    locationRadiusMeters: 1000,
    locationLabel: "Near Five Points",
    formattedAddress: HOUSE_STREET,
    addressLine1: "1417 Shelby Ave",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: HOUSE_LAT,
    lng: HOUSE_LNG,
  };

  function depsFor(
    role: string,
    placeGetById: (id: string) => Promise<unknown> = async () => VENUE,
  ) {
    return createMockDeps({
      events: {
        listByOwner: vi.fn().mockResolvedValue({
          items: [freeformObscured, atWithheldVenue, exactEvent],
          pageInfo: {
            total: 3,
            count: 3,
            limit: 50,
            offset: 0,
            hasNextPage: false,
            nextOffset: null,
          },
        }),
        getPopularityStats: vi.fn().mockResolvedValue([]),
      },
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi.fn().mockResolvedValue({
          orgId: mockOrgId,
          humanId: mockHumanId,
          role,
        }),
      },
      places: { getById: vi.fn(placeGetById) },
    } as unknown as Partial<ListMyEventsDeps["repos"]>);
  }

  const orgInput = {
    actorHumanId: mockHumanId,
    ownerType: "ORGANIZATION" as const,
    ownerId: mockOrgId,
  };

  function expectNoTruth(
    items: Array<{ addressText: string | null; lat: number | null; lng: number | null }>,
  ) {
    for (const item of items) {
      expect(JSON.stringify(item)).not.toContain("Shelby Ave");
      expect(JSON.stringify(item)).not.toContain("37206");
      expect(item.lat).not.toBe(HOUSE_LAT);
      expect(item.lng).not.toBe(HOUSE_LNG);
    }
  }

  it.each(["SCANNER", "VIEWER", "FINANCE"])(
    "%s gets the public projection — no street, no true point",
    async (role) => {
      const result = await listMyEvents(depsFor(role), orgInput);
      const [freeform, venueEvent, exact] = result.items;

      expectNoTruth([freeform!, venueEvent!]);
      // The area label a public card prints, and the keyed circle centre.
      expect(freeform!.addressText).toBe("East side");
      expect(freeform!.lat).not.toBeNull();
      expect(freeform!.lng).not.toBeNull();
      // The venue floor wins over the stale EXACT row: the venue's label.
      expect(venueEvent!.addressText).toBe("Near Five Points");
      // A public EXACT event is unchanged.
      expect(exact).toMatchObject({
        addressText: "1 Broadway, Nashville, TN 37203",
        lat: 36.16,
        lng: -86.77,
      });
      // Everything else about the row is still there.
      expect(venueEvent).toMatchObject({
        placeId: VENUE_ID,
        placeName: "The Shelby House",
      });
    },
  );

  it.each(["OWNER", "ADMIN", "EDITOR"])(
    "%s gets the stored row",
    async (role) => {
      const result = await listMyEvents(depsFor(role), orgInput);
      const [freeform, venueEvent] = result.items;

      expect(freeform).toMatchObject({
        addressText: HOUSE_STREET,
        lat: HOUSE_LAT,
        lng: HOUSE_LNG,
      });
      expect(venueEvent).toMatchObject({
        addressText: HOUSE_STREET,
        lat: HOUSE_LAT,
        lng: HOUSE_LNG,
      });
    },
  );

  it("the HUMAN owner (the actor themself) gets the stored row", async () => {
    const deps = depsFor("SCANNER");
    const result = await listMyEvents(deps, {
      actorHumanId: mockHumanId,
      ownerType: "HUMAN",
      ownerId: mockHumanId,
    });
    expect(result.items[0]).toMatchObject({
      addressText: HOUSE_STREET,
      lat: HOUSE_LAT,
    });
  });

  it("a venue that is GONE projects as fully hidden below the edit bar, never as 'no venue'", async () => {
    const result = await listMyEvents(
      depsFor("SCANNER", async () => null),
      orgInput,
    );
    const venueEvent = result.items[1]!;
    expectNoTruth([venueEvent]);
    expect(venueEvent.lat).toBeNull();
    expect(venueEvent.lng).toBeNull();
    expect(venueEvent.placeName).toBeNull();
  });
});
