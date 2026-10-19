import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventsRepo } from "@th/ports/repos/events";
import type { AnalyticsRepo } from "@th/ports/repos/analytics";
import type {
  EventRecord,
  EventTicketTypeSummary,
  EventPopularityStats,
  TicketSalesRollupRow,
} from "@th/types";

import {
  computeEventDailyStats,
  type ComputeEventDailyStatsInput,
} from "./compute-event-daily-stats";

// ── Helpers ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-03-01T12:00:00Z");

function makeEvent(partial: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "event-1",
    title: "Test Event",
    slug: "test-event",
    orgId: "org-1",
    humanId: "human-1",
    status: "PUBLISHED" as const,
    startsAt: new Date("2026-04-01T20:00:00Z"), // 31 days from NOW — within default window
    endsAt: new Date("2026-04-02T02:00:00Z"),
    visibility: "PUBLIC" as any,
    placeId: null,
    categoryId: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    timezone: "America/New_York",
    resalePayoutTermsId: null,
    listingPriority: null,
    ...partial,
  } as EventRecord;
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
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    ...partial,
  };
}

function makePopStats(
  partial: Partial<EventPopularityStats> = {},
): EventPopularityStats {
  return {
    eventId: "event-1",
    ticketsSold: 100,
    waitlistCount: 10,
    totalCapacity: 200,
    ...partial,
  };
}

function makeRollup(
  partial: Partial<TicketSalesRollupRow> = {},
): TicketSalesRollupRow {
  // NOTE: `revenueCents` covers the SOLD lines only — it is already net of
  // refunds, because the rollup partitions lines into sold vs refunded.
  return {
    eventId: "event-1",
    ticketTypeId: "tt-1",
    soldCount: 100,
    refundedCount: 0,
    revenueCents: 100 * 5000,
    refundedCents: 0,
    ...partial,
  };
}

