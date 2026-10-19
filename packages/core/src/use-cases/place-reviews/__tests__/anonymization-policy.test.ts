import { describe, expect, it } from "vitest";

import {
  buildPublicSnapshot,
  computeSnapshotAggregates,
  isReviewPubliclyIncludable,
  placePublicSnapshotSchema,
  GENRE_OTHER_LABEL,
  MIN_GENRE_REVIEWS,
  MIN_HEADLINE_REVIEWS,
  MIN_PAYOUT_REVIEWS,
  MIN_SLICE_REVIEWS,
  PAYOUT_BUCKET_CENTS,
  PERCENT_STEP,
  PLATFORM_REVIEW_EMBARGO_DAYS,
  SCORE_STEP,
  toPublicHeadlineSummary,
  type PlacePublicSnapshot,
  type SnapshotReviewInput,
} from "../anonymization-policy";

// ── Helpers ──────────────────────────────────────────────────────────────────

function review(
  overrides: Partial<SnapshotReviewInput> = {},
): SnapshotReviewInput {
  return {
    payoutCents: null,
    paymentMethod: "GUARANTEE",
    wouldPlayAgain: "YES",
    venuePromoted: "ACTIVELY_PROMOTED",
    soundQuality: "GREAT",
    stageEquipment: "FULL",
    parkingLoadIn: "STREET_NEARBY",
    bookerRating: "GOOD",
    staffSupport: "YES",
    dayOfWeek: 5,
    genre: null,
    genreTags: [],
    ...overrides,
  };
}

function snapshotOf(reviews: SnapshotReviewInput[]): PlacePublicSnapshot {
  return buildPublicSnapshot(computeSnapshotAggregates(reviews));
}

/** n reviews, each carrying a payout so payoutSampleSize === n. */
function reviewsWithPayout(n: number): SnapshotReviewInput[] {
  return Array.from({ length: n }, (_, i) =>
    review({ payoutCents: 10000 + i * 3700 }), // deliberately un-round values
  );
}

// ── Threshold pinning (NFR-001): which slices appear at n = 2,3,4,5,9,10 ────

