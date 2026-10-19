import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, GenreCloudEntry, DayOfWeekEntry } from "@th/ports/repos";
import type { VenueConfirmedFor } from "@th/ports/repos/events";
import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";
import { PLACE_STATS_ELIGIBLE_ORDER_STATUSES } from "@th/types/repos/orders";

import { parseInput } from "../../lib/io";
import { venueConfirmedFilterFor } from "../../lib/venue-confirmation";
import {
  EMPTY_TRACK_RECORD,
  computeTrackRecord,
  type TrackRecordEventInput,
} from "./track-record-policy";

// ---------------------------------------------------------------------------
// Visibility thresholds (from spec)
// ---------------------------------------------------------------------------

const MIN_PAYOUT_REVIEWS = 20;
const MIN_STDDEV_REVIEWS = 25;
const MIN_SCORE_REVIEWS = 10;
const MIN_PLAY_AGAIN_REVIEWS = 15;
const MIN_DRAW_REVIEWS = 15;
const MIN_FLAG_REPORTS = 3;
const MIN_MERCH_REVIEWS = 5;
const MIN_BOOKER_REVIEWS = 10;
const DEFAULT_PAGE_SIZE = 100;
/**
 * Shared with the adapter's stale query (`PlaceStatsRepo.listStalePlaceIds`)
 * through `@th/types`, so the set this read counts and the set whose change
 * makes a place stale cannot drift apart.
 */
const ELIGIBLE_ORDER_STATUSES = PLACE_STATS_ELIGIBLE_ORDER_STATUSES;

async function listPastPublishedEventsForPlace(
  repos: Pick<Repos, "events">,
  placeId: string,
  now: Date,
  /**
   * The place's confirmation filter — only venue-confirmed events count (see
   * caller). Built by `venueConfirmedFilterFor`, so it carries the place's
   * `acceptsCommunityListings` consent too: once a venue accepts community
   * listings, its accepted listings START COUNTING toward its event history.
   * Intended (community-listings-at-claimed-venues, `verify:` stats).
   */
  venueConfirmedFor: VenueConfirmedFor,
) {
  const events: Array<
    Awaited<
      ReturnType<Repos["events"]["listPublishedByPlace"]>
    >["items"][number]
  > = [];
  let offset = 0;

  while (true) {
    const page = await repos.events.listPublishedByPlace({
      placeId,
      from: new Date(0),
      to: now,
      status: "past",
      limit: DEFAULT_PAGE_SIZE,
      offset,
      venueConfirmedFor,
      // R10: a show `completeEvent` moved to COMPLETED still happened. ONE
      // read for both consumers; the PUBLISHED-only legacy metrics filter
      // it below rather than paying a second paginated read per place.
      statuses: TRACK_RECORD_EVENT_STATUSES,
    });

    events.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.pageInfo.total) break;
  }

  return events;
}

async function listEligibleOrdersForEvent(
  repos: Pick<Repos, "orders">,
  eventId: string,
) {
  const orders: Array<
    Awaited<ReturnType<Repos["orders"]["listAll"]>>["items"][number]
  > = [];
  let offset = 0;

  while (true) {
    const page = await repos.orders.listAll({
      eventId,
      statuses: [...ELIGIBLE_ORDER_STATUSES],
      limit: 1000,
      offset,
    });

    orders.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }

  return orders;
}

const ZERO_TICKET_METRICS = {
  totalEventCount: 0,
  totalTicketsSold: 0,
  avgTicketPriceCents: null,
  avgAttendance: null,
  ...EMPTY_TRACK_RECORD,
};

/**
 * `countScannedByEvent` is one `GROUP BY` over an `IN (...)` list; a venue
 * with years of history must not hand it thousands of ids in one statement.
 */
const SCAN_COUNT_CHUNK_SIZE = 500;

/**
 * The track record's event rows (venue-track-record spec FR-009): the same
 * confirmed past events, on the RULED `endsAt` basis. `EventRecord.endsAt`
 * is typed optional (older projections omit it) but the column is non-null
 * and `listPublishedByPlace` selects it; a row without one falls back to
 * `startsAt` so a job never throws on a projection gap — but that fallback
 * folds an in-progress show's partial scans into the mean, so it is logged
 * at ERROR (captured by Sentry's pino integration; warn is not).
 */
