import { describe, expect, it, vi } from "vitest";

import { recalculatePlaceStats } from "../recalculate-place-stats";
import type { RecalculatePlaceStatsDeps } from "../recalculate-place-stats";
import type { PlaceReviewRecord } from "@th/types/repos/place-reviews";

// ── Constants ────────────────────────────────────────────────────────────────

const PLACE_A = "00000000-0000-4000-8000-00000000000a";
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_B = "00000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-04-07T12:00:00.000Z");

type MockPublishedEvent = {
  id: string;
  startsAt: Date;
  /** Defaults to `startsAt + 3h` — the track record reads `endsAt`. `null` = omitted by the projection. */
  endsAt?: Date | null;
  status?: string;
  visibility?: string;
};

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

// ── Review factory ───────────────────────────────────────────────────────────

let seq = 0;
function makeReview(
  overrides: Partial<PlaceReviewRecord> = {},
): PlaceReviewRecord {
  seq += 1;
  return {
    id: `rev-${seq}`,
    placeId: PLACE_A,
    humanId: null,
    anonymousName: null,
    anonymousEmail: null,
    payoutCents: 30000,
    paymentMethod: "GUARANTEE",
    paymentDetail: null,
    venuePromoted: "ACTIVELY_PROMOTED",
    promotionDetail: null,
    soundQuality: "GREAT",
    soundDetail: null,
    stageEquipment: "FULL",
    stageEquipmentDetail: null,
    audienceFit: "PERFECT_FIT",
    audienceDetail: null,
    parkingLoadIn: "DEDICATED_LOT",
    parkingDetail: null,
    bookerRating: "EXCELLENT",
    bookerDetail: null,
    wouldPlayAgain: "YES",
    comment: null,
    genre: "rock",
    genreTags: [],
    estimatedDraw: 100,
    dayOfWeek: null,
    merchAllowed: null,
    merchCutPct: null,
    staffSupport: null,
    photoKeys: [],
    independentVenue: null,
    source: "SURVEY",
    eventId: null,
    responseText: null,
    responseById: null,
    respondedAt: null,
    flagged: false,
    flagReason: null,
    hidden: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ── Mock builder ─────────────────────────────────────────────────────────────

function makeDeps(opts: {
  stalePlaceIds?: string[];
  reviewsByPlace?: Record<string, PlaceReviewRecord[]>;
  totalCountByPlace?: Record<string, number>;
  eventsByPlace?: Record<string, MockPublishedEvent[]>;
  missingPlaceIds?: string[];
  /** `Place.acceptsCommunityListings` on every non-missing place row. */
  acceptsCommunityListings?: boolean;
  /** `countScannedByEvent` fixture: eventId → scanned count. Zero-scan = ABSENT. */
  scanCountsByEvent?: Record<string, number>;
  logger?: { error: ReturnType<typeof vi.fn> };
  /** Places whose `listForStats` read throws — the per-place isolation seam. */
  failingPlaceIds?: string[];
  reportError?: ReturnType<typeof vi.fn>;
  ordersByEvent?: Record<
    string,
    Array<{
      status: string;
      items: Array<{ kind?: string; qty?: number; amountCents?: number }>;
    }>
  >;
}): RecalculatePlaceStatsDeps {
  const {
    stalePlaceIds = [],
    reviewsByPlace = {},
    totalCountByPlace = {},
    eventsByPlace = {},
    ordersByEvent = {},
    missingPlaceIds = [] as string[],
    acceptsCommunityListings = false,
    scanCountsByEvent = {},
    logger,
    failingPlaceIds = [] as string[],
    reportError,
  } = opts;

  const upsertCalls: unknown[] = [];

  return {
    repos: {
      placeReviews: {
        listForStats: vi.fn(async (placeId: string) => {
          if (failingPlaceIds.includes(placeId)) {
            throw new Error(`boom:${placeId}`);
          }
          return reviewsByPlace[placeId] ?? [];
        }),
        countByPlace: vi.fn(
          async (placeId: string, _visibleOnly?: boolean) =>
            totalCountByPlace[placeId] ?? 0,
        ),
      },
      placeStats: {
        listStalePlaceIds: vi.fn(async (_limit?: number) => stalePlaceIds),
        upsert: vi.fn(async (input: unknown) => {
          upsertCalls.push(input);
          return input;
        }),
        _upsertCalls: upsertCalls,
      },
      // Venue-confirmation spec: only confirmed events count. Every stale
      // place resolves to an org-owned place unless a suite says otherwise.
      places: {
        getById: vi.fn(async (placeId: string) =>
          missingPlaceIds.includes(placeId)
            ? null
            : {
                id: placeId,
                orgIdsWithAccess: [VENUE_ORG_ID],
                humanIdsWithAccess: [],
                acceptsCommunityListings,
              },
        ),
      },
      events: {
        listPublishedByPlace: vi.fn(
          async ({
            placeId,
            from,
            to,
            status,
            limit = 1000,
            offset = 0,
            statuses,
          }: {
            placeId: string;
            from: Date;
            to: Date;
            status: "past" | "upcoming";
            limit?: number;
            offset?: number;
            statuses?: ReadonlyArray<string>;
          }) => {
            // Mirrors the adapter: omitted → PUBLISHED only.
            const admitted =
              statuses && statuses.length > 0 ? statuses : ["PUBLISHED"];
            const items = (eventsByPlace[placeId] ?? []).filter((event) => {
              const isPublished = admitted.includes(event.status ?? "PUBLISHED");
              const isPublic = (event.visibility ?? "PUBLIC") === "PUBLIC";
              const inRange = event.startsAt >= from && event.startsAt <= to;
              const matchesStatus =
                status === "past"
                  ? event.startsAt <= NOW
                  : event.startsAt >= NOW;
              return isPublished && isPublic && inRange && matchesStatus;
            });
            const pageItems = items
              .slice(offset, offset + limit)
              .map((event) => ({
                ...event,
                status: event.status ?? "PUBLISHED",
                endsAt:
                  event.endsAt === undefined
                    ? new Date(event.startsAt.getTime() + THREE_HOURS_MS)
                    : event.endsAt,
              }));
            return {
              items: pageItems,
              pageInfo: {
                total: items.length,
                count: pageItems.length,
                limit,
                offset,
                hasNextPage: offset + pageItems.length < items.length,
                nextOffset:
                  offset + pageItems.length < items.length
                    ? offset + pageItems.length
                    : null,
              },
            };
          },
        ),
      },
      tickets: {
        countScannedByEvent: vi.fn(async (eventIds: string[]) => {
          const out = new Map<string, number>();
          for (const id of eventIds) {
            const n = scanCountsByEvent[id];
            if (typeof n === "number" && n > 0) out.set(id, n);
          }
          return out;
        }),
      },
      orders: {
        listAll: vi.fn(
          async ({
            eventId,
            statuses,
            limit = 1000,
            offset = 0,
          }: {
            eventId: string;
            statuses?: string[];
            limit?: number;
            offset?: number;
          }) => {
            const items = (ordersByEvent[eventId] ?? []).filter((order) =>
              statuses ? statuses.includes(order.status) : true,
            );
            return {
              items: items.slice(offset, offset + limit),
              total: items.length,
              limit,
              offset,
            };
          },
        ),
      },
    } as any,
    clock: { now: () => NOW },
    logger: logger as any,
    ...(reportError ? { reportError } : {}),
  };
}

function getUpsertCalls(deps: RecalculatePlaceStatsDeps): any[] {
  return (deps.repos.placeStats as any)._upsertCalls;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("recalculatePlaceStats", () => {
  it("returns early when no stale places exist", async () => {
    const deps = makeDeps({ stalePlaceIds: [] });
    const result = await recalculatePlaceStats(deps);

    expect(result).toEqual({
      placesProcessed: 0,
      placeIds: [],
      failedPlaceIds: [],
    });
    expect(deps.repos.placeStats.upsert).not.toHaveBeenCalled();
  });

  it("upserts zeroed stats when all reviews are hidden/flagged", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] }, // listForStats returns empty (hidden/flagged excluded)
      totalCountByPlace: { [PLACE_A]: 5 }, // but 5 total reviews exist
    });

    const result = await recalculatePlaceStats(deps);
    expect(result.placesProcessed).toBe(1);

    const calls = getUpsertCalls(deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      placeId: PLACE_A,
      reviewCount: 5,
      reviewCountPublic: 0,
      payoutMeanCents: null,
      payoutMedianCents: null,
    });
  });

  it("derives ticket metrics from past published event orders when data is available", async () => {
    const reviews = [
      makeReview({ eventId: "event-1" }),
      makeReview({ eventId: "event-2" }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 2 },
      eventsByPlace: {
        [PLACE_A]: [
          { id: "event-1", startsAt: new Date("2026-03-01T20:00:00.000Z") },
          { id: "event-2", startsAt: new Date("2026-03-15T20:00:00.000Z") },
        ],
      },
      ordersByEvent: {
        "event-1": [
          {
            status: "SUCCEEDED",
            items: [
              { kind: "ticket", qty: 2, amountCents: 4000 },
              { kind: "surcharge", qty: 1, amountCents: 999 },
            ],
          },
          {
            status: "PROCESSING",
            items: [{ kind: "ticket", qty: 1, amountCents: 2000 }],
          },
          {
            status: "CANCELLED",
            items: [{ kind: "ticket", qty: 5, amountCents: 25000 }],
          },
        ],
        "event-2": [
          {
            status: "PART_REFUNDED",
            items: [{ kind: "ticket", qty: 3, amountCents: 9000 }],
          },
        ],
      },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    expect(stats.totalEventCount).toBe(2);
    expect(stats.totalTicketsSold).toBe(6);
    expect(stats.avgTicketPriceCents).toBe(2500);
    expect(stats.avgAttendance).toBe(3);
  });

  it("excludes future and unpublished events from canonical event totals", async () => {
    const reviews = [
      makeReview({ eventId: "future-event" }),
      makeReview({ eventId: null }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 2 },
      eventsByPlace: {
        [PLACE_A]: [
          { id: "past-1", startsAt: new Date("2026-03-05T20:00:00.000Z") },
          { id: "past-2", startsAt: new Date("2026-03-20T20:00:00.000Z") },
          {
            id: "future-event",
            startsAt: new Date("2026-05-01T20:00:00.000Z"),
          },
          {
            id: "private-past",
            startsAt: new Date("2026-03-10T20:00:00.000Z"),
            visibility: "PRIVATE",
          },
          {
            id: "cancelled-past",
            startsAt: new Date("2026-03-12T20:00:00.000Z"),
            status: "CANCELLED",
          },
        ],
      },
      ordersByEvent: {
        "past-1": [
          {
            status: "SUCCEEDED",
            items: [{ kind: "ticket", qty: 2, amountCents: 5000 }],
          },
        ],
        "past-2": [
          {
            status: "PROCESSING",
            items: [{ kind: "ticket", qty: 1, amountCents: 3000 }],
          },
        ],
        "future-event": [
          {
            status: "SUCCEEDED",
            items: [{ kind: "ticket", qty: 9, amountCents: 27000 }],
          },
        ],
      },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    expect(stats.totalEventCount).toBe(2);
    expect(stats.totalTicketsSold).toBe(3);
    expect(stats.avgTicketPriceCents).toBe(Math.round(8000 / 3));
    expect(stats.avgAttendance).toBe(2);
  });

  it("computes correct payout mean and median once the payout sample reaches 20 reviews", async () => {
    // Provide 20 reviews to meet MIN_PAYOUT_REVIEWS threshold:
    // 18 at 20000 + 1 at 10000 + 1 at 30000 = mean 20000, median 20000
    const reviews = [
      makeReview({ payoutCents: 10000 }),
      ...Array.from({ length: 18 }, () => makeReview({ payoutCents: 20000 })),
      makeReview({ payoutCents: 30000 }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 20 },
    });

    await recalculatePlaceStats(deps);
    const calls = getUpsertCalls(deps);
    expect(calls).toHaveLength(1);

    const stats = calls[0];
    // mean = (10000 + 18×20000 + 30000) / 20 = 400000/20 = 20000
    expect(stats.payoutMeanCents).toBe(20000);
    // median of 20 sorted values: sorted[9]=20000, sorted[10]=20000 → 20000
    expect(stats.payoutMedianCents).toBe(20000);
    expect(stats.payoutMinCents).toBe(10000);
    expect(stats.payoutMaxCents).toBe(30000);
    expect(stats.payoutSampleSize).toBe(20);
  });

  it("computes correct median for even number of reviews", async () => {
    // 20 reviews: 10 at 20000 + 10 at 30000 → median = (20000+30000)/2 = 25000
    const reviews = [
      ...Array.from({ length: 10 }, () => makeReview({ payoutCents: 20000 })),
      ...Array.from({ length: 10 }, () => makeReview({ payoutCents: 30000 })),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 20 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    // median of 20 values (sorted[9]=20000, sorted[10]=30000) = (20000+30000)/2 = 25000
    expect(stats.payoutMedianCents).toBe(25000);
  });

  it("skips payout stats when fewer than 20 reviews have payoutCents", async () => {
    const reviews = [
      makeReview({ payoutCents: 10000 }),
      makeReview({ payoutCents: null }),
      makeReview({ payoutCents: null }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 3 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    // Only 1 non-null payoutCents — below MIN_PAYOUT_REVIEWS (3)
    expect(stats.payoutMeanCents).toBeNull();
    expect(stats.payoutMedianCents).toBeNull();
    expect(stats.payoutSampleSize).toBe(1);
  });

  it("computes stddev only when >= 25 payout reviews", async () => {
    // 20 reviews: meets MIN_PAYOUT_REVIEWS (20) but not MIN_STDDEV_REVIEWS (25) → stddev null
    const reviews20 = Array.from({ length: 20 }, (_, i) =>
      makeReview({ payoutCents: (i + 1) * 10000 }),
    );

    const deps20 = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews20 },
      totalCountByPlace: { [PLACE_A]: 20 },
    });

    await recalculatePlaceStats(deps20);
    expect(getUpsertCalls(deps20)[0].payoutStdDevCents).toBeNull();

    // 25 reviews: meets MIN_STDDEV_REVIEWS (25) → stddev should be computed
    const reviews25 = Array.from({ length: 25 }, (_, i) =>
      makeReview({ payoutCents: (i + 1) * 10000 }),
    );

    const deps25 = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews25 },
      totalCountByPlace: { [PLACE_A]: 25 },
    });

    await recalculatePlaceStats(deps25);
    const stats = getUpsertCalls(deps25)[0];
    expect(stats.payoutStdDevCents).toBeTypeOf("number");
    expect(stats.payoutStdDevCents).toBeGreaterThan(0);
  });

  it("computes score fields from enum values (rounded to 2 decimals)", async () => {
    // 10 reviews to meet MIN_SCORE_REVIEWS (10):
    // 3 diverse + 7 at ADEQUATE/PARTIAL → avg(5,3,1,3,3,3,3,3,3,3)/10 = 30/10 = 3
    const reviews = [
      makeReview({ soundQuality: "GREAT", stageEquipment: "FULL" }),
      makeReview({ soundQuality: "ADEQUATE", stageEquipment: "PARTIAL" }),
      makeReview({ soundQuality: "BAD", stageEquipment: "NONE" }),
      ...Array.from({ length: 7 }, () =>
        makeReview({ soundQuality: "ADEQUATE", stageEquipment: "PARTIAL" }),
      ),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 10 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    // soundScore: avg(5,3,1,3×7)/10 = 30/10 = 3
    expect(stats.soundScore).toBe(3);
    // stageEquipmentScore: avg(5,3,1,3×7)/10 = 30/10 = 3
    expect(stats.stageEquipmentScore).toBe(3);
  });

  it("rounds scores to 2 decimal places for non-integer averages", async () => {
    // 10 reviews to meet MIN_BOOKER_REVIEWS (10):
    // EXCELLENT(5) + GOOD(4) + OKAY(3) + 7×GOOD(4) → avg = (5+4+3+28)/10 = 40/10 = 4
    const reviews = [
      makeReview({ bookerRating: "EXCELLENT" }), // 5
      makeReview({ bookerRating: "GOOD" }), // 4
      makeReview({ bookerRating: "OKAY" }), // 3
      ...Array.from({ length: 7 }, () => makeReview({ bookerRating: "GOOD" })), // 4 each
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 10 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    // bookerScore: avg(5,4,3,4×7)/10 = 40/10 = 4.0
    expect(stats.bookerScore).toBe(4);
  });

  it("sets payToPlayFlagged when >= 3 PAY_TO_PLAY reviews", async () => {
    // Need 3 PAY_TO_PLAY reviews to meet MIN_FLAG_REPORTS (3)
    const reviews = [
      makeReview({ paymentMethod: "PAY_TO_PLAY" }),
      makeReview({ paymentMethod: "PAY_TO_PLAY" }),
      makeReview({ paymentMethod: "PAY_TO_PLAY" }),
      makeReview({ paymentMethod: "GUARANTEE" }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 4 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    expect(stats.payToPlayFlagged).toBe(true);
    expect(stats.equipmentLiedFlagged).toBe(false); // deprecated in v3
  });

  it("always sets equipmentLiedFlagged to false (deprecated in v3)", async () => {
    const reviews = [
      makeReview({ stageEquipment: "FULL" }),
      makeReview({ stageEquipment: "NONE" }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 2 },
    });

    await recalculatePlaceStats(deps);
    expect(getUpsertCalls(deps)[0].equipmentLiedFlagged).toBe(false);
  });

  it("computes wouldPlayAgainPct as percentage of YES responses", async () => {
    // 16 reviews to meet MIN_PLAY_AGAIN_REVIEWS (15): 8 YES + 8 NO = 50%
    const reviews = [
      ...Array.from({ length: 8 }, () => makeReview({ wouldPlayAgain: "YES" })),
      ...Array.from({ length: 8 }, () => makeReview({ wouldPlayAgain: "NO" })),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 16 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    // 8 YES out of 16 = 50%
    expect(stats.wouldPlayAgainPct).toBe(50);
  });

  it("builds genre cloud from freeform genre strings", async () => {
    const reviews = [
      makeReview({ genre: "Rock" }),
      makeReview({ genre: "rock" }),
      makeReview({ genre: "Jazz" }),
      makeReview({ genre: "rock" }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 4 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    // "Rock" and "rock" should normalize to "rock" (3 occurrences)
    expect(stats.genreCloud).toEqual([
      { genre: "rock", count: 3 },
      { genre: "jazz", count: 1 },
    ]);
  });

  it("processes multiple stale places in one batch", async () => {
    const reviewsA = [makeReview({ placeId: PLACE_A })];
    const reviewsB = [makeReview({ placeId: PLACE_B })];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B],
      reviewsByPlace: { [PLACE_A]: reviewsA, [PLACE_B]: reviewsB },
      totalCountByPlace: { [PLACE_A]: 1, [PLACE_B]: 1 },
    });

    const result = await recalculatePlaceStats(deps);
    expect(result.placesProcessed).toBe(2);
    expect(result.placeIds).toEqual([PLACE_A, PLACE_B]);
    expect(getUpsertCalls(deps)).toHaveLength(2);
  });

  it("computes payment method distribution percentages", async () => {
    const reviews = [
      makeReview({ paymentMethod: "GUARANTEE" }),
      makeReview({ paymentMethod: "GUARANTEE" }),
      makeReview({ paymentMethod: "DOOR_SPLIT" }),
      makeReview({ paymentMethod: "TIPS_ONLY" }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 4 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    expect(stats.payoutGuaranteePct).toBe(50); // 2/4
    expect(stats.payoutDoorSplitPct).toBe(25); // 1/4
    expect(stats.payoutTipsPct).toBe(25); // 1/4
    expect(stats.payoutTicketSalesPct).toBeNull(); // 0/4 → pct() returns null for 0-count
  });

  it("computes draw stats only when fewer than 15 reviews have estimatedDraw", async () => {
    const reviews = [
      makeReview({ estimatedDraw: 50 }),
      makeReview({ estimatedDraw: 100 }),
    ];

    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: reviews },
      totalCountByPlace: { [PLACE_A]: 2 },
    });

    await recalculatePlaceStats(deps);
    const stats = getUpsertCalls(deps)[0];

    expect(stats.drawMean).toBeNull();
    expect(stats.drawMedian).toBeNull();
    expect(stats.drawSampleSize).toBe(2);
  });
});