describe("buildPublicSnapshot slice thresholds", () => {
  it("n=2: nothing but the version — no headline, payout, or slices", () => {
    const snap = snapshotOf(reviewsWithPayout(2));
    expect(snap).toStrictEqual({ version: 1 });
    expect("headline" in snap).toBe(false);
    expect("payout" in snap).toBe(false);
    expect("dayOfWeek" in snap).toBe(false);
    expect("genres" in snap).toBe(false);
  });

  it("n=3: headline appears (MIN_HEADLINE_REVIEWS), payout and slices still absent", () => {
    expect(MIN_HEADLINE_REVIEWS).toBe(3);
    const snap = snapshotOf(reviewsWithPayout(3));

    expect(snap.headline).toBeDefined();
    expect(snap.headline!.reviewCountBand).toBe("3");
    // 3 payout-carrying reviews < MIN_PAYOUT_REVIEWS (5): absent, not zeroed
    expect("payout" in snap).toBe(false);
    expect("dayOfWeek" in snap).toBe(false);
    expect("genres" in snap).toBe(false);
  });

  it("n=4 (acceptance: 4 reviews, 3 with payout): headline yes, payout absent", () => {
    const reviews = [
      review({ payoutCents: 10000 }),
      review({ payoutCents: 20000 }),
      review({ payoutCents: 30000 }),
      review({ payoutCents: null }),
    ];
    const snap = snapshotOf(reviews);

    expect(snap.headline).toBeDefined();
    expect(snap.headline!.reviewCountBand).toBe("4");
    expect("payout" in snap).toBe(false);
  });

  it("n=5 with 5 payouts: payout appears (MIN_PAYOUT_REVIEWS), $25-bucketed", () => {
    expect(MIN_PAYOUT_REVIEWS).toBe(5);
    const snap = snapshotOf(reviewsWithPayout(5));

    expect(snap.payout).toBeDefined();
    expect(snap.payout!.medianCents % PAYOUT_BUCKET_CENTS).toBe(0);
    expect(snap.payout!.minCents % PAYOUT_BUCKET_CENTS).toBe(0);
    expect(snap.payout!.maxCents % PAYOUT_BUCKET_CENTS).toBe(0);
    expect(snap.payout!.sampleSizeBand).toBe("5");
    // Day-of-week / genre slices still gated at 10
    expect("dayOfWeek" in snap).toBe(false);
    expect("genres" in snap).toBe(false);
  });

  it("n=5 total but only 4 with payout: payout absent (gates on payout sample, not review count)", () => {
    const reviews = [...reviewsWithPayout(4), review({ payoutCents: null })];
    const snap = snapshotOf(reviews);

    expect(snap.headline).toBeDefined();
    expect("payout" in snap).toBe(false);
  });

  it("n=9: day-of-week and genre slices still absent", () => {
    const reviews = Array.from({ length: 9 }, (_, i) =>
      review({ dayOfWeek: i % 7, genreTags: ["rock"] }),
    );
    const snap = snapshotOf(reviews);

    expect(snap.headline).toBeDefined();
    expect("dayOfWeek" in snap).toBe(false);
    expect("genres" in snap).toBe(false);
  });

  it("n=10: day-of-week and genre slices appear (MIN_SLICE_REVIEWS)", () => {
    expect(MIN_SLICE_REVIEWS).toBe(10);
    const reviews = Array.from({ length: 10 }, (_, i) =>
      review({ dayOfWeek: i < 7 ? 5 : 6, genreTags: ["rock"] }),
    );
    const snap = snapshotOf(reviews);

    expect(snap.dayOfWeek).toBeDefined();
    expect(snap.genres).toEqual(["rock"]);
    for (const entry of snap.dayOfWeek!) {
      expect(entry.pct % PERCENT_STEP).toBe(0);
    }
  });
});

// ── Coarsening (FR-003): every emitted number is bucket-aligned ─────────────

describe("buildPublicSnapshot coarsening", () => {
  it("percentages are multiples of 5 and counts band past 20", () => {
    // 21 reviews: 13 YES → exact 61.9% must not be emitted
    const reviews = Array.from({ length: 21 }, (_, i) =>
      review({ wouldPlayAgain: i < 13 ? "YES" : "NO" }),
    );
    const snap = snapshotOf(reviews);

    expect(snap.headline!.reviewCountBand).toBe("20+");
    expect(snap.headline!.wouldPlayAgainPct).toBe(60);
  });

  it("scores are multiples of SCORE_STEP (0.5)", () => {
    // 3 sound ratings GREAT(5), ADEQUATE(3), ADEQUATE(3) → exact 3.666…
    const reviews = [
      review({ soundQuality: "GREAT" }),
      review({ soundQuality: "ADEQUATE" }),
      review({ soundQuality: "ADEQUATE" }),
    ];
    const snap = snapshotOf(reviews);

    expect(snap.headline!.soundScore).toBe(3.5);
    for (const key of [
      "promotionScore",
      "soundScore",
      "stageEquipmentScore",
      "parkingScore",
      "bookerScore",
      "staffSupportScore",
    ] as const) {
      const value = snap.headline![key];
      if (value !== undefined) {
        expect((value * 10) % (SCORE_STEP * 10)).toBe(0);
      }
    }
  });

  it("payout method percentages are 5%-stepped and zero-count methods are omitted", () => {
    const reviews = [
      ...Array.from({ length: 4 }, () =>
        review({ payoutCents: 15000, paymentMethod: "GUARANTEE" }),
      ),
      review({ payoutCents: 15000, paymentMethod: "DOOR_SPLIT" }),
      review({ payoutCents: 15000, paymentMethod: "DOOR_SPLIT" }),
    ];
    const snap = snapshotOf(reviews);

    // Denominator is reviewCount (ALL eligible reviews — every review
    // carries a paymentMethod): 4/6 ≈ 66.7 → 65; 2/6 ≈ 33.3 → 35.
    expect(snap.payout!.methodPcts).toStrictEqual({
      guarantee: 65,
      doorSplit: 35,
    });
  });

  it("every enum method is representable: BAR_PERCENTAGE and OTHER emit shares", () => {
    const reviews = [
      ...Array.from({ length: 3 }, () =>
        review({ payoutCents: 15000, paymentMethod: "GUARANTEE" }),
      ),
      review({ payoutCents: 15000, paymentMethod: "BAR_PERCENTAGE" }),
      review({ payoutCents: 15000, paymentMethod: "OTHER" }),
    ];
    const snap = snapshotOf(reviews);

    // Self-consistent mix over reviewCount: 60 + 20 + 20 = 100.
    expect(snap.payout!.methodPcts).toStrictEqual({
      guarantee: 60,
      barPercentage: 20,
      other: 20,
    });
  });

  it("exact figures never survive: un-round payouts land on $25 buckets", () => {
    const reviews = reviewsWithPayout(7); // values 10000..32200 step 3700
    const snap = snapshotOf(reviews);

    expect(snap.payout!.medianCents).toBe(
      Math.round((10000 + 3 * 3700) / PAYOUT_BUCKET_CENTS) *
        PAYOUT_BUCKET_CENTS,
    );
    expect(snap.payout!.minCents).toBe(10000);
    expect(snap.payout!.maxCents % PAYOUT_BUCKET_CENTS).toBe(0);
  });

  it("output always validates against the public snapshot schema", () => {
    for (const n of [0, 2, 3, 5, 10, 25]) {
      const snap = snapshotOf(reviewsWithPayout(n));
      expect(placePublicSnapshotSchema.parse(snap)).toStrictEqual(snap);
    }
  });
});

