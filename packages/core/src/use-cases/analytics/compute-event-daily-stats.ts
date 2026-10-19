import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type {
  TicketSalesRollupRow,
  TicketTypeStatsEntry,
  UpsertEventDailyStatsInput,
} from "@th/types";

// ── Schemas ────────────────────────────────────────────────────────────────

export const computeEventDailyStatsInputSchema = z.object({
  /** Only process events whose startsAt is within [now - lookbackDays, now + lookaheadDays]. */
  lookbackDays: z.number().int().min(0).max(365).default(90),
  lookaheadDays: z.number().int().min(0).max(365).default(180),
  /** Limit number of events processed per run (0 = no limit). */
  limit: z.number().int().min(0).default(0),
});

export type ComputeEventDailyStatsInput = z.infer<
  typeof computeEventDailyStatsInputSchema
>;

export interface ComputeEventDailyStatsResult {
  eventsProcessed: number;
  rowsUpserted: number;
  durationMs: number;
}

export type ComputeEventDailyStatsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Nightly batch: computes daily stats for all active events and upserts them
 * into the EventDailyStats table.
 *
 * This is designed to be called by the job handler — it does not wrap itself
 * in a transaction because batch operations run outside the hot path and can
 * tolerate partial writes (idempotent upserts).
 *
 * REVENUE COMES FROM THE PURCHASE SNAPSHOT, NOT THE LIVE PRICE. Sold counts,
 * refunds and revenue all come from `analytics.getTicketSalesRollup`, which
 * aggregates `OrderItem.unitPriceCents`. This replaced two stacked
 * approximations that were wrong independently of each other:
 *
 *   1. `perTypeSold = Math.round(sold / ticketTypes.length)` — an EVEN SPLIT
 *      of the event's total sales across its tiers. A sold-out $100 VIP tier
 *      alongside an empty $10 GA tier reported half the sales to each.
 *   2. `perTypeSold * tt.priceCents` — historical revenue derived from the
 *      LIVE price, so every manual price edit (and now every scheduled flip)
 *      silently restated revenue that had already been earned.
 *
 * Routing (2) through `resolveUnitPriceCents` would NOT have fixed it — it
 * would apply today's resolved price to yesterday's sales, which is wrong in a
 * new way. The snapshot is the only correct basis. See
 * `packages/core/src/lib/orders/__tests__/price-read-invariant.test.ts`.
 *
 * SEMANTICS OF A ROW. Each row is a CUMULATIVE-TO-DATE snapshot stamped with
 * today's date, not that day's incremental sales. This is load-bearing:
 * `getOrgDashboardSummary` sums the LATEST row per event, which is only
 * meaningful if each row is a running total. Do not convert this to per-day
 * deltas without changing that consumer.
 */