function toTrackRecordEvents(
  pastEvents: ReadonlyArray<{
    id: string;
    startsAt: Date;
    endsAt?: Date | null;
  }>,
  placeId: string,
  logger: LoggerPort | undefined,
): TrackRecordEventInput[] {
  return pastEvents.map((e) => {
    if (e.endsAt == null) {
      logger?.error("place_stats.event_missing_endsAt", {
        eventId: e.id,
        placeId,
      });
      return { id: e.id, endsAt: e.startsAt };
    }
    return { id: e.id, endsAt: e.endsAt };
  });
}

async function countScannedInChunks(
  repos: Pick<Repos, "tickets">,
  eventIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  const merged = new Map<string, number>();
  for (let i = 0; i < eventIds.length; i += SCAN_COUNT_CHUNK_SIZE) {
    const chunk = eventIds.slice(i, i + SCAN_COUNT_CHUNK_SIZE);
    const counts = await repos.tickets.countScannedByEvent(chunk);
    for (const [eventId, count] of counts) merged.set(eventId, count);
  }
  return merged;
}

async function computePlaceTicketMetrics(
  repos: Pick<Repos, "events" | "orders" | "places" | "tickets">,
  placeId: string,
  now: Date,
  logger: LoggerPort | undefined,
) {
  // Venue-confirmation spec (docs/specs/2026-08-27): an unconfirmed
  // third-party event "blocks nothing and means nothing" — it must not count
  // toward the venue's public events-hosted / attendance figures, or anyone
  // could inflate them by pointing an event at the place. Only venue-owned
  // or venue-stamped events are read (SQL predicate = `isVenueConfirmed`,
  // keyed on the place's owner ids). A place row that is gone yields ZERO
  // metrics rather than an unfiltered read — this runs from a job, so it
  // degrades instead of throwing.
  const place = await repos.places.getById(placeId);
  if (!place) return ZERO_TICKET_METRICS;

  // PUBLISHED + COMPLETED (R10). The track record reads all of them; the
  // pre-existing metrics (`totalEventCount`, tickets sold, `avgAttendance`)
  // stay on the PUBLISHED-only subset — R10 leaves `totalEventCount`
  // unchanged, and the other two share its denominator.
  const happenedEvents = await listPastPublishedEventsForPlace(
    repos,
    placeId,
    now,
    venueConfirmedFilterFor(place),
  );
  const pastEvents = happenedEvents.filter((e) => e.status === "PUBLISHED");

  // Track record (FR-009, R4): batched scan counts (chunks of 500) over every
  // past event at the place; a show with zero scans is absent from the map
  // and stays out of the attendance mean. `endsAt` basis — see
  // `track-record-policy`.
  const scanCounts = await countScannedInChunks(
    repos,
    happenedEvents.map((e) => e.id),
  );
  const trackRecord = computeTrackRecord({
    pastEvents: toTrackRecordEvents(happenedEvents, placeId, logger),
    scanCounts,
    now,
  });

  let totalTicketsSold = 0;
  let totalTicketAmountCents = 0;

  for (const event of pastEvents) {
    const orders = await listEligibleOrdersForEvent(repos, event.id);

    for (const order of orders) {
      for (const item of order.items ?? []) {
        if (item.kind !== "ticket") continue;
        if (typeof item.qty !== "number" || item.qty <= 0) continue;

        totalTicketsSold += item.qty;
        totalTicketAmountCents +=
          typeof item.amountCents === "number" ? item.amountCents : 0;
      }
    }
  }

  return {
    totalEventCount: pastEvents.length,
    totalTicketsSold,
    avgTicketPriceCents:
      totalTicketsSold > 0
        ? Math.round(totalTicketAmountCents / totalTicketsSold)
        : null,
    avgAttendance:
      pastEvents.length > 0
        ? Math.round(totalTicketsSold / pastEvents.length)
        : null,
    ...trackRecord,
  };
}

