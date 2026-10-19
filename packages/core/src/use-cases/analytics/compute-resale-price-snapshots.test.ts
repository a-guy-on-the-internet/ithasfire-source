import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventsRepo } from "@th/ports/repos/events";
import type { AnalyticsRepo } from "@th/ports/repos/analytics";
import type { ResaleListingsRepo } from "@th/ports/repos/resale-listings";
import type {
  CompletedResalePrice,
  EventRecord,
  EventTicketTypeSummary,
  EventDailyStatsRecord,
  UpsertResalePriceSnapshotInput,
} from "@th/types";

import {
  computeResalePriceSnapshots,
  type ComputeResalePriceSnapshotsInput,
} from "./compute-resale-price-snapshots";

// ── Helpers ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-01T12:00:00Z");

function makeEvent(partial: Partial<EventRecord> = {}): EventRecord {
  const base: Record<string, unknown> = {
    id: "event-1",
    title: "Resale Concert",
    slug: "resale-concert",
    orgId: "org-1",
    humanId: "human-1",
    status: "PUBLISHED",
    startsAt: new Date("2026-03-15T20:00:00Z"), // ~14 days from NOW
    endsAt: new Date("2026-03-16T02:00:00Z"),
    visibility: "PUBLIC",
    placeId: null,
    categoryId: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    timezone: "America/New_York",
    resalePayoutTermsId: "pt-1", // resale enabled
    listingPriority: null,
  };
  for (const [k, v] of Object.entries(partial)) {
    base[k] = v;
  }
  return base as unknown as EventRecord;
}

function makeTicketType(
  partial: Partial<EventTicketTypeSummary> = {},
): EventTicketTypeSummary {
  return {
    id: "tt-1",
    name: "General Admission",
    priceCents: 5000,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 200,
    status: "ON_SALE",
    seatSectionId: null,
    resaleAllowed: true,
    resaleCapCents: null,
    transferAllowed: true,
    ...partial,
  };
}

function makeDailyStats(
  partial: Partial<EventDailyStatsRecord> = {},
): EventDailyStatsRecord {
  return {
    id: "ds-1",
    eventId: "event-1",
    date: new Date("2026-03-01"),
    grossRevenueCents: 250000,
    netRevenueCents: 250000,
    refundedCents: 0,
    ticketsSold: 100,
    ticketsRefunded: 0,
    ticketsTransferred: 0,
    totalCapacity: 200,
    sellThroughRate: 0.5,
    orderCount: 80,
    refundCount: 0,
    ticketTypeStats: [
      {
        ticketTypeId: "tt-1",
        name: "General Admission",
        sold: 100,
        refunded: 0,
        capacity: 200,
        sellThrough: 0.5,
        revenueCents: 250000,
      },
    ],
    waitlistCount: 5,
    createdAt: new Date("2026-03-01"),
    updatedAt: new Date("2026-03-01"),
    ...partial,
  };
}