describe("recalculatePlaceStats — venue confirmation (docs/specs/2026-08-27)", () => {
  it("reads only venue-confirmed past events: passes venueConfirmedFor built from the place's owner ids", async () => {
    const placeId = "place-1";
    const deps = makeDeps({ stalePlaceIds: [placeId], reviewsByPlace: { [placeId]: [] } });
    await recalculatePlaceStats(deps, { batchSize: 10 });
    expect(deps.repos.places.getById).toHaveBeenCalledWith(placeId);
    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId,
        status: "past",
        venueConfirmedFor: {
          orgIds: [VENUE_ORG_ID],
          humanIds: [],
          acceptsCommunityListings: false,
        },
      }),
    );
  });

  it("a venue that accepts community listings counts them: the consent reaches the stats read", async () => {
    // community-listings-at-claimed-venues, `verify:` stats. Intended, not a
    // bug: the stats job reads through the SAME predicate as every other
    // confirmed-only surface, so accepting community listings starts counting
    // them toward the venue's event history. One predicate is the point.
    const placeId = "place-accepting";
    const deps = makeDeps({
      stalePlaceIds: [placeId],
      reviewsByPlace: { [placeId]: [] },
      acceptsCommunityListings: true,
    });
    await recalculatePlaceStats(deps, { batchSize: 10 });
    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId,
        status: "past",
        venueConfirmedFor: {
          orgIds: [VENUE_ORG_ID],
          humanIds: [],
          acceptsCommunityListings: true,
        },
      }),
    );
  });

  it("a missing place row yields ZERO ticket metrics and never an unfiltered event read (job-safe, no throw)", async () => {
    const placeId = "place-gone";
    const deps = makeDeps({
      stalePlaceIds: [placeId],
      reviewsByPlace: { [placeId]: [] },
      missingPlaceIds: [placeId],
    });
    await expect(recalculatePlaceStats(deps, { batchSize: 10 })).resolves.toMatchObject({ placesProcessed: 1 });
    expect(deps.repos.events.listPublishedByPlace).not.toHaveBeenCalled();
    const upsert = deps.repos.placeStats._upsertCalls[0] as Record<string, unknown>;
    expect(upsert).toMatchObject({
      placeId,
      totalEventCount: 0,
      totalTicketsSold: 0,
      avgTicketPriceCents: null,
      avgAttendance: null,
    });
  });
});

