/**
 * Place-review anonymization policy (spec: 2026-07-13/completed/place-review-anonymization).
 *
 * The single policy every PUBLIC read of place-review data must pass through
 * (FR-001). Holds all domain constants — thresholds, bucket sizes, the
 * platform-review embargo — and the pure shaping that turns raw review rows
 * into the public-safe snapshot persisted on PlaceStats.publicSnapshot.
 *
 * Mechanics (k-gating, bucket rounding, count bands) come from the shared
 * primitives in lib/aggregate-suppression (FR-009); only the constants and
 * the domain shape live here.
 *
 * Everything in this module is pure. Data loading and persistence live in
 * recompute-public-snapshots.ts; serving lives in get-place-public-stats.ts.
 */
import { z } from "zod";

import type {
  DayOfWeekEntry,
  GenreCloudEntry,
  PlaceReviewPaymentMethod,
  PlaceReviewSource,
} from "@th/ports/repos/place-reviews";

import {
  passesThreshold,
  roundPercentToStep,
  roundToBucket,
  toCountBand,
} from "../../lib/aggregate-suppression";

// ---------------------------------------------------------------------------
// Domain constants (FR-001, FR-003, FR-004, FR-005)
// ---------------------------------------------------------------------------

/** Headline aggregates (count band, would-play-again, scores) need ≥ 3 visible reviews. */
export const MIN_HEADLINE_REVIEWS = 3;
/** Payout figures need ≥ 5 reviews actually carrying payout data. */
export const MIN_PAYOUT_REVIEWS = 5;
/** Day-of-week and genre-cloud slices need ≥ 10 visible reviews. */
export const MIN_SLICE_REVIEWS = 10;
/** Genres with fewer than 3 reviews at the place fold into "other" (FR-004). */
export const MIN_GENRE_REVIEWS = 3;
/** Display name of the folded rare-genre bucket. */
export const GENRE_OTHER_LABEL = "other";
/** Payout median/min/max round to $25 buckets (FR-003). */
export const PAYOUT_BUCKET_CENTS = 2500;
/** All public percentages round to 5% steps (FR-003). */
export const PERCENT_STEP = 5;
/** 0–5 scores round to the nearest half point so n→n+1 averages are lossy. */
export const SCORE_STEP = 0.5;
/** Review counts display exact below 20, then as "20+" / "50+" bands (FR-003). */
export const REVIEW_COUNT_BANDS = [20, 50] as const;
/**
 * PLATFORM-sourced reviews stay out of the public snapshot until this many
 * days after their event ended (FR-005) — a venue can't correlate a stats
 * change with last weekend's one gig.
 */
export const PLATFORM_REVIEW_EMBARGO_DAYS = 14;

export const SNAPSHOT_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public snapshot shape (persisted verbatim on PlaceStats.publicSnapshot)
// ---------------------------------------------------------------------------
//
// Suppression contract: a below-threshold slice is ABSENT (key omitted),
// never zeroed or nulled. Every number in this shape is coarsened:
//   - counts        → bands past 20 ("20+", "50+"), exact below
//   - percentages   → multiples of PERCENT_STEP (5)
//   - payout cents  → multiples of PAYOUT_BUCKET_CENTS (2500)
//   - 0–5 scores    → multiples of SCORE_STEP (0.5)
// Genres carry NO counts (ordered by frequency, rare ones folded to "other")
// and are never combined with any other slice.

