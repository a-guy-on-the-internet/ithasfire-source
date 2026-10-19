import type {
  PlaceReviewsRepo,
  PlaceReviewRecord,
  CreatePlaceReviewInput,
  ListPlaceReviewsInput,
  ListModerationReviewsInput,
  RespondToPlaceReviewInput,
  FlagPlaceReviewInput,
  PatchReviewEmailInput,
  PlaceStatsRepo,
  PlaceStatsRecord,
  UpsertPlaceStatsInput,
  SetPlaceStatsPublicSnapshotInput,
  ListPlaceIdsWithVisibleReviewsInput,
  GenreCloudEntry,
  DayOfWeekEntry,
} from "@th/ports/repos/place-reviews";

import { PLACE_STATS_ELIGIBLE_ORDER_STATUSES } from "@th/types/repos/orders";
import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";
import { ADMIT_SCAN_OUTCOMES } from "@th/types/repos/tickets";

import type { PrismaClientOrTx } from "./types";
import { resolveWithheldOwners } from "./banned-owner";
import { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// PlaceReview mapper
// ---------------------------------------------------------------------------

type PlaceReviewRow = {
  id: string;
  placeId: string;
  humanId: string | null;
  anonymousName: string | null;
  anonymousEmail: string | null;
  payoutCents: number | null;
  paymentMethod: string;
  paymentDetail: string | null;
  venuePromoted: string;
  promotionDetail: string | null;
  soundQuality: string;
  soundDetail: string | null;
  stageEquipment: string;
  stageEquipmentDetail: string | null;
  audienceFit: string;
  audienceDetail: string | null;
  parkingLoadIn: string;
  parkingDetail: string | null;
  bookerRating: string;
  bookerDetail: string | null;
  wouldPlayAgain: string;
  comment: string | null;
  genre: string | null;
  genreTags: string[];
  estimatedDraw: number | null;
  gigDate: Date | null;
  gigTimeOfDay: string | null;
  gigTimeExact: string | null;
  dayOfWeek: number | null;
  merchAllowed: string | null;
  merchCutPct: number | null;
  staffSupport: string | null;
  photoKeys: string[];
  independentVenue: string | null;
  source: string;
  eventId: string | null;
  sourceCampaign: string | null;
  sourceChannel: string | null;
  responseText: string | null;
  responseById: string | null;
  respondedAt: Date | null;
  flagged: boolean;
  flagReason: string | null;
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toReviewRecord(row: PlaceReviewRow): PlaceReviewRecord {
  return {
    id: row.id,
    placeId: row.placeId,
    humanId: row.humanId,
    anonymousName: row.anonymousName,
    anonymousEmail: row.anonymousEmail,
    payoutCents: row.payoutCents,
    paymentMethod: row.paymentMethod as PlaceReviewRecord["paymentMethod"],
    paymentDetail: row.paymentDetail,
    venuePromoted: row.venuePromoted as PlaceReviewRecord["venuePromoted"],
    promotionDetail: row.promotionDetail,
    soundQuality: row.soundQuality as PlaceReviewRecord["soundQuality"],
    soundDetail: row.soundDetail,
    stageEquipment: row.stageEquipment as PlaceReviewRecord["stageEquipment"],
    stageEquipmentDetail: row.stageEquipmentDetail,
    audienceFit: row.audienceFit as PlaceReviewRecord["audienceFit"],
    audienceDetail: row.audienceDetail,
    parkingLoadIn: row.parkingLoadIn as PlaceReviewRecord["parkingLoadIn"],
    parkingDetail: row.parkingDetail,
    bookerRating: row.bookerRating as PlaceReviewRecord["bookerRating"],
    bookerDetail: row.bookerDetail,
    wouldPlayAgain: row.wouldPlayAgain as PlaceReviewRecord["wouldPlayAgain"],
    comment: row.comment,
    genre: row.genre,
    genreTags: row.genreTags,
    estimatedDraw: row.estimatedDraw,
    gigDate: row.gigDate,
    gigTimeOfDay: row.gigTimeOfDay as PlaceReviewRecord["gigTimeOfDay"],
    gigTimeExact: row.gigTimeExact,
    dayOfWeek: row.dayOfWeek,
    merchAllowed: row.merchAllowed as PlaceReviewRecord["merchAllowed"],
    merchCutPct: row.merchCutPct,
    staffSupport: row.staffSupport as PlaceReviewRecord["staffSupport"],
    photoKeys: row.photoKeys,
    independentVenue:
      row.independentVenue as PlaceReviewRecord["independentVenue"],
    source: row.source as PlaceReviewRecord["source"],
    eventId: row.eventId,
    sourceCampaign: row.sourceCampaign,
    sourceChannel: row.sourceChannel,
    responseText: row.responseText,
    responseById: row.responseById,
    respondedAt: row.respondedAt,
    flagged: row.flagged,
    flagReason: row.flagReason,
    hidden: row.hidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// PlaceStats mapper
// ---------------------------------------------------------------------------

type PlaceStatsRow = {
  id: string;
  placeId: string;
  reviewCount: number;
  reviewCountPublic: number;
  payoutMeanCents: number | null;
  payoutMedianCents: number | null;
  payoutMinCents: number | null;
  payoutMaxCents: number | null;
  payoutStdDevCents: number | null;
  payoutSampleSize: number;
  payoutGuaranteePct: number | null;
  payoutDoorSplitPct: number | null;
  payoutTicketSalesPct: number | null;
  payoutTipsPct: number | null;
  payoutPayToPlayPct: number | null;
  payoutUnpaidPct: number | null;
  promotionScore: number | null;
  soundScore: number | null;
  audienceFitScore: number | null;
  wouldPlayAgainPct: number | null;
  bookerScore: number | null;
  parkingScore: number | null;
  stageEquipmentScore: number | null;
  drawMean: number | null;
  drawMedian: number | null;
  drawMin: number | null;
  drawMax: number | null;
  drawSampleSize: number;
  payToPlayFlagged: boolean;
  equipmentLiedFlagged: boolean;
  noPromotionFlagged: boolean;
  genreCloud: unknown;
  merchAllowedPct: number | null;
  avgMerchCutPct: number | null;
  dayOfWeekDistribution: unknown;
  staffSupportScore: number | null;
  independentVenuePct: number | null;
  totalEventCount: number;
  totalTicketsSold: number;
  avgTicketPriceCents: number | null;
  avgAttendance: number | null;
  showsHosted: number;
  firstShowAt: Date | null;
  lastShowAt: Date | null;
  scannedEventCount: number;
  checkedInTotal: number;
  checkedInAvg: number | null;
  publicSnapshot: unknown;
  publicSnapshotAt: Date | null;
  lastCalculatedAt: Date;
};

function toStatsRecord(row: PlaceStatsRow): PlaceStatsRecord {
  return {
    id: row.id,
    placeId: row.placeId,
    reviewCount: row.reviewCount,
    reviewCountPublic: row.reviewCountPublic,
    payoutMeanCents: row.payoutMeanCents,
    payoutMedianCents: row.payoutMedianCents,
    payoutMinCents: row.payoutMinCents,
    payoutMaxCents: row.payoutMaxCents,
    payoutStdDevCents: row.payoutStdDevCents,
    payoutSampleSize: row.payoutSampleSize,
    payoutGuaranteePct: row.payoutGuaranteePct,
    payoutDoorSplitPct: row.payoutDoorSplitPct,
    payoutTicketSalesPct: row.payoutTicketSalesPct,
    payoutTipsPct: row.payoutTipsPct,
    payoutPayToPlayPct: row.payoutPayToPlayPct,
    payoutUnpaidPct: row.payoutUnpaidPct,
    promotionScore: row.promotionScore,
    soundScore: row.soundScore,
    audienceFitScore: row.audienceFitScore,
    wouldPlayAgainPct: row.wouldPlayAgainPct,
    bookerScore: row.bookerScore,
    parkingScore: row.parkingScore,
    stageEquipmentScore: row.stageEquipmentScore,
    drawMean: row.drawMean,
    drawMedian: row.drawMedian,
    drawMin: row.drawMin,
    drawMax: row.drawMax,
    drawSampleSize: row.drawSampleSize,
    payToPlayFlagged: row.payToPlayFlagged,
    equipmentLiedFlagged: row.equipmentLiedFlagged,
    noPromotionFlagged: row.noPromotionFlagged,
    genreCloud: (row.genreCloud ?? []) as GenreCloudEntry[],
    merchAllowedPct: row.merchAllowedPct,
    avgMerchCutPct: row.avgMerchCutPct,
    dayOfWeekDistribution: (row.dayOfWeekDistribution ??
      []) as DayOfWeekEntry[],
    staffSupportScore: row.staffSupportScore,
    independentVenuePct: row.independentVenuePct,
    totalEventCount: row.totalEventCount,
    totalTicketsSold: row.totalTicketsSold,
    avgTicketPriceCents: row.avgTicketPriceCents,
    avgAttendance: row.avgAttendance,
    showsHosted: row.showsHosted,
    firstShowAt: row.firstShowAt,
    lastShowAt: row.lastShowAt,
    scannedEventCount: row.scannedEventCount,
    checkedInTotal: row.checkedInTotal,
    checkedInAvg: row.checkedInAvg,
    publicSnapshot: row.publicSnapshot ?? null,
    publicSnapshotAt: row.publicSnapshotAt,
    lastCalculatedAt: row.lastCalculatedAt,
  };
}

// ---------------------------------------------------------------------------
// makePlaceReviewsRepo
// ---------------------------------------------------------------------------

export function makePlaceReviewsRepo(p: PrismaClientOrTx): PlaceReviewsRepo {
  return {
    async create(input: CreatePlaceReviewInput) {
      const row = await p.placeReview.create({
        data: {
          placeId: input.placeId,
          humanId: input.humanId ?? null,
          anonymousName: input.anonymousName ?? null,
          anonymousEmail: input.anonymousEmail ?? null,
          payoutCents: input.payoutCents ?? null,
          paymentMethod: input.paymentMethod,
          paymentDetail: input.paymentDetail ?? null,
          venuePromoted: input.venuePromoted,
          promotionDetail: input.promotionDetail ?? null,
          soundQuality: input.soundQuality,
          soundDetail: input.soundDetail ?? null,
          stageEquipment: input.stageEquipment,
          stageEquipmentDetail: input.stageEquipmentDetail ?? null,
          audienceFit: input.audienceFit,
          audienceDetail: input.audienceDetail ?? null,
          parkingLoadIn: input.parkingLoadIn,
          parkingDetail: input.parkingDetail ?? null,
          bookerRating: input.bookerRating,
          bookerDetail: input.bookerDetail ?? null,
          wouldPlayAgain: input.wouldPlayAgain,
          comment: input.comment ?? null,
          genre: input.genre ?? null,
          genreTags: input.genreTags ?? [],
          estimatedDraw: input.estimatedDraw ?? null,
          gigDate: input.gigDate ?? null,
          gigTimeOfDay: input.gigTimeOfDay ?? null,
          gigTimeExact: input.gigTimeExact ?? null,
          dayOfWeek: input.dayOfWeek ?? null,
          merchAllowed: input.merchAllowed ?? null,
          merchCutPct: input.merchCutPct ?? null,
          staffSupport: input.staffSupport ?? null,
          photoKeys: input.photoKeys ?? [],
          independentVenue: input.independentVenue ?? null,
          source: input.source ?? "SURVEY",
          eventId: input.eventId ?? null,
          sourceCampaign: input.sourceCampaign ?? null,
          sourceChannel: input.sourceChannel ?? null,
        },
      });
      return toReviewRecord(row);
    },

    async getById(id) {
      const row = await p.placeReview.findUnique({ where: { id } });
      return row ? toReviewRecord(row) : null;
    },

    async listByPlace(input: ListPlaceReviewsInput) {
      const rows = await p.placeReview.findMany({
        where: {
          placeId: input.placeId,
          ...(input.visibleOnly && { hidden: false }),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
      });
      return rows.map(toReviewRecord);
    },

    async countByPlace(placeId, visibleOnly) {
      return p.placeReview.count({
        where: {
          placeId,
          ...(visibleOnly && { hidden: false }),
        },
      });
    },

    async respond(input: RespondToPlaceReviewInput) {
      const row = await p.placeReview.update({
        where: { id: input.reviewId },
        data: {
          responseText: input.responseText,
          responseById: input.responseById,
          respondedAt: new Date(),
        },
      });
      return toReviewRecord(row);
    },

    async flag(input: FlagPlaceReviewInput) {
      const row = await p.placeReview.update({
        where: { id: input.reviewId },
        data: {
          flagged: true,
          flagReason: input.flagReason,
        },
      });
      return toReviewRecord(row);
    },

    async hide(reviewId) {
      const row = await p.placeReview.update({
        where: { id: reviewId },
        data: { hidden: true },
      });
      return toReviewRecord(row);
    },

    async unhide(reviewId) {
      const row = await p.placeReview.update({
        where: { id: reviewId },
        data: { hidden: false },
      });
      return toReviewRecord(row);
    },

    async listForModeration(input: ListModerationReviewsInput) {
      const where: Prisma.PlaceReviewWhereInput = {};
      if (input.placeId) where.placeId = input.placeId;

      switch (input.moderationFilter) {
        case "flagged":
          where.flagged = true;
          where.hidden = false;
          break;
        case "hidden":
          where.hidden = true;
          break;
        case "visible":
          where.hidden = false;
          break;
        case "all":
        default:
          break;
      }

      const [rows, total] = await Promise.all([
        p.placeReview.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: input.limit ?? 25,
          skip: input.offset ?? 0,
        }),
        p.placeReview.count({ where }),
      ]);

      return { reviews: rows.map(toReviewRecord), total };
    },

    async listForStats(placeId) {
      // Ban that sticks: a BANNED reviewer's reviews leave the public stats
      // and snapshots built from this read (next recompute) and come back on
      // reactivation. Nothing is deleted. See ./banned-owner.ts.
      const { humanIds: bannedHumanIds } = await resolveWithheldOwners(p);
      const rows = await p.placeReview.findMany({
        where: {
          placeId,
          hidden: false,
          flagged: false,
          ...(bannedHumanIds.length > 0
            ? {
                OR: [
                  { humanId: null },
                  { humanId: { notIn: [...bannedHumanIds] } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toReviewRecord);
    },

    async reassignPlace(reviewId: string, newPlaceId: string) {
      const row = await p.placeReview.update({
        where: { id: reviewId },
        data: { placeId: newPlaceId },
      });
      return toReviewRecord(row);
    },

    async globalStats() {
      // Single raw query for efficiency — three distinct counts.
      const result = (await (p as any).$queryRaw`
        SELECT
          COUNT(DISTINCT "placeId")::int        AS "venuesRated",
          COUNT(*)::int                          AS "totalReviews",
          COUNT(DISTINCT "anonymousEmail")::int  AS "contributors"
        FROM "PlaceReview"
        WHERE "hidden" = false
      `) as Array<{
        venuesRated: number;
        totalReviews: number;
        contributors: number;
      }>;

      return result[0] ?? { venuesRated: 0, totalReviews: 0, contributors: 0 };
    },

    async patchEmail(input: PatchReviewEmailInput): Promise<void> {
      await p.placeReview.update({
        where: { id: input.reviewId },
        data: { anonymousEmail: input.email },
      });
    },

    async listPlaceIdsWithVisibleReviews(
      input: ListPlaceIdsWithVisibleReviewsInput,
    ) {
      // groupBy, NOT findMany+distinct: Prisma applies `take` to the row set
      // BEFORE its in-memory distinct, so a page could silently collapse to
      // fewer (even zero) placeIds than exist. groupBy is DB-level distinct
      // with `take` applied to the grouped result.
      const rows = await p.placeReview.groupBy({
        by: ["placeId"],
        where: {
          hidden: false,
          flagged: false,
          ...(input.afterPlaceId && {
            placeId: { gt: input.afterPlaceId },
          }),
        },
        orderBy: { placeId: "asc" },
        take: input.limit,
      });
      return rows.map((r) => r.placeId);
    },
  };
}

// ---------------------------------------------------------------------------
// listStalePlaceIds — the statement, exported so the integration test can
// EXPLAIN ANALYZE the exact SQL the adapter runs (NFR-005) rather than a
// hand-copied twin that could drift.
// ---------------------------------------------------------------------------

/**
 * The ONE staleness window (R12, ruled 2026-09-25), in days. Used twice by
 * {@link stalePlaceIdsSql}: as the activity LOOKBACK of the ticket/order arms
 * (c)/(d), and as the age past which the SWEEP arm (f) recomputes a row
 * regardless of activity. One constant is what makes the union exact: an
 * activity after a row's stamp is either inside the lookback (caught by
 * (c)/(d)) or the stamp is older than the window (caught by (f)). What
 * remains is drain capacity, documented on the port.
 *
 * 30, not 7: measured on the 500-place / 200k-ticket container with a month
 * of activity seeded (20k scans + 12k order changes across the 30 days), the
 * 30-day arms answer in the same single-digit-millisecond band as 7-day
 * ones — the range scan is over recent activity either way — so the wider
 * window (fewer sweeps, more slack for a job outage) costs nothing.
 */
export const STALE_WINDOW_DAYS = 30;

/**
 * Stale-on-anything (venue-track-record FR-008 / NFR-005 / R12). Seven
 * arms, UNIONed, each bounded by its own index — none walks TicketScan whole:
 *   (a) a review changed          PlaceReview ⋈ PlaceStats on placeId
 *   (b) a show ENDED              per place, Event(placeId, endsAt) range
 *                                 on (lastCalculatedAt, now] — correlated,
 *                                 exact; PUBLISHED or COMPLETED (R10)
 *   (c) a ticket was ADMITTED     TicketScan(scannedAt) range over the
 *                                 last STALE_WINDOW_DAYS, admit outcomes
 *                                 only (ADMIT_SCAN_OUTCOMES — the count's
 *                                 basis, R11), → Event by pkey → placeId,
 *                                 then the correlated
 *                                 `scannedAt > lastCalculatedAt`. A REPLAY
 *                                 or REJECTED scan cannot move the count, so
 *                                 it does not make a place stale. Neither
 *                                 does a revert (it writes no log row) —
 *                                 the sweep (f) picks that up
 *   (d) an eligible order changed Order(updatedAt) range over the same
 *                                 window, same shape; statuses are
 *                                 PLACE_STATS_ELIGIBLE_ORDER_STATUSES, the
 *                                 set core's recompute reads
 *   (e) NO PlaceStats row yet AND there is something to compute — a
 *       PUBLISHED/COMPLETED event (e1) or a review (e2). Driven from
 *       Place; TWO arms rather than one with `OR`, because an OR of two
 *       EXISTS makes the planner hash the whole event set instead of
 *       probing per place. A place with neither is not stale: computing
 *       it would only mint an all-zero row.
 *   (f) the SWEEP: any row with `lastCalculatedAt < now − window`, oldest
 *       first, with its own LIMIT so the arm is bounded on its own. This
 *       is what recomputes every pre-existing row (the 150000 backfill
 *       migration sets them all to 1970) and closes the (c)/(d) lookback.
 *
 * (e) is the arm that makes a place with ZERO performer reviews and one
 * past show get computed at all — the old query keyed on reviews alone.
 *
 * WHY (c) and (d) are activity-driven with a lookback, not per-place
 * probes like (b): measured on 500 places / 10k events / 200k tickets /
 * 30k orders, the correlated forms cost ~7 µs per EVENT at a stats-
 * bearing place whichever way they are written — a hash semi-join walks
 * Ticket whole (118 ms) and a LATERAL nested loop probes every event
 * (72 ms for tickets, 65–95 ms for orders even with an (eventId,
 * updatedAt) index) — so they scale with total history. The lookback
 * forms scale with activity per window instead (single-digit ms).
 * `min(lastCalculatedAt)` as the bound would be exact without a sweep but
 * drifts to "all history" on the first quiet place.
 *
 * Comparisons are against `now() AT TIME ZONE 'UTC'`: the columns are
 * tz-naive TIMESTAMP(3) that Prisma writes in UTC, and a bare `now()`
 * (timestamptz) would be shifted by the session timezone first.
 *
 * Ordered least-recently-computed first (never-computed at the head) so a
 * perpetually busy venue cannot starve a quiet one out of the `limit`
 * window across the 30-minute runs. The flip side, documented on the port:
 * after an outage the sweep rows are the oldest and drain FIRST, at
 * ~batchSize × 48 runs/day (× 12 under prod's 2-hour override); fresh
 * activity waits behind them.
 */
export function stalePlaceIdsSql(
  limit: number,
  windowDays: number = STALE_WINDOW_DAYS,
): Prisma.Sql {
  // Bound parameters do not coerce to a Postgres enum; each status is cast.
  const eligibleOrderStatuses = Prisma.join(
    PLACE_STATS_ELIGIBLE_ORDER_STATUSES.map(
      (status) => Prisma.sql`${status}::"OrderStatus"`,
    ),
  );
  const admitOutcomes = Prisma.join(
    ADMIT_SCAN_OUTCOMES.map(
      (outcome) => Prisma.sql`${outcome}::"TicketScanOutcome"`,
    ),
  );
  const happenedStatuses = Prisma.join(
    TRACK_RECORD_EVENT_STATUSES.map(
      (status) => Prisma.sql`${status}::"EventStatus"`,
    ),
  );
  return Prisma.sql`
    WITH stale AS (
      SELECT pr."placeId", ps."lastCalculatedAt"
      FROM "PlaceReview" pr
      JOIN "PlaceStats" ps ON ps."placeId" = pr."placeId"
      WHERE pr."createdAt" > ps."lastCalculatedAt"
         OR pr."updatedAt" > ps."lastCalculatedAt"
      UNION
      SELECT ps."placeId", ps."lastCalculatedAt"
      FROM "PlaceStats" ps
      WHERE EXISTS (
        SELECT 1 FROM "Event" e
        WHERE e."placeId" = ps."placeId"
          AND e."status" IN (${happenedStatuses})
          AND e."endsAt" > ps."lastCalculatedAt"
          AND e."endsAt" <= (now() AT TIME ZONE 'UTC')
      )
      UNION
      SELECT ps."placeId", ps."lastCalculatedAt"
      FROM "PlaceStats" ps
      WHERE EXISTS (
        SELECT 1
        FROM "TicketScan" s
        JOIN "Event" e ON e."id" = s."eventId"
        WHERE e."placeId" = ps."placeId"
          AND s."outcome" IN (${admitOutcomes})
          AND s."scannedAt" > (now() AT TIME ZONE 'UTC') - make_interval(days => ${windowDays})
          AND s."scannedAt" > ps."lastCalculatedAt"
      )
      UNION
      SELECT ps."placeId", ps."lastCalculatedAt"
      FROM "PlaceStats" ps
      WHERE EXISTS (
        SELECT 1
        FROM "Order" o
        JOIN "Event" e ON e."id" = o."eventId"
        WHERE e."placeId" = ps."placeId"
          AND o."status" IN (${eligibleOrderStatuses})
          AND o."updatedAt" > (now() AT TIME ZONE 'UTC') - make_interval(days => ${windowDays})
          AND o."updatedAt" > ps."lastCalculatedAt"
      )
      UNION
      SELECT p."id" AS "placeId", NULL::timestamp AS "lastCalculatedAt"
      FROM "Place" p
      WHERE NOT EXISTS (
          SELECT 1 FROM "PlaceStats" ps WHERE ps."placeId" = p."id"
        )
        AND EXISTS (
          SELECT 1 FROM "Event" e
          WHERE e."placeId" = p."id" AND e."status" IN (${happenedStatuses})
        )
      UNION
      SELECT p."id" AS "placeId", NULL::timestamp AS "lastCalculatedAt"
      FROM "Place" p
      WHERE NOT EXISTS (
          SELECT 1 FROM "PlaceStats" ps WHERE ps."placeId" = p."id"
        )
        AND EXISTS (
          SELECT 1 FROM "PlaceReview" pr WHERE pr."placeId" = p."id"
        )
      UNION
      (
        SELECT ps."placeId", ps."lastCalculatedAt"
        FROM "PlaceStats" ps
        WHERE ps."lastCalculatedAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${windowDays})
        ORDER BY ps."lastCalculatedAt" ASC, ps."placeId" ASC
        LIMIT ${limit}
      )
    )
    SELECT "placeId"
    FROM stale
    ORDER BY "lastCalculatedAt" ASC NULLS FIRST, "placeId" ASC
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// makePlaceStatsRepo
// ---------------------------------------------------------------------------

export function makePlaceStatsRepo(p: PrismaClientOrTx): PlaceStatsRepo {
  return {
    async getByPlaceId(placeId) {
      const row = await p.placeStats.findUnique({ where: { placeId } });
      return row ? toStatsRecord(row) : null;
    },

    async upsert(input: UpsertPlaceStatsInput) {
      const data = {
        reviewCount: input.reviewCount,
        reviewCountPublic: input.reviewCountPublic,
        payoutMeanCents: input.payoutMeanCents,
        payoutMedianCents: input.payoutMedianCents,
        payoutMinCents: input.payoutMinCents,
        payoutMaxCents: input.payoutMaxCents,
        payoutStdDevCents: input.payoutStdDevCents,
        payoutSampleSize: input.payoutSampleSize,
        payoutGuaranteePct: input.payoutGuaranteePct,
        payoutDoorSplitPct: input.payoutDoorSplitPct,
        payoutTicketSalesPct: input.payoutTicketSalesPct,
        payoutTipsPct: input.payoutTipsPct,
        payoutPayToPlayPct: input.payoutPayToPlayPct,
        payoutUnpaidPct: input.payoutUnpaidPct,
        promotionScore: input.promotionScore,
        soundScore: input.soundScore,
        audienceFitScore: input.audienceFitScore,
        wouldPlayAgainPct: input.wouldPlayAgainPct,
        bookerScore: input.bookerScore,
        parkingScore: input.parkingScore,
        stageEquipmentScore: input.stageEquipmentScore,
        drawMean: input.drawMean,
        drawMedian: input.drawMedian,
        drawMin: input.drawMin,
        drawMax: input.drawMax,
        drawSampleSize: input.drawSampleSize,
        payToPlayFlagged: input.payToPlayFlagged,
        equipmentLiedFlagged: input.equipmentLiedFlagged,
        noPromotionFlagged: input.noPromotionFlagged,
        genreCloud: input.genreCloud as unknown as Prisma.InputJsonValue,
        merchAllowedPct: input.merchAllowedPct,
        avgMerchCutPct: input.avgMerchCutPct,
        dayOfWeekDistribution:
          input.dayOfWeekDistribution as unknown as Prisma.InputJsonValue,
        staffSupportScore: input.staffSupportScore,
        independentVenuePct: input.independentVenuePct,
        totalEventCount: input.totalEventCount,
        totalTicketsSold: input.totalTicketsSold,
        avgTicketPriceCents: input.avgTicketPriceCents,
        avgAttendance: input.avgAttendance,
        // Track record (venue-track-record FR-009): door-derived, all six
        // required on the input — a recalculation that does not know them
        // has not computed the track record.
        showsHosted: input.showsHosted,
        firstShowAt: input.firstShowAt,
        lastShowAt: input.lastShowAt,
        scannedEventCount: input.scannedEventCount,
        checkedInTotal: input.checkedInTotal,
        checkedInAvg: input.checkedInAvg,
        // The caller's batch-start `now`, NOT the wall clock at write time.
        // Core reads every event/scan/order at `now` and only then writes; a
        // stamp taken here (T2 > now) would claim the row knows about
        // everything up to T2, so a show ending or a scan landing in
        // (now, T2] is excluded by the compute AND never stale again — every
        // stale arm compares against this column.
        lastCalculatedAt: input.lastCalculatedAt,
      };

      const row = await p.placeStats.upsert({
        where: { placeId: input.placeId },
        create: { placeId: input.placeId, ...data },
        update: data,
      });
      return toStatsRecord(row);
    },

    async setPublicSnapshot(input: SetPlaceStatsPublicSnapshotInput) {
      // Only writer of the snapshot columns. Creates the PlaceStats row when
      // it doesn't exist yet (schema defaults fill the live-stats columns
      // until the recalc job runs); never touches live-stats fields on update.
      const data = {
        publicSnapshot: input.snapshot as Prisma.InputJsonValue,
        publicSnapshotAt: input.computedAt,
      };
      await p.placeStats.upsert({
        where: { placeId: input.placeId },
        // A row minted HERE has never been computed: stamp it at the epoch so
        // the stale sweep picks it up on the next run rather than the column
        // default `now()` hiding it (zeros for a whole window). Create only —
        // the update branch never touches live-stats fields.
        create: {
          placeId: input.placeId,
          lastCalculatedAt: new Date(0),
          ...data,
        },
        update: data,
      });
    },

    async listStalePlaceIds(limit = 100) {
      const rows = await p.$queryRaw<{ placeId: string }[]>(
        stalePlaceIdsSql(limit),
      );
      return rows.map((r) => r.placeId);
    },

    async listPlaceIdsWithPublishedSnapshot(
      input: ListPlaceIdsWithVisibleReviewsInput,
    ) {
      const rows = await p.placeStats.findMany({
        where: {
          publicSnapshot: { not: Prisma.DbNull },
          ...(input.afterPlaceId && {
            placeId: { gt: input.afterPlaceId },
          }),
        },
        select: { placeId: true },
        orderBy: { placeId: "asc" },
        take: input.limit,
      });
      return rows.map((r) => r.placeId);
    },

    async listPublishedSnapshotsByCity(input) {
      // Deliberately selects ONLY the snapshot (and identity) — no live
      // stats columns, no live-column ordering. Ordering/ranking happens in
      // core off the coarsened snapshot values so nothing about the exact
      // live aggregates can leak through this read.
      const rows = await p.placeStats.findMany({
        where: {
          publicSnapshot: { not: Prisma.DbNull },
          placeId: { not: input.excludePlaceId },
          place: {
            city: input.city,
            ...(input.region ? { region: input.region } : {}),
            status: "ACTIVE",
            // FR-003: the performer-review switch (`community_reviews_enabled`
            // on the place row). UNCONDITIONAL — off = not a candidate,
            // whatever its snapshot says. There is no caller that may see a
            // closed place through this read.
            communityReviewsEnabled: true,
          },
        },
        select: {
          placeId: true,
          publicSnapshot: true,
          place: { select: { name: true } },
        },
        orderBy: { placeId: "asc" },
        take: input.limit,
      });

      return rows.map((r) => ({
        placeId: r.placeId,
        placeName: r.place.name,
        publicSnapshot: r.publicSnapshot as unknown,
      }));
    },
  };
}