describe("recalculatePlaceStats — venue track record (docs/specs/2026-09-24, FR-009 / R4)", () => {
  const PAST = {
    e1: { id: "e1", startsAt: new Date("2026-03-01T01:00:00.000Z"), endsAt: new Date("2026-03-01T04:00:00.000Z") },
    e2: { id: "e2", startsAt: new Date("2026-03-08T01:00:00.000Z"), endsAt: new Date("2026-03-08T04:00:00.000Z") },
    e3: { id: "e3", startsAt: new Date("2026-03-15T01:00:00.000Z"), endsAt: new Date("2026-03-15T04:00:00.000Z") },
  };

  it("writes the six track-record fields on the ZERO-REVIEWS path, from one batched scan count over every past id", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: { [PLACE_A]: [PAST.e1, PAST.e2, PAST.e3] },
      scanCountsByEvent: { e1: 20, e2: 30 }, // e3: zero scans → absent
    });

    await recalculatePlaceStats(deps);

    expect(deps.repos.tickets.countScannedByEvent).toHaveBeenCalledTimes(1);
    expect(deps.repos.tickets.countScannedByEvent).toHaveBeenCalledWith(["e1", "e2", "e3"]);
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      reviewCountPublic: 0,
      showsHosted: 3,
      firstShowAt: PAST.e1.endsAt,
      lastShowAt: PAST.e3.endsAt,
      scannedEventCount: 2,
      checkedInTotal: 50,
      checkedInAvg: 25,
    });
  });

  it("writes the same six fields on the WITH-REVIEWS path", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [makeReview(), makeReview()] },
      totalCountByPlace: { [PLACE_A]: 2 },
      eventsByPlace: { [PLACE_A]: [PAST.e1, PAST.e2, PAST.e3] },
      scanCountsByEvent: { e1: 20, e2: 30 },
    });

    await recalculatePlaceStats(deps);

    const stats = getUpsertCalls(deps)[0];
    expect(stats.reviewCountPublic).toBe(2);
    expect(stats).toMatchObject({
      showsHosted: 3,
      firstShowAt: PAST.e1.endsAt,
      lastShowAt: PAST.e3.endsAt,
      scannedEventCount: 2,
      checkedInTotal: 50,
      checkedInAvg: 25,
    });
    expect(deps.repos.tickets.countScannedByEvent).toHaveBeenCalledTimes(1);
  });

  it("an event missing from the scan map does not lower the average (R4: excluded, never 0)", async () => {
    const withMissing = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: { [PLACE_A]: [PAST.e1, PAST.e2, PAST.e3] },
      scanCountsByEvent: { e1: 40, e2: 40 },
    });
    const without = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: { [PLACE_A]: [PAST.e1, PAST.e2] },
      scanCountsByEvent: { e1: 40, e2: 40 },
    });

    await recalculatePlaceStats(withMissing);
    await recalculatePlaceStats(without);

    expect(getUpsertCalls(withMissing)[0].checkedInAvg).toBe(40);
    expect(getUpsertCalls(without)[0].checkedInAvg).toBe(40);
    // The missing show still counts as hosted.
    expect(getUpsertCalls(withMissing)[0].showsHosted).toBe(3);
    expect(getUpsertCalls(without)[0].showsHosted).toBe(2);
  });

  it("zero scans everywhere → avg null; RSVP-only nights still count as hosted (R5)", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: { [PLACE_A]: [PAST.e1, PAST.e2] },
    });
    await recalculatePlaceStats(deps);
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      showsHosted: 2,
      scannedEventCount: 0,
      checkedInTotal: 0,
      checkedInAvg: null,
    });
  });

  it("an in-progress show (started, not ended) is in totalEventCount but NOT in the track record", async () => {
    // NOW is 2026-04-07T12:00Z. Started 10:00Z, ends 14:00Z: `startsAt <= now`
    // so the legacy `status: "past"` read returns it; `endsAt > now` so the
    // ruled endsAt basis leaves it out.
    const live = {
      id: "live",
      startsAt: new Date("2026-04-07T10:00:00.000Z"),
      endsAt: new Date("2026-04-07T14:00:00.000Z"),
    };
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: { [PLACE_A]: [PAST.e1, live] },
      scanCountsByEvent: { e1: 10, live: 999 },
    });
    await recalculatePlaceStats(deps);
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      totalEventCount: 2,
      showsHosted: 1,
      lastShowAt: PAST.e1.endsAt,
      scannedEventCount: 1,
      checkedInTotal: 10,
      checkedInAvg: 10,
    });
  });

  it("a missing place row writes zeroed track-record fields and never asks for scan counts", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      missingPlaceIds: [PLACE_A],
    });
    await recalculatePlaceStats(deps);
    expect(deps.repos.tickets.countScannedByEvent).not.toHaveBeenCalled();
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      showsHosted: 0,
      firstShowAt: null,
      lastShowAt: null,
      scannedEventCount: 0,
      checkedInTotal: 0,
      checkedInAvg: null,
    });
  });

  it("a place with no past events still gets the six fields (as zeros) and no scan query at all", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
    });
    await recalculatePlaceStats(deps);
    expect(deps.repos.tickets.countScannedByEvent).not.toHaveBeenCalled();
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      showsHosted: 0,
      firstShowAt: null,
      lastShowAt: null,
      scannedEventCount: 0,
      checkedInTotal: 0,
      checkedInAvg: null,
    });
  });
});

