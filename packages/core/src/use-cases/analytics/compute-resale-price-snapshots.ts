import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type {
  DemandTier,
  SnapshotSource,
  UpsertResalePriceSnapshotInput,
} from "@th/types";

import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";

// ── Schemas ────────────────────────────────────────────────────────────────

export const computeResalePriceSnapshotsInputSchema = z.object({
  /** Only process events starting within this many days from now. */
  lookaheadDays: z.number().int().min(1).max(365).default(180),
  /**
   * Minimum completed resale transactions to use data-backed pricing.
   * Below this threshold, the heuristic is used instead.
   */
  minSampleSize: z.number().int().min(1).default(3),
});

export type ComputeResalePriceSnapshotsInput = z.infer<
  typeof computeResalePriceSnapshotsInputSchema
>;

export interface ComputeResalePriceSnapshotsResult {
  eventsProcessed: number;
  snapshotsUpserted: number;
  dataBackedCount: number;
  heuristicCount: number;
  durationMs: number;
}

export type ComputeResalePriceSnapshotsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger: LoggerPort;
};

// ── Heuristic pricing (shared with estimate-resale-price use-case) ─────────

function computeHeuristicPrice(
  facePriceCents: number,
  daysUntilEvent: number,
  sellThroughRate: number,
): { estimatedCents: number; demandTier: DemandTier } {
  // Time factor: peaks when event is 3-14 days away
  let timeFactor: number;
  if (daysUntilEvent < 1) timeFactor = 0.7;
  else if (daysUntilEvent < 3) timeFactor = 0.85;
  else if (daysUntilEvent < 7) timeFactor = 1.15;
  else if (daysUntilEvent < 14) timeFactor = 1.25;
  else if (daysUntilEvent < 30) timeFactor = 1.1;
  else timeFactor = 0.95;

  // Sell-through factor
  let sellFactor: number;
  if (sellThroughRate > 0.9) sellFactor = 1.3;
  else if (sellThroughRate > 0.7) sellFactor = 1.15;
  else if (sellThroughRate > 0.5) sellFactor = 1.0;
  else if (sellThroughRate > 0.3) sellFactor = 0.9;
  else sellFactor = 0.75;

  const multiplier = Math.min(1.5, Math.max(0.5, timeFactor * sellFactor));
  const estimatedCents = Math.round(facePriceCents * multiplier);

  // Demand tier
  let demandTier: DemandTier;
  if (daysUntilEvent < 3) {
    demandTier = sellThroughRate > 0.7 ? "medium" : "low";
  } else if (daysUntilEvent < 14) {
    demandTier = sellThroughRate > 0.6 ? "high" : "medium";
  } else if (daysUntilEvent < 60) {
    demandTier = sellThroughRate > 0.8 ? "high" : "medium";
  } else {
    demandTier = "low";
  }

  return { estimatedCents, demandTier };
}

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Nightly batch: computes suggested resale prices for every ticket type on
 * upcoming resale-enabled events and stores them as ResalePriceSnapshot rows.
 *
 * The use-case reads EventDailyStats for sell-through data (computed by the
 * event-daily-stats job that runs earlier in the schedule). When the daily
 * stats row is missing, it falls back to a placeholder sell-through of 0.5.
 *
 * When enough resale transaction history exists (>= minSampleSize), the
 * suggested price is a rolling median of completed resale ask prices.
 * Otherwise, the heuristic (time-to-event x sell-through) is used.
 *
 * `suggestedPriceCents` is stored WITHOUT the resale cap applied: the cap is
 * per ticket (`effectiveResaleCapCents`) and a row here has no ticket. Its
 * reader, `estimateResalePrice`, clamps for the ticket it is asked about.
 */