function makeContext(overrides?: {
  events?: EventRecord[];
  ticketTypesByEvent?: Record<string, EventTicketTypeSummary[]>;
  dailyStatsByEvent?: Record<string, EventDailyStatsRecord | null>;
  /** Map of `${eventId}:${ticketTypeId}` → completed resale prices. Defaults to empty arrays. */
  completedResalePrices?: Record<string, CompletedResalePrice[]>;
  batchUpsertReturn?: number;
}) {
  const events = overrides?.events ?? [makeEvent()];
  const ticketTypesByEvent = overrides?.ticketTypesByEvent ?? {
    "event-1": [makeTicketType()],
  };
  const dailyStatsByEvent = overrides?.dailyStatsByEvent ?? {
    "event-1": makeDailyStats(),
  };
  const completedResalePrices = overrides?.completedResalePrices ?? {};
  const batchUpsertReturn = overrides?.batchUpsertReturn;

  const eventsRepo: EventsRepo = {
    listPublished: vi.fn(async () => ({
      items: events,
      total: events.length,
      limit: 10_000,
      offset: 0,
    })),
    listTicketTypes: vi.fn(
      async (eventId: string) => ticketTypesByEvent[eventId] ?? [],
    ),
    listTicketTypesForEventIds: vi.fn(async (eventIds: string[]) =>
      eventIds.flatMap((eid) =>
        (ticketTypesByEvent[eid] ?? []).map((tt) => ({ ...tt, eventId: eid })),
      ),
    ),
  } as unknown as EventsRepo;

  const analyticsRepo: AnalyticsRepo = {
    getTicketSalesRollup: vi.fn(async () => []),
    getLatestDailyStats: vi.fn(
      async (eventId: string) => dailyStatsByEvent[eventId] ?? null,
    ),
    getLatestDailyStatsBatch: vi.fn(async (eventIds: string[]) =>
      eventIds
        .map((eid) => dailyStatsByEvent[eid])
        .filter((s): s is NonNullable<typeof s> => s != null),
    ),
    upsertResaleSnapshotBatch: vi.fn(
      async (inputs: UpsertResalePriceSnapshotInput[]) =>
        batchUpsertReturn ?? inputs.length,
    ),
    upsertDailyStats: vi.fn(),
    upsertDailyStatsBatch: vi.fn(async () => 0),
    getDailyStats: vi.fn(async () => null),
    upsertResaleSnapshot: vi.fn(),
    getLatestResaleSnapshot: vi.fn(async () => null),
    getLatestResaleSnapshotsBatch: vi.fn(async () => []),
    listResaleSnapshots: vi.fn(async () => []),
    getPlatformStats: vi.fn(async () => ({
      totalOrders: 0,
      totalSucceededOrders: 0,
      totalGrossRevenueCents: 0,
      totalPlatformFeesCents: 0,
      totalEvents: 0,
      totalTicketsSold: 0,
      totalHumans: 0,
      totalOrganizations: 0,
    })),
  };

  const resaleListingsRepo: Pick<
    ResaleListingsRepo,
    "getCompletedResalePrices"
  > = {
    getCompletedResalePrices: vi.fn(
      async (eventId: string, ticketTypeId: string) => {
        const key = `${eventId}:${ticketTypeId}`;
        return completedResalePrices[key] ?? [];
      },
    ),
  };

  const repos: Repos = {
    events: eventsRepo,
    analytics: analyticsRepo,
    resaleListings: resaleListingsRepo,
    tx: vi.fn(async (fn) => fn(repos as any)),
  } as unknown as Repos;

  const clock: ClockPort = { now: () => NOW };
  const logger: LoggerPort = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_name: string, f: () => Promise<unknown>) => f()),
  };

  return {
    repos,
    clock,
    logger,
    eventsRepo,
    analyticsRepo,
    resaleListingsRepo,
  };
}