describe("recalculatePlaceStats — track record hardening (review 2026-09-24)", () => {
  it("a row without endsAt falls back to startsAt AND logs at error (not warn) with the ids", async () => {
    const logger = { error: vi.fn() };
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: {
        [PLACE_A]: [
          { id: "no-end", startsAt: new Date("2026-03-01T01:00:00.000Z"), endsAt: null },
        ],
      },
      scanCountsByEvent: { "no-end": 7 },
      logger,
    });
    await recalculatePlaceStats(deps);
    expect(logger.error).toHaveBeenCalledWith("place_stats.event_missing_endsAt", {
      eventId: "no-end",
      placeId: PLACE_A,
    });
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      showsHosted: 1,
      firstShowAt: new Date("2026-03-01T01:00:00.000Z"),
      checkedInAvg: 7,
    });
  });

  it("no logger → the fallback still works silently", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: {
        [PLACE_A]: [
          { id: "no-end", startsAt: new Date("2026-03-01T01:00:00.000Z"), endsAt: null },
        ],
      },
    });
    await expect(recalculatePlaceStats(deps)).resolves.toMatchObject({ placesProcessed: 1 });
    expect(getUpsertCalls(deps)[0].showsHosted).toBe(1);
  });

  it("1,200 past events → countScannedByEvent called 3 times in chunks of 500, maps merged", async () => {
    const events = Array.from({ length: 1200 }, (_, i) => ({
      id: `ev-${i}`,
      startsAt: new Date(Date.UTC(2020, 0, 1) + i * 60 * 60 * 1000),
    }));
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: { [PLACE_A]: events },
      // One scanned show per chunk, so a dropped chunk would show in the total.
      scanCountsByEvent: { "ev-0": 10, "ev-600": 20, "ev-1199": 30 },
    });
    await recalculatePlaceStats(deps);

    const calls = (deps.repos.tickets.countScannedByEvent as any).mock.calls as string[][][];
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c[0]!.length)).toEqual([500, 500, 200]);
    expect(calls.flatMap((c) => c[0]!)).toEqual(events.map((e) => e.id));
    expect(getUpsertCalls(deps)[0]).toMatchObject({
      showsHosted: 1200,
      scannedEventCount: 3,
      checkedInTotal: 60,
      checkedInAvg: 20,
    });
  });
});