export const placePublicSnapshotSchema = z
  .object({
    version: z.literal(SNAPSHOT_VERSION),
    /** Present only when ≥ MIN_HEADLINE_REVIEWS visible reviews exist. */
    headline: z
      .object({
        /** "3".."19" exact, then "20+" / "50+". */
        reviewCountBand: z.string(),
        wouldPlayAgainPct: z.number().optional(),
        promotionScore: z.number().optional(),
        soundScore: z.number().optional(),
        stageEquipmentScore: z.number().optional(),
        parkingScore: z.number().optional(),
        bookerScore: z.number().optional(),
        staffSupportScore: z.number().optional(),
      })
      .strict()
      .optional(),
    /** Present only when ≥ MIN_PAYOUT_REVIEWS reviews carry payoutCents. */
    payout: z
      .object({
        sampleSizeBand: z.string(),
        medianCents: z.number(),
        minCents: z.number(),
        maxCents: z.number(),
        /**
         * Payment-method mix, 5%-stepped; zero-occurrence methods omitted.
         * Denominator decision: shares are over ALL eligible reviews
         * (reviewCount) — every review carries a paymentMethod, so the mix
         * answers "how are gigs here compensated?" independent of whether a
         * dollar amount was reported. Every enum method has a key here
         * (absent = zero occurrences), so the emitted mix is self-consistent:
         * shares sum to ~100% modulo 5%-step rounding.
         */
        methodPcts: z
          .object({
            guarantee: z.number().optional(),
            doorSplit: z.number().optional(),
            ticketSales: z.number().optional(),
            barPercentage: z.number().optional(),
            tips: z.number().optional(),
            payToPlay: z.number().optional(),
            unpaid: z.number().optional(),
            other: z.number().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Present only when ≥ MIN_SLICE_REVIEWS visible reviews exist. */
    dayOfWeek: z
      .array(z.object({ day: z.number(), pct: z.number() }).strict())
      .optional(),
    /**
     * Genre names ordered by frequency (no counts). Genres with fewer than
     * MIN_GENRE_REVIEWS fold into GENRE_OTHER_LABEL; omitted entirely when
     * no genre clears the fold threshold or below MIN_SLICE_REVIEWS.
     */
    genres: z.array(z.string()).optional(),
  })
  .strict();

export type PlacePublicSnapshot = z.infer<typeof placePublicSnapshotSchema>;

// ---------------------------------------------------------------------------
// Snapshot consumption (serving side)
// ---------------------------------------------------------------------------

/** Coarse headline summary for "trusted venues near you" style lists. */
export type PublicHeadlineSummary = {
  /** "3".."19" exact, then "20+" / "50+" — never an exact live count. */
  reviewCountBand: string;
  /** 5%-stepped share (0–100) from the snapshot, or null when unavailable. */
  wouldPlayAgainPct: number | null;
};

/**
 * Extracts the coarsened headline slice from a stored publicSnapshot value.
 * Returns null when the snapshot is missing, invalid, or has no published
 * headline — callers must EXCLUDE such places (fail closed) and must never
 * fall back to live PlaceStats columns (FR-001/FR-003).
 */
export function toPublicHeadlineSummary(
  snapshot: unknown,
): PublicHeadlineSummary | null {
  const parsed = placePublicSnapshotSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.headline === undefined) return null;
  return {
    reviewCountBand: parsed.data.headline.reviewCountBand,
    wouldPlayAgainPct: parsed.data.headline.wouldPlayAgainPct ?? null,
  };
}

// ---------------------------------------------------------------------------
// Eligibility (FR-005): PLATFORM embargo
// ---------------------------------------------------------------------------

export type SnapshotEligibilityInput = {
  source: PlaceReviewSource;
  /** End (or start, when no end) of the linked event — null when unknown. */
  eventEndsAt: Date | null;
  /** Reviewer-entered gig date — fallback when the event row is missing. */
  gigDate: Date | null;
};

/**
 * True when a review may contribute to the public snapshot at `now`.
 * PLATFORM reviews are embargoed until PLATFORM_REVIEW_EMBARGO_DAYS after
 * their event ended; when the event row is gone we fall back to gigDate, and
 * when neither date exists the review is includable (nothing to correlate).
 */
export function isReviewPubliclyIncludable(
  review: SnapshotEligibilityInput,
  now: Date,
): boolean {
  if (review.source !== "PLATFORM") return true;
  // gigDate is reviewer-entered and date-only (midnight UTC), while gigs
  // routinely run past midnight — a Friday-night set ends ~04:00 UTC
  // Saturday — so anchoring the embargo on midnight would under-embargo by
  // up to a day (~13-day effective embargo). When falling back to gigDate,
  // treat gigDate + 1 day as the event end.
  const anchor =
    review.eventEndsAt ??
    (review.gigDate === null
      ? null
      : new Date(review.gigDate.getTime() + DAY_MS));
  if (anchor === null) return true;
  return now.getTime() - anchor.getTime() >= PLATFORM_REVIEW_EMBARGO_DAYS * DAY_MS;
}

// ---------------------------------------------------------------------------
// Aggregation over eligible reviews
// ---------------------------------------------------------------------------

/** The per-review fields the snapshot pipeline consumes (PlaceReviewRecord is a superset). */
export type SnapshotReviewInput = {
  payoutCents: number | null;
  paymentMethod: PlaceReviewPaymentMethod;
  wouldPlayAgain: "YES" | "MAYBE" | "NO";
  venuePromoted: string;
  soundQuality: string;
  stageEquipment: string;
  parkingLoadIn: string;
  bookerRating: string;
  staffSupport: string | null;
  dayOfWeek: number | null;
  genre: string | null;
  genreTags: string[];
};

/**
 * Exact (uncoarsened) aggregates over the ELIGIBLE review set, plus the
 * underlying counts the thresholds gate on. Internal to the policy pipeline —
 * these exact figures must never leave this module (FR-003); only
 * buildPublicSnapshot's output is public.
 */
export type SnapshotAggregates = {
  reviewCount: number;
  wouldPlayAgainPct: number | null;
  scores: {
    promotion: number | null;
    sound: number | null;
    stageEquipment: number | null;
    parking: number | null;
    booker: number | null;
    staffSupport: number | null;
  };
  payoutSampleSize: number;
  payoutMedianCents: number | null;
  payoutMinCents: number | null;
  payoutMaxCents: number | null;
  paymentMethodCounts: Partial<Record<PlaceReviewPaymentMethod, number>>;
  dayOfWeekCounts: DayOfWeekEntry[];
  genreCounts: GenreCloudEntry[];
};

// Enum → 0–5 score mapping (same scale as recalculate-place-stats.ts).
const SCORE_MAP: Record<string, number> = {
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
  // Parking
  DEDICATED_LOT: 5,
  STREET_NEARBY: 3,
  DIFFICULT: 1,
  NIGHTMARE: 0,
  // StaffSupport
  YES: 5,
  SOMEWHAT: 3,
  NO: 1,
};

function averageScore(values: Array<string | null>): number | null {
  const scores = values
    .map((v) => (v === null ? undefined : SCORE_MAP[v]))
    .filter((v): v is number => v !== undefined);
  if (scores.length === 0) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function median(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 !== 0
    ? sortedAsc[mid]!
    : Math.round((sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2);
}

/**
 * Computes exact aggregates from the eligible review rows. Pure; the caller
 * (recompute-public-snapshots) is responsible for having already filtered to
 * visible + non-embargoed reviews via {@link isReviewPubliclyIncludable}.
 */
export function computeSnapshotAggregates(
  reviews: SnapshotReviewInput[],
): SnapshotAggregates {
  const reviewCount = reviews.length;

  const playAgainYes = reviews.filter((r) => r.wouldPlayAgain === "YES").length;
  const wouldPlayAgainPct =
    reviewCount > 0 ? (playAgainYes / reviewCount) * 100 : null;

  const payoutValues = reviews
    .map((r) => r.payoutCents)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  const paymentMethodCounts: Partial<Record<PlaceReviewPaymentMethod, number>> =
    {};
  for (const r of reviews) {
    paymentMethodCounts[r.paymentMethod] =
      (paymentMethodCounts[r.paymentMethod] ?? 0) + 1;
  }

  const dowCounts = new Map<number, number>();
  for (const r of reviews) {
    if (r.dayOfWeek !== null) {
      dowCounts.set(r.dayOfWeek, (dowCounts.get(r.dayOfWeek) ?? 0) + 1);
    }
  }

  // Genre counts combine the legacy single field and v3 tags. Counting is
  // per DISTINCT REVIEW: within one review, `genre`/`genreTags` duplicates
  // (the web form systematically sends genre === genreTags[0]) and
  // case/whitespace variants ("metal" vs "Metal ") collapse to a single
  // contribution — otherwise MIN_GENRE_REVIEWS (k=3) would effectively gate
  // on occurrences, letting a single act's 2 reviews clear the fold.
  // Normalized (trimmed, lowercased) names are also what the snapshot emits —
  // same display strategy as recalculate-place-stats.
  const genreCounts = new Map<string, number>();
  for (const r of reviews) {
    const distinct = new Set(
      [r.genre, ...r.genreTags]
        .map((tag) => tag?.toLowerCase().trim())
        .filter((tag): tag is string => Boolean(tag)),
    );
    for (const normalized of distinct) {
      genreCounts.set(normalized, (genreCounts.get(normalized) ?? 0) + 1);
    }
  }

  return {
    reviewCount,
    wouldPlayAgainPct,
    scores: {
      promotion: averageScore(reviews.map((r) => r.venuePromoted)),
      sound: averageScore(reviews.map((r) => r.soundQuality)),
      stageEquipment: averageScore(reviews.map((r) => r.stageEquipment)),
      parking: averageScore(reviews.map((r) => r.parkingLoadIn)),
      booker: averageScore(reviews.map((r) => r.bookerRating)),
      staffSupport: averageScore(reviews.map((r) => r.staffSupport)),
    },
    payoutSampleSize: payoutValues.length,
    payoutMedianCents: payoutValues.length > 0 ? median(payoutValues) : null,
    payoutMinCents: payoutValues.length > 0 ? payoutValues[0]! : null,
    payoutMaxCents:
      payoutValues.length > 0 ? payoutValues[payoutValues.length - 1]! : null,
    paymentMethodCounts,
    dayOfWeekCounts: [...dowCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, count]) => ({ day, count })),
    genreCounts: [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([genre, count]) => ({ genre, count })),
  };
}

// ---------------------------------------------------------------------------
// Snapshot shaping (the one public exit for these numbers)
// ---------------------------------------------------------------------------

function roundScore(score: number | null): number | undefined {
  if (score === null) return undefined;
  // SCORE_STEP is fractional, so scale to integer bucket math (×10 → step 5).
  return roundToBucket(score * 10, SCORE_STEP * 10) / 10;
}

function methodPct(
  counts: Partial<Record<PlaceReviewPaymentMethod, number>>,
  method: PlaceReviewPaymentMethod,
  total: number,
): number | undefined {
  const count = counts[method] ?? 0;
  if (count === 0 || total === 0) return undefined;
  return roundPercentToStep((count / total) * 100, PERCENT_STEP);
}

function omitUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Shapes exact aggregates into the public-safe snapshot (FR-001/003/004).
 * Below-threshold slices are ABSENT from the returned object; every emitted
 * number is bucket-aligned per the constants above. A place below the
 * headline threshold yields `{ version: 1 }` — publish nothing, not zeroes.
 */
export function buildPublicSnapshot(
  agg: SnapshotAggregates,
): PlacePublicSnapshot {
  const snapshot: PlacePublicSnapshot = { version: SNAPSHOT_VERSION };

  if (passesThreshold(agg.reviewCount, MIN_HEADLINE_REVIEWS)) {
    snapshot.headline = omitUndefined({
      reviewCountBand: toCountBand(agg.reviewCount, REVIEW_COUNT_BANDS),
      wouldPlayAgainPct:
        agg.wouldPlayAgainPct === null
          ? undefined
          : roundPercentToStep(agg.wouldPlayAgainPct, PERCENT_STEP),
      promotionScore: roundScore(agg.scores.promotion),
      soundScore: roundScore(agg.scores.sound),
      stageEquipmentScore: roundScore(agg.scores.stageEquipment),
      parkingScore: roundScore(agg.scores.parking),
      bookerScore: roundScore(agg.scores.booker),
      staffSupportScore: roundScore(agg.scores.staffSupport),
    });
  }

  if (
    passesThreshold(agg.payoutSampleSize, MIN_PAYOUT_REVIEWS) &&
    agg.payoutMedianCents !== null &&
    agg.payoutMinCents !== null &&
    agg.payoutMaxCents !== null
  ) {
    // Denominator = reviewCount (all eligible reviews), NOT payout sample —
    // see the methodPcts schema comment. Every enum method is emitted (when
    // non-zero) so the mix stays self-consistent.
    const methodPcts = omitUndefined({
      guarantee: methodPct(agg.paymentMethodCounts, "GUARANTEE", agg.reviewCount),
      doorSplit: methodPct(agg.paymentMethodCounts, "DOOR_SPLIT", agg.reviewCount),
      ticketSales: methodPct(
        agg.paymentMethodCounts,
        "TICKET_SALES",
        agg.reviewCount,
      ),
      barPercentage: methodPct(
        agg.paymentMethodCounts,
        "BAR_PERCENTAGE",
        agg.reviewCount,
      ),
      tips: methodPct(agg.paymentMethodCounts, "TIPS_ONLY", agg.reviewCount),
      payToPlay: methodPct(
        agg.paymentMethodCounts,
        "PAY_TO_PLAY",
        agg.reviewCount,
      ),
      unpaid: methodPct(agg.paymentMethodCounts, "UNPAID", agg.reviewCount),
      other: methodPct(agg.paymentMethodCounts, "OTHER", agg.reviewCount),
    });
    snapshot.payout = {
      sampleSizeBand: toCountBand(agg.payoutSampleSize, REVIEW_COUNT_BANDS),
      medianCents: roundToBucket(agg.payoutMedianCents, PAYOUT_BUCKET_CENTS),
      minCents: roundToBucket(agg.payoutMinCents, PAYOUT_BUCKET_CENTS),
      maxCents: roundToBucket(agg.payoutMaxCents, PAYOUT_BUCKET_CENTS),
      ...(Object.keys(methodPcts).length > 0 ? { methodPcts } : {}),
    };
  }

  if (passesThreshold(agg.reviewCount, MIN_SLICE_REVIEWS)) {
    if (agg.dayOfWeekCounts.length > 0) {
      snapshot.dayOfWeek = agg.dayOfWeekCounts.map(({ day, count }) => ({
        day,
        pct: roundPercentToStep((count / agg.reviewCount) * 100, PERCENT_STEP),
      }));
    }

    // Genre cloud: only genres with ≥ MIN_GENRE_REVIEWS; rarer fold into
    // "other". Omit the slice entirely when no genre clears the fold — a
    // lone "other" bucket would only advertise that rare genres exist.
    const kept = agg.genreCounts.filter((g) =>
      passesThreshold(g.count, MIN_GENRE_REVIEWS),
    );
    const folded = agg.genreCounts.length > kept.length;
    if (kept.length > 0) {
      snapshot.genres = [
        ...kept.map((g) => g.genre),
        ...(folded ? [GENRE_OTHER_LABEL] : []),
      ];
    }
  }

  return snapshot;
}
