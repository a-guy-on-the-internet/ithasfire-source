import type {
  EventDailyStatsRecord,
  UpsertEventDailyStatsInput,
  ResalePriceSnapshotRecord,
  UpsertResalePriceSnapshotInput,
  PlatformStatsResult,
  PlatformRevenueByCurrency,
  OrgDashboardSummary,
  TicketSalesRollupRow,
} from "@th/types";

export interface AnalyticsRepo {
  // ── Realised sales ──────────────────────────────────────────────────────

  /**
   * Per-(event, ticketType) realised sales, aggregated from paid OrderItem
   * ticket lines. Cumulative to date — NOT scoped to a single day.
   *
   * This is the only correct basis for historical revenue: it sums the
   * `unitPriceCents` snapshot written at purchase instead of multiplying a
   * count by the live `TicketType.priceCents`. Ticket types with no sales are
   * absent from the result; callers must treat "missing" as zero rather than
   * skipping the tier.
   */
  getTicketSalesRollup(eventIds: string[]): Promise<TicketSalesRollupRow[]>;

  // ── EventDailyStats ─────────────────────────────────────────────────────

  /** Upsert a single day's stats for an event. Idempotent on (eventId, date). */
  upsertDailyStats(
    input: UpsertEventDailyStatsInput,
  ): Promise<EventDailyStatsRecord>;

  /** Batch-upsert daily stats. Returns count of rows written. */
  upsertDailyStatsBatch(inputs: UpsertEventDailyStatsInput[]): Promise<number>;

  /** Get the latest daily stats row for an event (most recent date). */
  getLatestDailyStats(eventId: string): Promise<EventDailyStatsRecord | null>;

  /**
   * Batch-fetch the latest daily stats for multiple events in a single query.
   * Returns one record per event (the most recent date), keyed by eventId.
   */
  getLatestDailyStatsBatch(
    eventIds: string[],
  ): Promise<EventDailyStatsRecord[]>;

  /** Get daily stats for a specific event + date. */
  getDailyStats(
    eventId: string,
    date: Date,
  ): Promise<EventDailyStatsRecord | null>;

  // ── ResalePriceSnapshot ─────────────────────────────────────────────────

  /** Upsert a resale price snapshot. Idempotent on (eventId, ticketTypeId, date). */
  upsertResaleSnapshot(
    input: UpsertResalePriceSnapshotInput,
  ): Promise<ResalePriceSnapshotRecord>;

  /** Batch-upsert resale snapshots. Returns count of rows written. */
  upsertResaleSnapshotBatch(
    inputs: UpsertResalePriceSnapshotInput[],
  ): Promise<number>;

  /** Get the latest snapshot for a specific ticket type. */
  getLatestResaleSnapshot(
    eventId: string,
    ticketTypeId: string,
  ): Promise<ResalePriceSnapshotRecord | null>;

  /**
   * Batch-fetch the latest resale snapshots for multiple ticket types within
   * a single event.  Returns one record per ticketTypeId (most recent date).
   */
  getLatestResaleSnapshotsBatch(
    eventId: string,
    ticketTypeIds: string[],
  ): Promise<ResalePriceSnapshotRecord[]>;

  /** Get all snapshots for an event on a given date. */
  listResaleSnapshots(
    eventId: string,
    date: Date,
  ): Promise<ResalePriceSnapshotRecord[]>;

  // ── Platform-wide aggregates ────────────────────────────────────────────

  /**
   * Platform-level aggregate stats (order counts, revenue, fees, etc.).
   *
   * Cross-currency by design — see the currency caveat on
   * {@link PlatformStatsResult}. Use
   * {@link AnalyticsRepo.sumPlatformRevenueByCurrency} for anything that has
   * to be defensible.
   */
  getPlatformStats(): Promise<PlatformStatsResult>;

  /**
   * ONE ROW PER CURRENCY: volume processed, platform fee charged, and tax
   * collected, over the captured-money status set
   * (`SUCCEEDED, PART_REFUNDED, REFUNDED, DISPUTED`).
   *
   * Exists because `getPlatformStats` answers neither question honestly: it
   * sums currencies together, and it filtered to `SUCCEEDED` only — so one
   * partial refund removed an entire order's platform fee from the total
   * even though the fee had been charged.
   *
   * GROSS and ALL-TIME. `platformFeesChargedCents` is the fee RECORDED at
   * checkout, split by fee mode alongside — it is neither a ceiling nor a
   * floor on what was kept (under PASS_THROUGH the buyer paid it on top AND
   * the organiser's basis was reduced by it). Fees returned on refunds and
   * processor cost ride with coverage counts.
   *
   * `netKeptCents` IS a net — of the basis-side and buyer-side fee units,
   * less processor cost, fees returned and platform-funded credit — but only
   * over the orders where every one of those inputs is known, counted by
   * `netKeptEligibleCount` against `orderCount`. EIGHT eligibility
   * conditions apply: three exclude most REFUNDED orders because a refund
   * returns money (the processor fee, a spent credit) that nothing records
   * or gives back an amount the aggregate cap cannot pro-rate, and one
   * excludes RESALE orders, which record no platform fee at all and would
   * otherwise net a confident 0.
   * It is SIGNED and it is a SUBSET: never read it as all-time platform
   * profit. See
   * {@link PlatformRevenueByCurrency} for the field-level contract and
   * `get-platform-revenue.ts` for the economics.
   *
   * READ-ONLY. Cents ride `::bigint` → number like the other diagnostic
   * aggregates, so a pathological total is reported rather than raising
   * 22003.
   */
  sumPlatformRevenueByCurrency(): Promise<PlatformRevenueByCurrency[]>;

  // ── Org-level dashboard summary ────────────────────────────────────────

  /**
   * Aggregate the latest EventDailyStats across all events owned by the org.
   * Returns totals for revenue, tickets sold, sell-through, and refund rate.
   */
  getOrgDashboardSummary(orgId: string): Promise<OrgDashboardSummary>;
}