function makeContext(overrides?: {
  events?: EventRecord[];
  ticketTypesByEvent?: Record<string, EventTicketTypeSummary[]>;
  popStats?: EventPopularityStats[];
  rollup?: TicketSalesRollupRow[];
  batchUpsertReturn?: number;
}) {
  const events = overrides?.events ?? [makeEvent()];
  const ticketTypesByEvent = overrides?.ticketTypesByEvent ?? {
    "event-1": [makeTicketType()],
  };
  const popStats = overrides?.popStats ?? [makePopStats()];
  const rollup = overrides?.rollup ?? [makeRollup()];
  const batchUpsertReturn = overrides?.batchUpsertReturn ?? events.length;

  const eventsRepo: EventsRepo = {
    listPublished: vi.fn(async () => ({
      items: events,
      total: events.length,
      limit: 10_000,
      offset: 0,
    })),
    getPopularityStats: vi.fn(async () => popStats),
    listTicketTypes: vi.fn(
      async (eventId: string) => ticketTypesByEvent[eventId] ?? [],
    ),
  } as unknown as EventsRepo;

  const analyticsRepo: AnalyticsRepo = {
    getTicketSalesRollup: vi.fn(async () => rollup),
    upsertDailyStatsBatch: vi.fn(async () => batchUpsertReturn),
    getLatestDailyStats: vi.fn(async () => null),
    getLatestDailyStatsBatch: vi.fn(async () => []),
    getDailyStats: vi.fn(async () => null),
    upsertDailyStats: vi.fn(),
    upsertResaleSnapshot: vi.fn(),
    upsertResaleSnapshotBatch: vi.fn(async () => 0),
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
    // Unused here, but the annotation above claims this object IS an
    // AnalyticsRepo. Test files are excluded from every typecheck config, so
    // an incomplete mock is invisible rather than caught — keep it honest.
    getOrgDashboardSummary: vi.fn(async () => ({
      totalGrossRevenueCents: 0,
      totalNetRevenueCents: 0,
      totalTicketsSold: 0,
      averageSellThroughRate: 0,
      totalRefundedCents: 0,
      refundRate: 0,
      eventCount: 0,
    })),
  };

  const repos: Repos = {
    events: eventsRepo,
    analytics: analyticsRepo,
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

  return { repos, clock, logger, eventsRepo, analyticsRepo };
}

/** Runs the use case and returns the batch handed to `upsertDailyStatsBatch`. */
async function runAndGetBatch(ctx: ReturnType<typeof makeContext>) {
  await computeEventDailyStats(
    { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
    DEFAULT_INPUT,
  );
  return (ctx.analyticsRepo.upsertDailyStatsBatch as ReturnType<typeof vi.fn>)
    .mock.calls[0][0];
}

const DEFAULT_INPUT: ComputeEventDailyStatsInput = {
  lookbackDays: 90,
  lookaheadDays: 180,
  limit: 0,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("computeEventDailyStats", () => {
  it("processes events in window and upserts daily stats", async () => {
    const ctx = makeContext();
    const result = await computeEventDailyStats(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(1);
    expect(result.rowsUpserted).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(ctx.analyticsRepo.upsertDailyStatsBatch).toHaveBeenCalledTimes(1);
    const batchArg = (
      ctx.analyticsRepo.upsertDailyStatsBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batchArg).toHaveLength(1);
    expect(batchArg[0].eventId).toBe("event-1");
    expect(batchArg[0].ticketsSold).toBe(100);
    expect(batchArg[0].waitlistCount).toBe(10);
  });

  it("returns zero when no events match the window", async () => {
    // Event far in the past — outside 90-day lookback
    const ctx = makeContext({
      events: [makeEvent({ startsAt: new Date("2024-01-01T00:00:00Z") })],
    });
    const result = await computeEventDailyStats(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(0);
    expect(result.rowsUpserted).toBe(0);
    expect(ctx.analyticsRepo.upsertDailyStatsBatch).not.toHaveBeenCalled();
  });

  // These four replace a test that asserted the OLD behaviour — an even split
  // of event sales across tiers ("80 sold / 2 types = 40 each"). That test
  // passed because it encoded the bug as the expectation.
  it("uses REAL per-tier sold counts, not an even split across tiers", async () => {
    const ttA = makeTicketType({
      id: "tt-a",
      name: "VIP",
      priceCents: 10000,
      capacity: 50,
    });
    const ttB = makeTicketType({
      id: "tt-b",
      name: "GA",
      priceCents: 3000,
      capacity: 150,
    });

    // Lopsided on purpose: VIP sold out, GA sold 30. An even split would
    // report 40/40 and would be wrong in BOTH directions at once.
    const ctx = makeContext({
      ticketTypesByEvent: { "event-1": [ttA, ttB] },
      popStats: [makePopStats({ ticketsSold: 80, totalCapacity: 200 })],
      rollup: [
        makeRollup({ ticketTypeId: "tt-a", soldCount: 50, revenueCents: 50 * 10000 }),
        makeRollup({ ticketTypeId: "tt-b", soldCount: 30, revenueCents: 30 * 3000 }),
      ],
    });

    const batch = await runAndGetBatch(ctx);
    expect(batch[0].ticketTypeStats).toHaveLength(2);

    expect(batch[0].ticketTypeStats[0].name).toBe("VIP");
    expect(batch[0].ticketTypeStats[0].sold).toBe(50);
    expect(batch[0].ticketTypeStats[1].name).toBe("GA");
    expect(batch[0].ticketTypeStats[1].sold).toBe(30);

    // Sell-through is per-tier real too: VIP is sold out, GA is 30/150.
    expect(batch[0].ticketTypeStats[0].sellThrough).toBe(1);
    expect(batch[0].ticketTypeStats[1].sellThrough).toBe(0.2);
  });

  it("derives revenue from the purchase snapshot, NOT the live ticket price", async () => {
    // The tier's live price is 9999 — a later edit, or a scheduled flip. The
    // rollup says the tickets actually sold for 2000 each. Revenue must follow
    // what was charged. `sold * priceCents` would report 199_980.
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ id: "tt-1", priceCents: 9999 })],
      },
      rollup: [
        makeRollup({ ticketTypeId: "tt-1", soldCount: 20, revenueCents: 40_000 }),
      ],
    });

    const batch = await runAndGetBatch(ctx);

    expect(batch[0].ticketTypeStats[0].revenueCents).toBe(40_000);
    expect(batch[0].grossRevenueCents).toBe(40_000);
    // Guard the specific wrong answer, so a regression to the live price is
    // named rather than just "not 40000".
    expect(batch[0].grossRevenueCents).not.toBe(20 * 9999);
  });

  // Asserted as the money identity `gross === net + refunded`, NOT as whatever
  // the code happens to compute. `revenueCents` and `refundedCents` partition
  // the ticket lines, so the rollup total is already net; an earlier version
  // subtracted refunds from it a second time and this test passed because its
  // expectations were derived from that code.
  it("reports refunds per tier without double-subtracting them", async () => {
    // 13 tickets at $50 were sold and paid for: 10 still valid, 3 refunded.
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ id: "tt-1", priceCents: 5000 })],
      },
      rollup: [
        makeRollup({
          ticketTypeId: "tt-1",
          soldCount: 10,
          revenueCents: 50_000,
          refundedCount: 3,
          refundedCents: 15_000,
        }),
      ],
    });

    const batch = await runAndGetBatch(ctx);
    const row = batch[0];

    expect(row.ticketsSold).toBe(10);
    expect(row.ticketsRefunded).toBe(3);
    expect(row.grossRevenueCents).toBe(65_000); // everything collected
    expect(row.refundedCents).toBe(15_000);
    expect(row.netRevenueCents).toBe(50_000); // what the organiser kept
    expect(row.grossRevenueCents).toBe(row.netRevenueCents + row.refundedCents);
    expect(row.ticketTypeStats[0].refunded).toBe(3);
  });

  it("keeps net positive and the refund rate <= 1 when most of an event refunds", async () => {
    // The case that exposes a double-subtraction: 1 of 10 tickets survives.
    // A gross that already excludes refunds would report net -40_000 here, and
    // the org dashboard divides refunded by net to get a refund rate.
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ id: "tt-1", priceCents: 5000 })],
      },
      rollup: [
        makeRollup({
          ticketTypeId: "tt-1",
          soldCount: 1,
          revenueCents: 5_000,
          refundedCount: 9,
          refundedCents: 45_000,
        }),
      ],
    });

    const row = (await runAndGetBatch(ctx))[0];

    expect(row.grossRevenueCents).toBe(50_000);
    expect(row.netRevenueCents).toBe(5_000);
    expect(row.netRevenueCents).toBeGreaterThan(0);
    expect(row.refundedCents / row.grossRevenueCents).toBeLessThanOrEqual(1);
  });

  it("counts still-valid tickets that getPopularityStats drops", async () => {
    // The headline semantics change: `ticketsSold` comes from the order
    // snapshot, not `pop.ticketsSold` (which counts only 'active' items on
    // SUCCEEDED orders, so a partially-refunded order contributes nothing).
    // Every other fixture sets the two equal, which would let a regression to
    // `pop.ticketsSold` pass unnoticed — so here they disagree on purpose.
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ id: "tt-1", priceCents: 5000 })],
      },
      popStats: [makePopStats({ ticketsSold: 3, totalCapacity: 200 })],
      rollup: [
        makeRollup({
          ticketTypeId: "tt-1",
          soldCount: 10,
          revenueCents: 50_000,
          refundedCount: 2,
          refundedCents: 10_000,
        }),
      ],
    });

    const row = (await runAndGetBatch(ctx))[0];

    expect(row.ticketsSold).toBe(10);
    expect(row.ticketsSold).not.toBe(3);
  });

  it("keeps sales against a deleted tier in the event totals", async () => {
    // Deleting a tier nulls OrderItem.ticketTypeId (the FK is ON DELETE SET
    // NULL), so its sales survive with no tier to name. They must still count:
    // dropping them would shrink an event's revenue when an organizer tidies
    // up. Defensive rather than routine — deleteTicketType refuses once
    // tickets have been issued — hence a null key, not a dangling id.
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [makeTicketType({ id: "tt-1", priceCents: 5000 })],
      },
      rollup: [
        makeRollup({ ticketTypeId: "tt-1", soldCount: 4, revenueCents: 20_000 }),
        makeRollup({ ticketTypeId: null, soldCount: 2, revenueCents: 9_000 }),
      ],
    });

    const batch = await runAndGetBatch(ctx);

    // No per-tier row — there is no tier to name — so the breakdown
    // deliberately does not sum to the event totals.
    expect(batch[0].ticketTypeStats).toHaveLength(1);
    expect(batch[0].ticketsSold).toBe(6);
    expect(batch[0].grossRevenueCents).toBe(29_000);
  });

  it("keeps each event's sales in its own row", async () => {
    // Nothing else pins that the rollup is partitioned by eventId: every other
    // multi-event fixture leaves both events with no matching rollup rows, so
    // a bug leaking one event's sales into another would pass silently.
    const events = [
      makeEvent({ id: "e1", startsAt: new Date("2026-04-01") }),
      makeEvent({ id: "e2", startsAt: new Date("2026-05-01") }),
    ];

    const ctx = makeContext({
      events,
      ticketTypesByEvent: {
        e1: [makeTicketType({ id: "tt-e1" })],
        e2: [makeTicketType({ id: "tt-e2" })],
      },
      popStats: events.map((e) => makePopStats({ eventId: e.id })),
      rollup: [
        makeRollup({
          eventId: "e1",
          ticketTypeId: "tt-e1",
          soldCount: 5,
          revenueCents: 25_000,
        }),
        makeRollup({
          eventId: "e2",
          ticketTypeId: "tt-e2",
          soldCount: 40,
          revenueCents: 120_000,
        }),
      ],
      batchUpsertReturn: 2,
    });

    const batch = await runAndGetBatch(ctx);

    expect(batch[0].eventId).toBe("e1");
    expect(batch[0].ticketsSold).toBe(5);
    expect(batch[0].grossRevenueCents).toBe(25_000);
    expect(batch[1].eventId).toBe("e2");
    expect(batch[1].ticketsSold).toBe(40);
    expect(batch[1].grossRevenueCents).toBe(120_000);
  });

  it("reports zero for a tier with no sales rather than omitting it", async () => {
    const ctx = makeContext({
      ticketTypesByEvent: {
        "event-1": [
          makeTicketType({ id: "tt-1", name: "GA" }),
          makeTicketType({ id: "tt-2", name: "VIP", capacity: 10 }),
        ],
      },
      rollup: [
        makeRollup({ ticketTypeId: "tt-1", soldCount: 5, revenueCents: 25_000 }),
      ],
    });

    const batch = await runAndGetBatch(ctx);

    expect(batch[0].ticketTypeStats).toHaveLength(2);
    expect(batch[0].ticketTypeStats[1].name).toBe("VIP");
    expect(batch[0].ticketTypeStats[1].sold).toBe(0);
    expect(batch[0].ticketTypeStats[1].revenueCents).toBe(0);
    expect(batch[0].ticketTypeStats[1].sellThrough).toBe(0);
  });

  it("respects the limit parameter", async () => {
    const events = [
      makeEvent({ id: "event-1", startsAt: new Date("2026-03-15") }),
      makeEvent({ id: "event-2", startsAt: new Date("2026-03-20") }),
      makeEvent({ id: "event-3", startsAt: new Date("2026-03-25") }),
    ];

    const ctx = makeContext({
      events,
      popStats: events.map((e) => makePopStats({ eventId: e.id })),
      ticketTypesByEvent: {
        "event-1": [makeTicketType()],
        "event-2": [makeTicketType()],
        "event-3": [makeTicketType()],
      },
    });

    // listPublished is called with the limit param
    const result = await computeEventDailyStats(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      { lookbackDays: 90, lookaheadDays: 180, limit: 2 },
    );

    // The limit is applied to the query, but all returned events in window are processed
    expect(ctx.eventsRepo.listPublished).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2 }),
    );
  });

  it("handles events with no ticket types", async () => {
    const ctx = makeContext({
      ticketTypesByEvent: { "event-1": [] },
      popStats: [makePopStats({ ticketsSold: 0, totalCapacity: 0 })],
      rollup: [],
    });

    const result = await computeEventDailyStats(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(1);

    const batch = (
      ctx.analyticsRepo.upsertDailyStatsBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch[0].ticketTypeStats).toHaveLength(0);
    expect(batch[0].sellThroughRate).toBe(0);
  });

  it("computes sell-through rate correctly", async () => {
    const ctx = makeContext({
      ticketTypesByEvent: { "event-1": [makeTicketType({ capacity: 100 })] },
      popStats: [makePopStats({ ticketsSold: 80, totalCapacity: 100 })],
      rollup: [
        makeRollup({ ticketTypeId: "tt-1", soldCount: 80, revenueCents: 400_000 }),
      ],
    });

    const batch = await runAndGetBatch(ctx);
    // 80 really sold against a capacity of 100.
    expect(batch[0].sellThroughRate).toBe(0.8);
  });

  it("processes multiple events and batches correctly", async () => {
    const events = [
      makeEvent({ id: "e1", startsAt: new Date("2026-04-01") }),
      makeEvent({ id: "e2", startsAt: new Date("2026-05-01") }),
    ];

    const ctx = makeContext({
      events,
      ticketTypesByEvent: {
        e1: [makeTicketType({ id: "tt-e1" })],
        e2: [makeTicketType({ id: "tt-e2" })],
      },
      popStats: [
        makePopStats({ eventId: "e1", ticketsSold: 50 }),
        makePopStats({ eventId: "e2", ticketsSold: 120 }),
      ],
      batchUpsertReturn: 2,
    });

    const result = await computeEventDailyStats(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      DEFAULT_INPUT,
    );

    expect(result.eventsProcessed).toBe(2);
    expect(result.rowsUpserted).toBe(2);

    const batch = (
      ctx.analyticsRepo.upsertDailyStatsBatch as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(batch).toHaveLength(2);
    expect(batch[0].eventId).toBe("e1");
    expect(batch[1].eventId).toBe("e2");
  });
});