describe("recalculatePlaceStats — COMPLETED shows count (R10, 2026-09-25)", () => {
  it("reads PUBLISHED + COMPLETED for the track record; totalEventCount stays PUBLISHED-only", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_A]: [] },
      eventsByPlace: {
        [PLACE_A]: [
          { id: "pub", startsAt: new Date("2026-03-01T01:00:00.000Z") },
          {
            id: "done",
            startsAt: new Date("2026-03-08T01:00:00.000Z"),
            status: "COMPLETED",
          },
          {
            id: "gone",
            startsAt: new Date("2026-03-15T01:00:00.000Z"),
            status: "CANCELLED",
          },
        ],
      },
      scanCountsByEvent: { pub: 10, done: 30 },
      ordersByEvent: {
        pub: [{ status: "SUCCEEDED", items: [{ kind: "ticket", qty: 2, amountCents: 4000 }] }],
        done: [{ status: "SUCCEEDED", items: [{ kind: "ticket", qty: 5, amountCents: 10000 }] }],
      },
    });
    await recalculatePlaceStats(deps);

    expect(deps.repos.events.listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["PUBLISHED", "COMPLETED"] }),
    );
    const stats = getUpsertCalls(deps)[0];
    // Track record: both shows happened.
    expect(stats).toMatchObject({
      showsHosted: 2,
      scannedEventCount: 2,
      checkedInTotal: 40,
      checkedInAvg: 20,
      lastShowAt: new Date("2026-03-08T04:00:00.000Z"),
    });
    // Legacy metrics: unchanged basis — the PUBLISHED show only.
    expect(stats).toMatchObject({
      totalEventCount: 1,
      totalTicketsSold: 2,
      avgAttendance: 2,
    });
    // Scan counts were asked for both.
    expect(deps.repos.tickets.countScannedByEvent).toHaveBeenCalledWith(["pub", "done"]);
  });
});