export async function computeEventDailyStats(
  { repos, clock, logger }: ComputeEventDailyStatsDeps,
  raw: ComputeEventDailyStatsInput,
): Promise<ComputeEventDailyStatsResult> {
  const input = computeEventDailyStatsInputSchema.parse(raw);
  const startTime = Date.now();
  const now = clock.now();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - input.lookbackDays);
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + input.lookaheadDays);

  logger.info("compute-event-daily-stats.start", {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  });

  // 1. Fetch published events in the time window
  const eventPage = await repos.events.listPublished({
    limit: input.limit || 10_000,
    offset: 0,
  });

  // Filter to events within the window
  const events = eventPage.items.filter((e) => {
    const startsAt = new Date(e.startsAt);
    return startsAt >= windowStart && startsAt <= windowEnd;
  });

  if (events.length === 0) {
    logger.info("compute-event-daily-stats.no-events");
    return {
      eventsProcessed: 0,
      rowsUpserted: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const eventIds = events.map((e) => e.id);

  // 2. Popularity stats supply the WAITLIST only. Sold counts, revenue and
  //    capacity all come from sources that agree with each other below —
  //    deliberately NOT from `pop.ticketsSold`, which counts only 'active'
  //    items on SUCCEEDED orders and so drops every still-valid ticket on a
  //    partially-refunded order. Using it for the total while deriving per-tier
  //    counts from the rollup would leave the row internally inconsistent,
  //    which is worse than either number alone.
  const popStats = await repos.events.getPopularityStats(eventIds);
  const popMap = new Map(popStats.map((s) => [s.eventId, s]));

  // 3. Realised sales per (event, ticketType), from OrderItem.unitPriceCents.
  //    One batched query for the whole run.
  const rollup = await repos.analytics.getTicketSalesRollup(eventIds);
  const rollupByEvent = new Map<
    string,
    Map<string | null, TicketSalesRollupRow>
  >();
  for (const row of rollup) {
    let byType = rollupByEvent.get(row.eventId);
    if (!byType) {
      byType = new Map();
      rollupByEvent.set(row.eventId, byType);
    }
    byType.set(row.ticketTypeId, row);
  }

  // 4. For each event, compute full stats using ticket type breakdown
  const statsInputs: UpsertEventDailyStatsInput[] = [];

  // Process in batches of 100
  const batchSize = 100;
  for (let i = 0; i < eventIds.length; i += batchSize) {
    const batchIds = eventIds.slice(i, i + batchSize);

    for (const eventId of batchIds) {
      const pop = popMap.get(eventId);
      const ticketTypes = await repos.events.listTicketTypes(eventId);
      const salesByType = rollupByEvent.get(eventId);

      // Build per-ticket-type stats
      const ttStats: TicketTypeStatsEntry[] = [];
      let totalSold = 0;
      let totalRefunded = 0;
      let totalCapacity = 0;
      let totalRevenue = 0;
      let totalRefundedCents = 0;

      for (const tt of ticketTypes) {
        const capacity = tt.capacity ?? 0;
        // A tier with no sales is absent from the rollup, not zero-valued —
        // it still gets a row here so the breakdown lists every tier.
        const sales = salesByType?.get(tt.id);
        const sold = sales?.soldCount ?? 0;
        const refunded = sales?.refundedCount ?? 0;
        const revenue = sales?.revenueCents ?? 0;
        const refundedCents = sales?.refundedCents ?? 0;

        const sellThrough = capacity > 0 ? Math.min(1, sold / capacity) : 0;

        ttStats.push({
          ticketTypeId: tt.id,
          name: tt.name ?? "Unknown",
          sold,
          refunded,
          capacity,
          sellThrough: Math.round(sellThrough * 100) / 100,
          revenueCents: revenue,
        });

        totalSold += sold;
        totalRefunded += refunded;
        totalCapacity += capacity;
        totalRevenue += revenue;
        totalRefundedCents += refundedCents;
      }

      // Sales whose tier no longer exists still happened and still took money.
      // The rollup keys them under a null ticketTypeId (ON DELETE SET NULL), and
      // a tier could also be absent from `listTicketTypes` for other reasons.
      // Either way, fold them into the event totals rather than letting revenue
      // silently shrink when a tier is removed; they get no row in the per-tier
      // breakdown because there is no tier to name. So `sum(ticketTypeStats)`
      // deliberately does NOT have to equal the event totals.
      if (salesByType) {
        const listedTypeIds = new Set(ticketTypes.map((tt) => tt.id));
        for (const [ticketTypeId, sales] of salesByType) {
          if (ticketTypeId !== null && listedTypeIds.has(ticketTypeId)) continue;
          totalSold += sales.soldCount;
          totalRefunded += sales.refundedCount;
          totalRevenue += sales.revenueCents;
          totalRefundedCents += sales.refundedCents;
        }
      }

      // Capacity comes from the LOCAL sum, not `pop.totalCapacity`, because the
      // numerator now spans every tier the rollup saw (including archived ones)
      // while `getPopularityStats` counts only ACTIVE tiers. Mixing them shrinks
      // the denominator without shrinking the numerator: an event with a
      // sold-out-then-archived early-bird tier reported 70/100 instead of
      // 70/150, which is enough to cross the 0.7 demand threshold that moves
      // suggested resale prices. Both the rate and the stored field use this
      // one number so they cannot disagree — the old code computed the rate
      // from the local sum but stored `pop.totalCapacity`.
      const overallSellThrough =
        totalCapacity > 0 ? Math.min(1, totalSold / totalCapacity) : 0;

      // `revenueCents` and `refundedCents` partition the ticket lines, so the
      // rollup total is already NET of refunds. Gross has to add refunds back;
      // subtracting them from it would remove the same money twice and could
      // drive net negative and the org dashboard's refundRate above 1.
      const grossRevenueCents = totalRevenue + totalRefundedCents;

      statsInputs.push({
        eventId,
        date: today,
        grossRevenueCents,
        netRevenueCents: totalRevenue,
        refundedCents: totalRefundedCents,
        ticketsSold: totalSold,
        ticketsRefunded: totalRefunded,
        ticketsTransferred: 0,
        totalCapacity,
        sellThroughRate: Math.round(overallSellThrough * 100) / 100,
        orderCount: 0,
        refundCount: 0,
        ticketTypeStats: ttStats,
        waitlistCount: pop?.waitlistCount ?? 0,
      });
    }
  }

  // 5. Batch upsert
  const rowsUpserted = await repos.analytics.upsertDailyStatsBatch(statsInputs);

  const durationMs = Date.now() - startTime;
  logger.info("compute-event-daily-stats.completed", {
    eventsProcessed: events.length,
    rowsUpserted,
    durationMs,
  });

  return { eventsProcessed: events.length, rowsUpserted, durationMs };
}