/**
 * One place, start to finish: reviews → scores, events/scans/orders → ticket
 * metrics and track record, one `upsert` stamped with the batch's `now`.
 * Throws on any repo failure; the batch loop decides what that means.
 */
async function recalculateOnePlace(
  deps: RecalculatePlaceStatsDeps,
  placeId: string,
  now: Date,
): Promise<void> {
  const reviews = await deps.repos.placeReviews.listForStats(placeId);
  const totalCount = await deps.repos.placeReviews.countByPlace(placeId);
  const ticketMetrics = await computePlaceTicketMetrics(
    deps.repos,
    placeId,
    now,
    deps.logger,
  );

  if (reviews.length === 0) {
    // All reviews hidden/flagged — upsert with zeroes
    await deps.repos.placeStats.upsert({
      placeId,
      reviewCount: totalCount,
      reviewCountPublic: 0,
      payoutMeanCents: null,
      payoutMedianCents: null,
      payoutMinCents: null,
      payoutMaxCents: null,
      payoutStdDevCents: null,
      payoutSampleSize: 0,
      payoutGuaranteePct: null,
      payoutDoorSplitPct: null,
      payoutTicketSalesPct: null,
      payoutTipsPct: null,
      payoutPayToPlayPct: null,
      payoutUnpaidPct: null,
      promotionScore: null,
      soundScore: null,
      audienceFitScore: null,
      wouldPlayAgainPct: null,
      bookerScore: null,
      parkingScore: null,
      stageEquipmentScore: null,
      drawMean: null,
      drawMedian: null,
      drawMin: null,
      drawMax: null,
      drawSampleSize: 0,
      payToPlayFlagged: false,
      equipmentLiedFlagged: false,
      noPromotionFlagged: false,
      genreCloud: [],
      merchAllowedPct: null,
      avgMerchCutPct: null,
      dayOfWeekDistribution: [],
      staffSupportScore: null,
      independentVenuePct: null,
      totalEventCount: ticketMetrics.totalEventCount,
      totalTicketsSold: ticketMetrics.totalTicketsSold,
      avgTicketPriceCents: ticketMetrics.avgTicketPriceCents,
      avgAttendance: ticketMetrics.avgAttendance,
      showsHosted: ticketMetrics.showsHosted,
      firstShowAt: ticketMetrics.firstShowAt,
      lastShowAt: ticketMetrics.lastShowAt,
      scannedEventCount: ticketMetrics.scannedEventCount,
      checkedInTotal: ticketMetrics.checkedInTotal,
      checkedInAvg: ticketMetrics.checkedInAvg,
      lastCalculatedAt: now,
    });
    return;
  }

  // --- Payout stats ---
  const payoutValues = reviews
    .map((r) => r.payoutCents)
    .filter((v): v is number => v !== null);
  const payoutSampleSize = payoutValues.length;

  let payoutMeanCents: number | null = null;
  let payoutMedianCents: number | null = null;
  let payoutMinCents: number | null = null;
  let payoutMaxCents: number | null = null;
  let payoutStdDevCents: number | null = null;

  if (payoutSampleSize >= MIN_PAYOUT_REVIEWS) {
    const sum = payoutValues.reduce((a, b) => a + b, 0);
    payoutMeanCents = Math.round(sum / payoutSampleSize);

    const sorted = [...payoutValues].sort((a, b) => a - b);
    payoutMinCents = sorted[0]!;
    payoutMaxCents = sorted[sorted.length - 1]!;

    const mid = Math.floor(sorted.length / 2);
    payoutMedianCents =
      sorted.length % 2 !== 0
        ? sorted[mid]!
        : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);

    if (payoutSampleSize >= MIN_STDDEV_REVIEWS) {
      const mean = sum / payoutSampleSize;
      const variance =
        payoutValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) /
        payoutSampleSize;
      payoutStdDevCents = Math.round(Math.sqrt(variance));
    }
  }

  // --- Payment method distribution ---
  const paymentCounts = new Map<string, number>();
  for (const r of reviews) {
    paymentCounts.set(
      r.paymentMethod,
      (paymentCounts.get(r.paymentMethod) ?? 0) + 1,
    );
  }
  const total = reviews.length;
  const pct = (method: string) => {
    const c = paymentCounts.get(method) ?? 0;
    return c > 0 ? Math.round((c / total) * 100) : null;
  };

  // --- Score calculations ---
  // Maps enum values to numeric scores (5 = best, 0 = worst/deceptive)
  const scoreMap: Record<string, number> = {
    // BookerRating
    EXCELLENT: 5,
    GOOD: 4,
    OKAY: 3,
    POOR: 2,
    TERRIBLE: 1,
    // StageEquipment
    FULL: 5,
    PARTIAL: 3,
    NONE: 1,
    // PromotionLevel
    ACTIVELY_PROMOTED: 5,
    POSTED_ONCE: 3,
    NO_PROMOTION: 1,
    // SoundQuality
    GREAT: 5,
    ADEQUATE: 3,
    BAD: 1,
    NONEXISTENT: 0,
    // AudienceFit
    PERFECT_FIT: 5,
    // OKAY already mapped above (3)
    WRONG_CROWD: 1,
    // Parking
    DEDICATED_LOT: 5,
    STREET_NEARBY: 3,
    DIFFICULT: 1,
    NIGHTMARE: 0,
    // StaffSupport
    YES: 5,
    SOMEWHAT: 3,
    // NO already mapped above (1) via other contexts — handled explicitly below
  };

  function avgScore(
    field: keyof (typeof reviews)[0],
    minReviews: number,
  ): number | null {
    const vals = reviews
      .map((r) => scoreMap[r[field] as string])
      .filter((v): v is number => v !== undefined);
    if (vals.length < minReviews) return null;
    return (
      Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
    );
  }

  const promotionScore = avgScore("venuePromoted", MIN_SCORE_REVIEWS);
  const soundScore = avgScore("soundQuality", MIN_SCORE_REVIEWS);
  const audienceFitScore = avgScore("audienceFit", MIN_SCORE_REVIEWS);
  const bookerScore = avgScore("bookerRating", MIN_BOOKER_REVIEWS);
  const parkingScore = avgScore("parkingLoadIn", MIN_SCORE_REVIEWS);
  const stageEquipmentScore = avgScore("stageEquipment", MIN_SCORE_REVIEWS);

  // --- Would play again ---
  const playAgainYes = reviews.filter((r) => r.wouldPlayAgain === "YES").length;
  const wouldPlayAgainPct =
    total >= MIN_PLAY_AGAIN_REVIEWS
      ? Math.round((playAgainYes / total) * 100)
      : null;

  // --- Draw stats ---
  const drawValues = reviews
    .map((r) => r.estimatedDraw)
    .filter((v): v is number => v !== null);
  const drawSampleSize = drawValues.length;

  let drawMean: number | null = null;
  let drawMedian: number | null = null;
  let drawMin: number | null = null;
  let drawMax: number | null = null;

  if (drawSampleSize >= MIN_DRAW_REVIEWS) {
    const sum = drawValues.reduce((a, b) => a + b, 0);
    drawMean = Math.round(sum / drawSampleSize);

    const sorted = [...drawValues].sort((a, b) => a - b);
    drawMin = sorted[0]!;
    drawMax = sorted[sorted.length - 1]!;

    const mid = Math.floor(sorted.length / 2);
    drawMedian =
      sorted.length % 2 !== 0
        ? sorted[mid]!
        : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }

  // --- Staff support score ---
  const staffSupportScore = avgScore("staffSupport", MIN_SCORE_REVIEWS);

  // --- Merch stats ---
  const merchReviews = reviews.filter((r) => r.merchAllowed != null);
  let merchAllowedPct: number | null = null;
  let avgMerchCutPct: number | null = null;
  if (merchReviews.length >= MIN_MERCH_REVIEWS) {
    const allowedCount = merchReviews.filter(
      (r) =>
        r.merchAllowed === "ALLOWED_FREELY" ||
        r.merchAllowed === "ALLOWED_WITH_CUT",
    ).length;
    merchAllowedPct = Math.round((allowedCount / merchReviews.length) * 100);

    const cutValues = merchReviews
      .map((r) => r.merchCutPct)
      .filter((v): v is number => v != null && v > 0);
    if (cutValues.length > 0) {
      avgMerchCutPct =
        Math.round(
          (cutValues.reduce((a, b) => a + b, 0) / cutValues.length) * 10,
        ) / 10;
    }
  }

  // --- Day of week distribution ---
  const dowCounts = new Map<number, number>();
  for (const r of reviews) {
    if (r.dayOfWeek != null) {
      dowCounts.set(r.dayOfWeek, (dowCounts.get(r.dayOfWeek) ?? 0) + 1);
    }
  }
  const dayOfWeekDistribution: DayOfWeekEntry[] = [...dowCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, count]) => ({ day, count }));

  // --- Independent venue percentage ---
  const indyReviews = reviews.filter((r) => r.independentVenue != null);
  const independentVenuePct =
    indyReviews.length >= MIN_MERCH_REVIEWS
      ? Math.round(
          (indyReviews.filter((r) => r.independentVenue === "YES").length /
            indyReviews.length) *
            100,
        )
      : null;

  // --- Flag triggers ---
  const payToPlayCount = reviews.filter(
    (r) => r.paymentMethod === "PAY_TO_PLAY",
  ).length;
  const noPromotionCount = reviews.filter(
    (r) => r.venuePromoted === "NO_PROMOTION",
  ).length;

  const payToPlayFlagged = payToPlayCount >= MIN_FLAG_REPORTS;
  const noPromotionFlagged = noPromotionCount >= MIN_FLAG_REPORTS;

  // --- Genre cloud (combines legacy genre + new genreTags) ---
  const genreCounts = new Map<string, number>();
  for (const r of reviews) {
    // Legacy single genre field
    if (r.genre) {
      const normalized = r.genre.toLowerCase().trim();
      if (normalized) {
        genreCounts.set(normalized, (genreCounts.get(normalized) ?? 0) + 1);
      }
    }
    // New multi-tag genre field
    if (r.genreTags) {
      for (const tag of r.genreTags) {
        const normalized = tag.toLowerCase().trim();
        if (normalized) {
          genreCounts.set(normalized, (genreCounts.get(normalized) ?? 0) + 1);
        }
      }
    }
  }
  const genreCloud: GenreCloudEntry[] = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([genre, count]) => ({ genre, count }));

  await deps.repos.placeStats.upsert({
    placeId,
    reviewCount: totalCount,
    reviewCountPublic: reviews.length,
    payoutMeanCents,
    payoutMedianCents,
    payoutMinCents,
    payoutMaxCents,
    payoutStdDevCents,
    payoutSampleSize,
    payoutGuaranteePct: pct("GUARANTEE"),
    payoutDoorSplitPct: pct("DOOR_SPLIT"),
    payoutTicketSalesPct: pct("TICKET_SALES"),
    payoutTipsPct: pct("TIPS_ONLY"),
    payoutPayToPlayPct: pct("PAY_TO_PLAY"),
    payoutUnpaidPct: pct("UNPAID"),
    promotionScore,
    soundScore,
    audienceFitScore,
    wouldPlayAgainPct,
    bookerScore,
    parkingScore,
    stageEquipmentScore,
    drawMean,
    drawMedian,
    drawMin,
    drawMax,
    drawSampleSize,
    payToPlayFlagged,
    equipmentLiedFlagged: false, // deprecated: LIED_ABOUT_IT removed in v3
    noPromotionFlagged,
    genreCloud,
    merchAllowedPct,
    avgMerchCutPct,
    dayOfWeekDistribution,
    staffSupportScore,
    independentVenuePct,
    totalEventCount: ticketMetrics.totalEventCount,
    totalTicketsSold: ticketMetrics.totalTicketsSold,
    avgTicketPriceCents: ticketMetrics.avgTicketPriceCents,
    avgAttendance: ticketMetrics.avgAttendance,
    showsHosted: ticketMetrics.showsHosted,
    firstShowAt: ticketMetrics.firstShowAt,
    lastShowAt: ticketMetrics.lastShowAt,
    scannedEventCount: ticketMetrics.scannedEventCount,
    checkedInTotal: ticketMetrics.checkedInTotal,
    checkedInAvg: ticketMetrics.checkedInAvg,
    lastCalculatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// recalculatePlaceStats
// ---------------------------------------------------------------------------

export const recalculatePlaceStatsInputSchema = z
  .object({
    /** Max number of stale places to process per invocation */
    batchSize: z.number().int().min(1).max(500).default(50),
  })
  .strict()
  .optional()
  .default({ batchSize: 50 });

export type RecalculatePlaceStatsInput = z.infer<
  typeof recalculatePlaceStatsInputSchema
>;

export type RecalculatePlaceStatsDeps = {
  repos: Pick<
    Repos,
    "placeReviews" | "placeStats" | "events" | "orders" | "places" | "tickets"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * A place whose recompute throws is REPORTED and skipped (CLAUDE.md swallow
   * convention): the stale query returns oldest-first, so an unskipped
   * throwing place would sort first on every run and kill the job for
   * everyone behind it. Wired to Sentry by the jobs composition root.
   */
  reportError?: ReporterPort;
};

export type RecalculatePlaceStatsOutput = {
  /** Places whose row was written this run. */
  placesProcessed: number;
  placeIds: string[];
  /** Places that threw and were skipped (reported, logged at ERROR). */
  failedPlaceIds: string[];
};

/**
 * Recomputes stats for up to `batchSize` stale places, oldest
 * `lastCalculatedAt` first.
 *
 * Starvation mode: a place that throws is skipped WITHOUT writing its row, so
 * it keeps its old `lastCalculatedAt` and sorts to the front of the stale
 * query again next run. One bad place costs one batch slot per run, forever,
 * until it is fixed. If `batchSize` or more places fail permanently, every
 * run fills its whole batch with them and recomputes nothing else — the job
 * still "succeeds". Each failure is reported per place, but that reads as a
 * few noisy places, not a stalled job. So when at least half the batch
 * (`Math.ceil(batchSize / 2)`) fails in one run, one extra
 * `place_stats.batch_mostly_failing` alert goes out (ERROR log + reporter),
 * once per run. There is no schema-level backoff for failed places.
 */
export async function recalculatePlaceStats(
  deps: RecalculatePlaceStatsDeps,
  rawInput?: unknown,
): Promise<RecalculatePlaceStatsOutput> {
  const input = parseInput(recalculatePlaceStatsInputSchema, rawInput ?? {});

  const stalePlaceIds = await deps.repos.placeStats.listStalePlaceIds(
    input.batchSize,
  );
  const now = deps.clock.now();

  if (stalePlaceIds.length === 0) {
    return { placesProcessed: 0, placeIds: [], failedPlaceIds: [] };
  }

  const placeIds: string[] = [];
  const failedPlaceIds: string[] = [];
  for (const placeId of stalePlaceIds) {
    try {
      await recalculateOnePlace(deps, placeId, now);
      placeIds.push(placeId);
    } catch (err) {
      // Deliberate swallow: log at ERROR (captured by the pino integration —
      // warn is not) AND report, then move on. The reporter is itself
      // guarded so a throwing reporter can never turn a skip into a crash.
      failedPlaceIds.push(placeId);
      deps.logger?.error("place_stats.recalculate_failed", { placeId, err });
      try {
        deps.reportError?.(err, {
          tags: { useCase: "recalculatePlaceStats" },
          extra: { placeId },
        });
      } catch {
        // best-effort by contract (ReporterPort)
      }
    }
  }

  // Batch-level alarm for the starvation mode described above: one alert
  // per run, on top of the per-place reports.
  if (failedPlaceIds.length >= Math.ceil(input.batchSize / 2)) {
    const failed = failedPlaceIds.length;
    const batchSize = input.batchSize;
    deps.logger?.error("place_stats.batch_mostly_failing", {
      failed,
      batchSize,
    });
    try {
      deps.reportError?.(new Error("place_stats.batch_mostly_failing"), {
        tags: { useCase: "recalculatePlaceStats" },
        extra: { failed, batchSize, sample: failedPlaceIds.slice(0, 5) },
      });
    } catch {
      // best-effort by contract (ReporterPort)
    }
  }

  return {
    placesProcessed: placeIds.length,
    placeIds,
    failedPlaceIds,
  };
}