const DEFAULT_INPUT: ComputeResalePriceSnapshotsInput = {
  lookaheadDays: 180,
  minSampleSize: 3,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("computeResalePriceSnapshots", () => {
  it("produces heuristic snapshots for resale-enabled events", async () => {
    const ctx = makeContext();
    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(1);
    expect(result.snapshotsUpserted).toBe(1);
    expect(result.heuristicCount).toBe(1);
    expect(result.dataBackedCount).toBe(0);

    expect(ctx.analyticsRepo.upsertResaleSnapshotBatch).toHaveBeenCalledTimes(
      1,
    );
    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].eventId).toBe("event-1");
    expect(batch[0].ticketTypeId).toBe("tt-1");
    expect(batch[0].source).toBe("heuristic");
    expect(batch[0].facePriceCents).toBe(5000);
    expect(batch[0].suggestedPriceCents).toBeGreaterThan(0);
  });

  it("skips events without resalePayoutTermsId", async () => {
    const ctx = makeContext({
      events: [makeEvent({ resalePayoutTermsId: null })],
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(0);
    expect(result.snapshotsUpserted).toBe(0);
  });

  it("skips ticket types where resaleAllowed is false", async () => {
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ resaleAllowed: false })],
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(1);
    expect(result.heuristicCount).toBe(0);
    expect(result.snapshotsUpserted).toBe(0);
  });

  it("skips ticket types with priceCents of 0 (free)", async () => {
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ priceCents: 0 })],
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.heuristicCount).toBe(0);
  });

  // The resale cap is per ticket: the type's cap lifted to that ticket's own
  // price (owner ruling 2026-10-10, seat-price-overrides spec Q-001). A row
  // here has no ticket, so the estimate is stored as computed and its reader
  // (`estimateResalePrice`) clamps for the ticket it is asked about.
  it("stores the heuristic estimate unclamped and records the type's cap beside it", async () => {
    // Event 5 days away with high sell-through → 1.15 × 1.3 = 1.495
    const event = makeEvent({ startsAt: new Date("2026-03-06T20:00:00Z") });
    const tt = makeTicketType({
      priceCents: 10000,
      resaleCapCents: 8000, // cap below face value
    });
    const stats = makeDailyStats({
      sellThroughRate: 0.95,
      ticketTypeStats: [
        {
          ticketTypeId: "tt-1",
          name: "GA",
          sold: 190,
          refunded: 0,
          capacity: 200,
          sellThrough: 0.95,
          revenueCents: 950000,
        },
      ],
    });

    const ctx = makeContext({
      events: [event],
      ticketTypesByEvent: { "event-1": [tt] },
      dailyStatsByEvent: { "event-1": stats },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].suggestedPriceCents).toBe(14950);
    expect(batch[0].resaleCapCents).toBe(8000);
  });

  it("falls back to 0.5 sell-through when no daily stats exist", async () => {
    const ctx = makeContext({
      dailyStatsByEvent: { "event-1": null },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.heuristicCount).toBe(1);
    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].sellThroughRate).toBe(0.5);
  });

  it("uses per-ticket-type sell-through from daily stats when available", async () => {
    const stats = makeDailyStats({
      sellThroughRate: 0.4, // overall
      ticketTypeStats: [
        {
          ticketTypeId: "tt-1",
          name: "GA",
          sold: 160,
          refunded: 0,
          capacity: 200,
          sellThrough: 0.8, // per-type is higher
          revenueCents: 800000,
        },
      ],
    });

    const ctx = makeContext({ dailyStatsByEvent: { "event-1": stats } });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].sellThroughRate).toBe(0.8);
  });

  it("falls back to overall sell-through when ticket type not in stats", async () => {
    const stats = makeDailyStats({
      sellThroughRate: 0.6,
      ticketTypeStats: [
        {
          ticketTypeId: "tt-other", // different ticket type
          name: "VIP",
          sold: 30,
          refunded: 0,
          capacity: 50,
          sellThrough: 0.6,
          revenueCents: 300000,
        },
      ],
    });

    const ctx = makeContext({ dailyStatsByEvent: { "event-1": stats } });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].sellThroughRate).toBe(0.6);
  });

  it("skips events already past (startsAt < now)", async () => {
    const ctx = makeContext({
      events: [makeEvent({ startsAt: new Date("2026-02-28T00:00:00Z") })], // yesterday
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(0);
  });

  it("processes multiple events and ticket types", async () => {
    const events = [
      makeEvent({ id: "e1", startsAt: new Date("2026-03-15") }),
      makeEvent({ id: "e2", startsAt: new Date("2026-04-01") }),
    ];

    const ctx = makeContext({
      events,
      ticketTypesByEvent: {
        e1: [
          makeTicketType({ id: "tt-a", priceCents: 5000 }),
          makeTicketType({ id: "tt-b", priceCents: 10000 }),
        ],
        e2: [makeTicketType({ id: "tt-c", priceCents: 3000 })],
      },
      dailyStatsByEvent: {
        e1: makeDailyStats({ eventId: "e1" }),
        e2: makeDailyStats({ eventId: "e2" }),
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(2);
    expect(result.heuristicCount).toBe(3);
    expect(result.snapshotsUpserted).toBe(3);
  });

  it("demand tier is 'high' for event 10 days away with 70% sell-through", async () => {
    const event = makeEvent({ startsAt: new Date("2026-03-11T20:00:00Z") }); // ~10 days
    const stats = makeDailyStats({
      sellThroughRate: 0.7,
      ticketTypeStats: [
        {
          ticketTypeId: "tt-1",
          name: "GA",
          sold: 140,
          refunded: 0,
          capacity: 200,
          sellThrough: 0.7,
          revenueCents: 700000,
        },
      ],
    });

    const ctx = makeContext({
      events: [event],
      dailyStatsByEvent: { "event-1": stats },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].demandTier).toBe("high");
  });

  it("demand tier is 'low' for event > 60 days away", async () => {
    const event = makeEvent({ startsAt: new Date("2026-06-01T20:00:00Z") }); // ~92 days
    const ctx = makeContext({
      events: [event],
      dailyStatsByEvent: { "event-1": makeDailyStats() },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].demandTier).toBe("low");
  });

  it("multiplier is capped at 0.5x minimum", async () => {
    // Event > 30 days away + very low sell-through → timeFactor 0.95 * sellFactor 0.75 = 0.7125
    // That stays above 0.5 so let's use an extreme: daysUntilEvent < 1 → 0.7 * 0.75 = 0.525
    const event = makeEvent({ startsAt: new Date("2026-03-01T18:00:00Z") }); // 6 hours from now
    const stats = makeDailyStats({
      ticketTypeStats: [
        {
          ticketTypeId: "tt-1",
          name: "GA",
          sold: 20,
          refunded: 0,
          capacity: 200,
          sellThrough: 0.1, // very low
          revenueCents: 100000,
        },
      ],
    });

    const ctx = makeContext({
      events: [event],
      dailyStatsByEvent: { "event-1": stats },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    // 0.7 * 0.75 = 0.525, clamp to max(0.5, 0.525) = 0.525
    // 5000 * 0.525 = 2625
    expect(batch[0].suggestedPriceCents).toBe(2625);
  });

  // ── Data-backed pricing tests ────────────────────────────────────────────

  it("uses data-backed median when enough completed resales exist (odd sample)", async () => {
    const ctx = makeContext({
      completedResalePrices: {
        "event-1:tt-1": [
          { askPriceCents: 6000, completedAt: new Date("2026-02-28") },
          { askPriceCents: 7000, completedAt: new Date("2026-02-27") },
          { askPriceCents: 5500, completedAt: new Date("2026-02-26") },
        ],
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      { ...DEFAULT_INPUT, minSampleSize: 3 },
    );

    expect(result.dataBackedCount).toBe(1);
    expect(result.heuristicCount).toBe(0);

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    // Sorted: [5500, 6000, 7000] → median = 6000 (middle of odd-length)
    expect(batch[0].suggestedPriceCents).toBe(6000);
    expect(batch[0].source).toBe("data");
    expect(batch[0].sampleSize).toBe(3);
  });

  it("uses data-backed median for even sample size (averages middle two)", async () => {
    const ctx = makeContext({
      completedResalePrices: {
        "event-1:tt-1": [
          { askPriceCents: 4000, completedAt: new Date("2026-02-28") },
          { askPriceCents: 6000, completedAt: new Date("2026-02-27") },
          { askPriceCents: 7000, completedAt: new Date("2026-02-26") },
          { askPriceCents: 9000, completedAt: new Date("2026-02-25") },
        ],
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      { ...DEFAULT_INPUT, minSampleSize: 3 },
    );

    expect(result.dataBackedCount).toBe(1);

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    // Sorted: [4000, 6000, 7000, 9000] → median = (6000 + 7000) / 2 = 6500
    expect(batch[0].suggestedPriceCents).toBe(6500);
    expect(batch[0].source).toBe("data");
    expect(batch[0].sampleSize).toBe(4);
  });

  it("falls back to heuristic when below minSampleSize", async () => {
    const ctx = makeContext({
      completedResalePrices: {
        "event-1:tt-1": [
          { askPriceCents: 6000, completedAt: new Date("2026-02-28") },
          { askPriceCents: 7000, completedAt: new Date("2026-02-27") },
        ],
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      { ...DEFAULT_INPUT, minSampleSize: 3 },
    );

    expect(result.dataBackedCount).toBe(0);
    expect(result.heuristicCount).toBe(1);

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].source).toBe("heuristic");
    expect(batch[0].sampleSize).toBe(2); // records the available samples
    expect(batch[0].suggestedPriceCents).toBeGreaterThan(0);
  });

  // The $50-seat case: a $30 type capped at $35 whose seats with a $50 seat
  // price override resold around $48. The row must keep 4800 for the holder of
  // such a seat (cap 5000); the holder of a plain $30 ticket is clamped to
  // 3500 at read (estimate-resale-price.test.ts).
  it("stores the data-backed median unclamped when it is above the type's cap", async () => {
    const tt = makeTicketType({
      priceCents: 3000,
      resaleCapCents: 3500, // cap below the median
    });

    const ctx = makeContext({
      ticketTypesByEvent: { "event-1": [tt] },
      completedResalePrices: {
        "event-1:tt-1": [
          { askPriceCents: 4600, completedAt: new Date("2026-02-28") },
          { askPriceCents: 4800, completedAt: new Date("2026-02-27") },
          { askPriceCents: 5000, completedAt: new Date("2026-02-26") },
        ],
      },
    });

    const result = await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      { ...DEFAULT_INPUT, minSampleSize: 3 },
    );

    expect(result.dataBackedCount).toBe(1);

    const batch = (
      ctx.analyticsRepo.upsertResaleSnapshotBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    // Sorted: [4600, 4800, 5000] → median = 4800, above the type's 3500 cap
    expect(batch[0].suggestedPriceCents).toBe(4800);
    expect(batch[0].resaleCapCents).toBe(3500);
    expect(batch[0].facePriceCents).toBe(3000);
    expect(batch[0].source).toBe("data");
  });

  it("calls getCompletedResalePrices for each resale-enabled ticket type", async () => {
    const events = [makeEvent({ id: "e1" }), makeEvent({ id: "e2" })];

    const ctx = makeContext({
      events,
      ticketTypesByEvent: {
        e1: [makeTicketType({ id: "tt-a" }), makeTicketType({ id: "tt-b" })],
        e2: [makeTicketType({ id: "tt-c" })],
      },
      dailyStatsByEvent: {
        e1: makeDailyStats({ eventId: "e1" }),
        e2: makeDailyStats({ eventId: "e2" }),
      },
    });

    await computeResalePriceSnapshots(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    const fn = ctx.resaleListingsRepo.getCompletedResalePrices as ReturnType<
      typeof vi.fn
    >;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenCalledWith("e1", "tt-a", 30);
    expect(fn).toHaveBeenCalledWith("e1", "tt-b", 30);
    expect(fn).toHaveBeenCalledWith("e2", "tt-c", 30);
  });
});