describe("recalculatePlaceStats — a throwing place is reported and skipped (review 2026-09-25)", () => {
  it("one place throws: the rest of the batch is still written; logged at ERROR and reported with tags", async () => {
    const logger = { error: vi.fn() };
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B],
      failingPlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_B]: [] },
      logger,
      reportError,
    });

    const result = await recalculatePlaceStats(deps);

    expect(result).toEqual({
      placesProcessed: 1,
      placeIds: [PLACE_B],
      failedPlaceIds: [PLACE_A],
    });
    expect(getUpsertCalls(deps).map((c) => c.placeId)).toEqual([PLACE_B]);
    expect(logger.error).toHaveBeenCalledWith("place_stats.recalculate_failed", {
      placeId: PLACE_A,
      err: expect.objectContaining({ message: `boom:${PLACE_A}` }),
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: `boom:${PLACE_A}` }),
      { tags: { useCase: "recalculatePlaceStats" }, extra: { placeId: PLACE_A } },
    );
  });

  it("a THROWING reporter changes nothing: the batch still completes", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B],
      failingPlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_B]: [] },
      reportError,
    });
    await expect(recalculatePlaceStats(deps)).resolves.toEqual({
      placesProcessed: 1,
      placeIds: [PLACE_B],
      failedPlaceIds: [PLACE_A],
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("no logger, no reporter: still skips and continues", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B],
      failingPlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_B]: [] },
    });
    await expect(recalculatePlaceStats(deps)).resolves.toMatchObject({
      placesProcessed: 1,
      failedPlaceIds: [PLACE_A],
    });
  });

  it("every upsert is stamped with the batch-start clock, never a per-place wall clock", async () => {
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B],
      reviewsByPlace: { [PLACE_A]: [], [PLACE_B]: [] },
    });
    await recalculatePlaceStats(deps);
    for (const call of getUpsertCalls(deps)) {
      expect(call.lastCalculatedAt).toBe(NOW);
    }
  });
});