// ── Genre protection (FR-004) ────────────────────────────────────────────────

describe("genre folding", () => {
  it("genres below MIN_GENRE_REVIEWS fold into 'other'", () => {
    expect(MIN_GENRE_REVIEWS).toBe(3);
    const reviews = [
      ...Array.from({ length: 8 }, () => review({ genreTags: ["folk"] })),
      review({ genreTags: ["metal"] }), // the one metal act — must not be named
      review({ genreTags: ["jazz", "folk"] }),
    ];
    const snap = snapshotOf(reviews);

    expect(snap.genres).toEqual(["folk", GENRE_OTHER_LABEL]);
    expect(snap.genres).not.toContain("metal");
    expect(snap.genres).not.toContain("jazz");
  });

  it("omits the genre slice entirely when no genre clears the fold threshold", () => {
    const reviews = Array.from({ length: 10 }, (_, i) =>
      review({ genreTags: [`genre-${i}`] }),
    );
    const snap = snapshotOf(reviews);

    expect("genres" in snap).toBe(false);
  });

  it("counts genres per DISTINCT REVIEW: genre/genreTags duplicates and case/whitespace variants collapse to 1", () => {
    // The web form systematically sends genre === genreTags[0]; without
    // per-review dedupe one review would contribute 2+ to its primary genre.
    const agg = computeSnapshotAggregates([
      review({ genre: "metal", genreTags: ["metal", "Metal "] }),
    ]);

    expect(agg.genreCounts).toStrictEqual([{ genre: "metal", count: 1 }]);
  });

  it("two reviews from one act cannot clear the k=3 fold via duplicated tags", () => {
    const reviews = [
      ...Array.from({ length: 8 }, () =>
        review({ genre: "folk", genreTags: ["folk"] }),
      ),
      // One act, two reviews, each stuffing case/whitespace variants — the
      // occurrence count is 5 but the distinct-review count is 2 (< 3).
      review({ genre: "metal", genreTags: ["metal", "Metal "] }),
      review({ genre: "Metal", genreTags: ["metal", " METAL"] }),
    ];
    const snap = snapshotOf(reviews);

    expect(snap.genres).toEqual(["folk", GENRE_OTHER_LABEL]);
    expect(snap.genres).not.toContain("metal");
  });

  it("emits genre names only — no counts to subtract against", () => {
    const reviews = Array.from({ length: 10 }, () =>
      review({ genreTags: ["rock"] }),
    );
    const snap = snapshotOf(reviews);

    expect(snap.genres).toEqual(["rock"]);
    for (const g of snap.genres!) expect(typeof g).toBe("string");
  });
});