export async function computeResalePriceSnapshots(
  { repos, clock, logger }: ComputeResalePriceSnapshotsDeps,
  raw: ComputeResalePriceSnapshotsInput,
): Promise<ComputeResalePriceSnapshotsResult> {
  const input = computeResalePriceSnapshotsInputSchema.parse(raw);
  const startTime = Date.now();
  const now = clock.now();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + input.lookaheadDays);

  logger.info("compute-resale-snapshots.start", {
    lookaheadDays: input.lookaheadDays,
    minSampleSize: input.minSampleSize,
  });

  // 1. Fetch published upcoming events
  const eventPage = await repos.events.listPublished({
    limit: 10_000,
    offset: 0,
  });

  // Filter to upcoming events with resale enabled
  const events = eventPage.items.filter((e) => {
    const startsAt = new Date(e.startsAt);
    return (
      startsAt >= now && startsAt <= windowEnd && e.resalePayoutTermsId != null
    );
  });

  if (events.length === 0) {
    logger.info("compute-resale-snapshots.no-resale-events");
    return {
      eventsProcessed: 0,
      snapshotsUpserted: 0,
      dataBackedCount: 0,
      heuristicCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  let dataBackedCount = 0;
  let heuristicCount = 0;
  const snapshots: UpsertResalePriceSnapshotInput[] = [];

  // Bulk-fetch daily stats and ticket types for all events in two queries
  const eventIds = events.map((e) => e.id);
  const [allDailyStats, allTicketTypes] = await Promise.all([
    repos.analytics.getLatestDailyStatsBatch(eventIds),
    repos.events.listTicketTypesForEventIds(eventIds),
  ]);

  // Build lookup maps
  const dailyStatsMap = new Map(allDailyStats.map((s) => [s.eventId, s]));
  const ticketTypesByEvent = new Map<string, typeof allTicketTypes>();
  for (const tt of allTicketTypes) {
    const arr = ticketTypesByEvent.get(tt.eventId) ?? [];
    arr.push(tt);
    ticketTypesByEvent.set(tt.eventId, arr);
  }

  for (const event of events) {
    const startsAt = new Date(event.startsAt);
    const daysUntilEvent = Math.max(
      0,
      (startsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Get sell-through from pre-fetched daily stats
    const dailyStats = dailyStatsMap.get(event.id) ?? null;

    const ticketTypes = ticketTypesByEvent.get(event.id) ?? [];

    for (const tt of ticketTypes) {
      if (!tt.resaleAllowed) continue;

      // ── DECISION (FR-004, spec Phase 0 flagged this site) ────────────────
      // This basis is LIVE, and stays live — but "live" means the price
      // resolved at `now`, not the raw stored `priceCents`.
      //
      // Why live rather than historical: every other `priceCents` read fixed by
      // this spec (resale face value FR-001, wallet passes FR-002) was answering
      // "what did THIS buyer pay for THIS ticket?", where the only correct
      // source is the snapshot on OrderItem.unitPriceCents (NFR-003). This one
      // asks a different question — "what should we SUGGEST a seller ask for a
      // ticket to this event, tomorrow?" — and it is not per-ticket at all: the
      // snapshot is keyed (eventId, ticketTypeId, date) with no order or ticket
      // in sight, and it is multiplied by a forward-looking time × sell-through
      // heuristic. Anchoring a forward-looking suggestion to a historical price
      // would suggest early-bird-based asks for the rest of the event's life.
      //
      // Why the resolver rather than the raw field: on the night after a flip,
      // `priceCents` is the price nobody can buy any more. A suggestion built on
      // it would systematically under-suggest for every scheduled tier, and
      // `facePriceCents` is persisted on the snapshot and shown to sellers as
      // context — so it would also display a number that contradicts the ticket
      // page. `clock.now()` is already the batch's single instant.
      //
      // Consequence, accepted: the snapshot is NOT a historical face-value
      // ledger and must never be read as one. FR-001's fix reads
      // OrderItem.unitPriceCents for that, and this file writes nothing that
      // feeds the markup split.
      const facePriceCents = resolveUnitPriceCents(tt, { now });
      if (facePriceCents === 0) continue;

      const capacity = tt.capacity ?? 0;
      const resaleCapCents = tt.resaleCapCents ?? null;

      // Try to get per-type sell-through from daily stats
      let sellThroughRate = 0.5; // default fallback
      if (dailyStats?.ticketTypeStats) {
        const ttStat = dailyStats.ticketTypeStats.find(
          (s) => s.ticketTypeId === tt.id,
        );
        if (ttStat) {
          sellThroughRate = ttStat.sellThrough;
        } else {
          sellThroughRate = dailyStats.sellThroughRate;
        }
      }

      // ── Data-backed pricing: prefer rolling median of completed resales ──
      const resaleTxns = await repos.resaleListings.getCompletedResalePrices(
        event.id,
        tt.id,
        30,
      );

      let source: SnapshotSource;
      let sampleSize: number;
      let estimatedCents: number;
      let demandTier: DemandTier;

      if (resaleTxns.length >= input.minSampleSize) {
        // Use median of completed ask prices
        const sorted = resaleTxns
          .map((t) => t.askPriceCents)
          .sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        estimatedCents =
          sorted.length % 2 === 1
            ? sorted[mid]!
            : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);

        source = "data";
        sampleSize = resaleTxns.length;

        // Derive demand tier from sell-through even for data-backed prices
        const heuristic = computeHeuristicPrice(
          facePriceCents,
          daysUntilEvent,
          sellThroughRate,
        );
        demandTier = heuristic.demandTier;

        dataBackedCount++;
      } else {
        // Not enough data — fall back to heuristic
        source = "heuristic";
        sampleSize = resaleTxns.length;
        const heuristic = computeHeuristicPrice(
          facePriceCents,
          daysUntilEvent,
          sellThroughRate,
        );
        estimatedCents = heuristic.estimatedCents;
        demandTier = heuristic.demandTier;
        heuristicCount++;
      }

      // NOT clamped to the resale cap here. The cap applies per ticket: the
      // type's cap, lifted to that ticket's own price (owner ruling
      // 2026-10-10, seat-price-overrides spec Q-001; the rule lives in
      // `effectiveResaleCapCents`). This row is keyed (event, ticket type,
      // date) and has no ticket, so a clamp here could only be the type's cap
      // on its own, and it would throw away the estimate that the holder of a
      // seat priced above the cap is allowed to ask. The reader that knows the
      // ticket (`estimateResalePrice`) clamps. `resaleCapCents` on the row
      // stays the TYPE's own cap, as context.
      const suggestedPriceCents = estimatedCents;

      snapshots.push({
        eventId: event.id,
        ticketTypeId: tt.id,
        date: today,
        suggestedPriceCents,
        facePriceCents,
        resaleCapCents,
        demandTier,
        sellThroughRate: Math.round(sellThroughRate * 100) / 100,
        sampleSize,
        source,
      });
    }
  }

  // 4. Batch upsert
  const snapshotsUpserted =
    snapshots.length > 0
      ? await repos.analytics.upsertResaleSnapshotBatch(snapshots)
      : 0;

  const durationMs = Date.now() - startTime;
  logger.info("compute-resale-snapshots.completed", {
    eventsProcessed: events.length,
    snapshotsUpserted,
    dataBackedCount,
    heuristicCount,
    durationMs,
  });

  return {
    eventsProcessed: events.length,
    snapshotsUpserted,
    dataBackedCount,
    heuristicCount,
    durationMs,
  };
}