describe("recalculatePlaceStats — batch mostly failing alarm (starvation guard, 2026-09-25)", () => {
  const PLACE_C = "00000000-0000-4000-8000-00000000000c";
  const PLACE_D = "00000000-0000-4000-8000-00000000000d";
  const BATCH_ALERT = "place_stats.batch_mostly_failing";

  const batchAlertCalls = (reportError: ReturnType<typeof vi.fn>) =>
    reportError.mock.calls.filter(
      ([err]) => (err as Error | undefined)?.message === BATCH_ALERT,
    );

  it("half the batch fails: ONE batch alert (log + report) on top of the per-place reports", async () => {
    const logger = { error: vi.fn() };
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B, PLACE_C, PLACE_D],
      failingPlaceIds: [PLACE_A, PLACE_B],
      reviewsByPlace: { [PLACE_C]: [], [PLACE_D]: [] },
      logger,
      reportError,
    });

    const result = await recalculatePlaceStats(deps, { batchSize: 4 });

    expect(result.failedPlaceIds).toEqual([PLACE_A, PLACE_B]);
    expect(result.placesProcessed).toBe(2);
    // 2 per-place reports + exactly 1 batch report.
    expect(reportError).toHaveBeenCalledTimes(3);
    expect(batchAlertCalls(reportError)).toEqual([
      [
        expect.objectContaining({ message: BATCH_ALERT }),
        {
          tags: { useCase: "recalculatePlaceStats" },
          extra: { failed: 2, batchSize: 4, sample: [PLACE_A, PLACE_B] },
        },
      ],
    ]);
    expect(
      logger.error.mock.calls.filter(([msg]) => msg === BATCH_ALERT),
    ).toEqual([[BATCH_ALERT, { failed: 2, batchSize: 4 }]]);
  });

  it("the sample is capped at five place ids", async () => {
    const ids = Array.from(
      { length: 7 },
      (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
    );
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: ids,
      failingPlaceIds: ids,
      reportError,
    });

    await recalculatePlaceStats(deps, { batchSize: 7 });

    const [[, ctx]] = batchAlertCalls(reportError) as [[unknown, { extra: { sample: string[]; failed: number } }]];
    expect(ctx.extra.failed).toBe(7);
    expect(ctx.extra.sample).toEqual(ids.slice(0, 5));
  });

  it("one failure in a batch of four: no batch alert, only the per-place report", async () => {
    const logger = { error: vi.fn() };
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B, PLACE_C, PLACE_D],
      failingPlaceIds: [PLACE_A],
      reviewsByPlace: { [PLACE_B]: [], [PLACE_C]: [], [PLACE_D]: [] },
      logger,
      reportError,
    });

    await recalculatePlaceStats(deps, { batchSize: 4 });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(batchAlertCalls(reportError)).toEqual([]);
    expect(
      logger.error.mock.calls.filter(([msg]) => msg === BATCH_ALERT),
    ).toEqual([]);
  });

  it("a THROWING reporter on the batch alert changes nothing: the run still resolves", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B, PLACE_C, PLACE_D],
      failingPlaceIds: [PLACE_A, PLACE_B],
      reviewsByPlace: { [PLACE_C]: [], [PLACE_D]: [] },
      reportError,
    });

    await expect(
      recalculatePlaceStats(deps, { batchSize: 4 }),
    ).resolves.toEqual({
      placesProcessed: 2,
      placeIds: [PLACE_C, PLACE_D],
      failedPlaceIds: [PLACE_A, PLACE_B],
    });
    expect(batchAlertCalls(reportError)).toHaveLength(1);
  });
});