// ── PLATFORM embargo (FR-005) ────────────────────────────────────────────────

describe("isReviewPubliclyIncludable", () => {
  const NOW = new Date("2026-07-14T12:00:00.000Z");
  const daysAgo = (d: number) =>
    new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

  it("SURVEY and IMPORTED reviews are always includable", () => {
    for (const source of ["SURVEY", "IMPORTED"] as const) {
      expect(
        isReviewPubliclyIncludable(
          { source, eventEndsAt: daysAgo(1), gigDate: null },
          NOW,
        ),
      ).toBe(true);
    }
  });

  it("PLATFORM review from an event 3 days ago is embargoed", () => {
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: daysAgo(3), gigDate: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("PLATFORM review becomes includable exactly at the 14-day boundary", () => {
    expect(PLATFORM_REVIEW_EMBARGO_DAYS).toBe(14);
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: daysAgo(13.99), gigDate: null },
        NOW,
      ),
    ).toBe(false);
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: daysAgo(14), gigDate: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("falls back to gigDate when the event row is missing", () => {
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: null, gigDate: daysAgo(3) },
        NOW,
      ),
    ).toBe(false);
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: null, gigDate: daysAgo(15) },
        NOW,
      ),
    ).toBe(true);
  });

  it("gigDate fallback embargoes an extra day (date-only anchors under-count)", () => {
    // gigDate is midnight UTC while gigs end in the small hours of the NEXT
    // day, so the fallback treats gigDate + 1 day as the event end.
    // 13.5d via gigDate ≈ 12.5d post-event → still embargoed:
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: null, gigDate: daysAgo(13.5) },
        NOW,
      ),
    ).toBe(false);
    // 14.5d would clear a naive 14-day check, but not with the slack:
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: null, gigDate: daysAgo(14.5) },
        NOW,
      ),
    ).toBe(false);
    // 15d via gigDate = 14d past the assumed event end → included:
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: null, gigDate: daysAgo(15) },
        NOW,
      ),
    ).toBe(true);
  });

  it("includable when neither event date nor gigDate exists", () => {
    expect(
      isReviewPubliclyIncludable(
        { source: "PLATFORM", eventEndsAt: null, gigDate: null },
        NOW,
      ),
    ).toBe(true);
  });
});

// ── Serving-side headline extraction (FR-001/FR-003 chokepoint) ─────────────

describe("toPublicHeadlineSummary", () => {
  it("returns the coarse band + pct for a published headline", () => {
    expect(
      toPublicHeadlineSummary({
        version: 1,
        headline: { reviewCountBand: "20+", wouldPlayAgainPct: 85 },
      }),
    ).toStrictEqual({ reviewCountBand: "20+", wouldPlayAgainPct: 85 });
  });

  it("nulls the pct when the headline omits it", () => {
    expect(
      toPublicHeadlineSummary({
        version: 1,
        headline: { reviewCountBand: "4" },
      }),
    ).toStrictEqual({ reviewCountBand: "4", wouldPlayAgainPct: null });
  });

  it("returns null for headline-less, invalid, and non-object snapshots", () => {
    expect(toPublicHeadlineSummary({ version: 1 })).toBeNull();
    expect(toPublicHeadlineSummary(null)).toBeNull();
    expect(toPublicHeadlineSummary(undefined)).toBeNull();
    expect(toPublicHeadlineSummary("garbage")).toBeNull();
    expect(
      toPublicHeadlineSummary({ version: 99, headline: {} }),
    ).toBeNull();
  });
});