describe("recalculatePlaceStats — batch alarm threshold is ceil(batchSize / 2) of the REQUESTED batch", () => {
  const BATCH_ALERT = "place_stats.batch_mostly_failing";
  const ids = Array.from(
    { length: 5 },
    (_, i) => `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
  );
  const batchAlerts = (reportError: ReturnType<typeof vi.fn>) =>
    reportError.mock.calls.filter(
      ([err]) => (err as Error | undefined)?.message === BATCH_ALERT,
    );

  it("batchSize 10, only 2 stale places, both failing: NO batch alert (2 < 5, not keyed on the stale count)", async () => {
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: [PLACE_A, PLACE_B],
      failingPlaceIds: [PLACE_A, PLACE_B],
      reportError,
    });

    await recalculatePlaceStats(deps, { batchSize: 10 });

    expect(reportError).toHaveBeenCalledTimes(2); // the two per-place reports
    expect(batchAlerts(reportError)).toEqual([]);
  });

  it("batchSize 5, 2 of 5 failing: NO batch alert (2 < ceil(2.5) = 3, not floor)", async () => {
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: ids,
      failingPlaceIds: ids.slice(0, 2),
      reportError,
    });

    await recalculatePlaceStats(deps, { batchSize: 5 });

    expect(batchAlerts(reportError)).toEqual([]);
  });

  it("batchSize 5, 3 of 5 failing: exactly one batch alert", async () => {
    const reportError = vi.fn();
    const deps = makeDeps({
      stalePlaceIds: ids,
      failingPlaceIds: ids.slice(0, 3),
      reportError,
    });

    await recalculatePlaceStats(deps, { batchSize: 5 });

    expect(batchAlerts(reportError)).toHaveLength(1);
    expect(batchAlerts(reportError)[0]?.[1]).toMatchObject({
      extra: { failed: 3, batchSize: 5 },
    });
  });
});
