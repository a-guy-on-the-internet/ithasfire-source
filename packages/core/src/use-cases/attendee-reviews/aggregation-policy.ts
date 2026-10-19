/**
 * Attendee-review aggregation policy (spec: 2026-07-14/completed/attendee-reviews FR-003).
 *
 * The single policy every PUBLIC read of attendee-review aggregates must pass
 * through. Holds all domain constants — thresholds, bucket sizes, the recompute
 * cadence — and the pure shaping that turns raw review rows into the
 * public-safe snapshot persisted on ReviewAggregate.snapshot (FR-004) and served
 * by getReviewAggregate + the audience_stats PLACE block (FR-005).
 *
 * Mechanics (k-gating, bucket rounding, percentage stepping, count bands) come
 * from the shared primitives in lib/aggregate-suppression — only the constants
 * and the domain shape live here. This is the fan-side sibling of
 * place-reviews/anonymization-policy.ts; the two are deliberately SEPARATE
 * domains with separate constants (attendee testimony vs performer testimony).
 *
 * Everything in this module is pure. Data loading and persistence live in
 * recompute-review-aggregates.ts; serving lives in get-review-aggregate.ts /
 * entity-pages/get-public-page.ts.
 */
import { z } from "zod";

import type { AttendeeReviewSource } from "@th/ports/repos/attendee-reviews";

import {
  passesThreshold,
  roundPercentToStep,
  roundToBucket,
  toCountBand,
} from "../../lib/aggregate-suppression";

// ---------------------------------------------------------------------------
// Domain constants (FR-003, FR-004)
// ---------------------------------------------------------------------------

/**
 * Minimum DISTINCT reviewers before any aggregate slice is displayed publicly.
 *
 * Deliberately HIGHER than place-reviews' MIN_HEADLINE_REVIEWS (3): attendee
 * identity is known internally (scanned-ticket-only), and at a small show n=3
 * correlates too tightly to "the three people who came" — the organizer could
 * de-anonymize a score by knowing who was in the room. Five distinct reviewers
 * is the floor at which an averaged score stops fingerprinting an individual.
 *
 * Applied PER SLICE: the count band + overall score gate on the total distinct
 * reviewer count, and each optional facet gates on the distinct reviewers who
 * actually rated THAT facet (a facet answered by only one of five reviewers is
 * that person's raw score — it must stay absent, never averaged into view).
 */
export const MIN_REVIEWERS = 5;

/** 1–5 scores round to the nearest half point so n→n+1 averages are lossy (FR-003). */
export const SCORE_STEP = 0.5;
/** All public percentages round to 5% steps (FR-003). */
export const PERCENT_STEP = 5;
/** Review counts display exact below 20, then as "20+" / "50+" bands (FR-003). */
export const REVIEW_COUNT_BANDS = [20, 50] as const;
/**
 * A review counts toward the "would recommend" proxy when its overall rating
 * is at least this (4–5 of 5). Attendee reviews carry no explicit
 * would-recommend field, so top-box overall rating is the proxy (FR-003).
 */
export const RECOMMEND_MIN_RATING = 4;

export const SNAPSHOT_VERSION = 1;

/**
 * Recompute cadence (FR-004): weekly, like place reviews. The delay IS the
 * anonymity mechanism — a fresh review changes nothing public until the next
 * snapshot, so an organizer can't correlate a public shift with one attendee.
 * Wired to the job's cron in apps/jobs/jobs.manifest.json (Cloud Scheduler is
 * an infra follow-up).
 */
export const RECOMPUTE_CADENCE = "weekly" as const;

// ---------------------------------------------------------------------------
// Public snapshot shape (persisted verbatim on ReviewAggregate.snapshot)
// ---------------------------------------------------------------------------
//
// Suppression contract: a below-threshold slice is ABSENT (key omitted), never
// zeroed or nulled. `{ version: 1 }` with no `summary` = nothing publishable
// (below MIN_REVIEWERS) — publish nothing, not zeroes. Every emitted number is
// coarsened:
//   - counts       → bands past 20 ("20+", "50+"), exact below
//   - percentages  → multiples of PERCENT_STEP (5)
//   - 1–5 scores   → multiples of SCORE_STEP (0.5)

/**
 * One coarsened, suppression-gated summary slice. Used for BOTH the verified
 * headline (`summary`) and the segregated community line (`community`) — the
 * two are computed + suppressed INDEPENDENTLY (FR-010) so community volume can
 * never lift the verified bucket over its threshold (or vice-versa).
 */
export const attendeeReviewSummarySchema = z
  .object({
    /** "5".."19" exact, then "20+" / "50+" — never an exact live count. */
    reviewCountBand: z.string(),
    /** Mean overall rating, 0.5-stepped (always present in a summary). */
    overallScore: z.number(),
    /** Share rating 4–5 of 5, 5%-stepped. */
    recommendPct: z.number().optional(),
    /** Facet means, 0.5-stepped; each present only when that facet itself
     * clears MIN_REVIEWERS distinct raters. */
    soundQualityScore: z.number().optional(),
    venueComfortScore: z.number().optional(),
    organizationScore: z.number().optional(),
    valueForMoneyScore: z.number().optional(),
  })
  .strict();

export type AttendeeReviewSummary = z.infer<typeof attendeeReviewSummarySchema>;

export const attendeeReviewSnapshotSchema = z
  .object({
    version: z.literal(SNAPSHOT_VERSION),
    /**
     * VERIFIED_TICKET headline. Present only when ≥ MIN_REVIEWERS distinct
     * VERIFIED reviewers exist. This is the ONLY "verified" figure — community
     * reviews are never merged in (FR-010).
     */
    summary: attendeeReviewSummarySchema.optional(),
    /**
     * COMMUNITY (unverified, venue-direct) line. Present only when ≥
     * MIN_REVIEWERS distinct COMMUNITY reviewers exist. Suppressed independently
     * of `summary`. Only ever populated for the PLACE subject (community rows
     * carry a null event/owner/series, so EVENT/OWNER/SERIES never see them).
     */
    community: attendeeReviewSummarySchema.optional(),
  })
  .strict();

export type AttendeeReviewSnapshot = z.infer<typeof attendeeReviewSnapshotSchema>;

// ---------------------------------------------------------------------------
// Aggregation over non-hidden reviews
// ---------------------------------------------------------------------------

/** The per-review fields the aggregation pipeline consumes. */
export type AttendeeReviewAggInput = {
  /** Distinct-reviewer gating keys off this — NOT the row count. */
  reviewerKey: string;
  /**
   * Provenance. Drives the FR-010 verified/community split in
   * buildAttendeeReviewSnapshot. Defaults to VERIFIED_TICKET when omitted so
   * the exact-aggregate callers (organizer/owner reads) stay source-agnostic.
   */
  source?: AttendeeReviewSource;
  overallRating: number;
  soundQuality: number | null;
  venueComfort: number | null;
  organization: number | null;
  valueForMoney: number | null;
};

type MetricKey =
  | "overall"
  | "soundQuality"
  | "venueComfort"
  | "organization"
  | "valueForMoney";

/**
 * Exact (uncoarsened) aggregates over the review set, plus the DISTINCT
 * reviewer counts each slice gates on. Internal to the policy pipeline — these
 * exact figures must never leave this module on a PUBLIC surface (FR-002);
 * only buildAttendeeReviewSnapshot's output is public. (The organizer feedback
 * read exposes its OWN exact aggregate separately — organizers may see their
 * own numbers — via computeExactEventAggregate.)
 */
export type AttendeeReviewAggregates = {
  /** Distinct reviewers overall (every review carries an overall rating). */
  reviewerCount: number;
  /** Distinct reviewers per metric (a facet may be answered by a subset). */
  metricReviewerCounts: Record<MetricKey, number>;
  /** Mean of each metric over the reviews that provided it, or null. */
  metricMeans: Record<MetricKey, number | null>;
  /** Share (0–100) of reviewers whose overall rating is top-box, or null. */
  recommendPct: number | null;
};

const FACET_KEYS = [
  "soundQuality",
  "venueComfort",
  "organization",
  "valueForMoney",
] as const;

function scoreOf(review: AttendeeReviewAggInput, key: MetricKey): number | null {
  return key === "overall" ? review.overallRating : review[key];
}

/**
 * Computes exact aggregates from the non-hidden review rows. Pure; the caller
 * (recompute-review-aggregates) is responsible for having filtered to
 * non-hidden reviews first.
 *
 * Means are over REVIEWS (each row a data point); presence gating is on
 * DISTINCT reviewers (humanId). At the event level rows == reviewers, but at
 * the venue/organizer/series level one human may review many events, so the
 * distinct-reviewer count is what protects anonymity.
 */
export function computeAttendeeReviewAggregates(
  reviews: AttendeeReviewAggInput[],
): AttendeeReviewAggregates {
  const metricKeys: MetricKey[] = ["overall", ...FACET_KEYS];

  const metricReviewerCounts = {} as Record<MetricKey, number>;
  const metricMeans = {} as Record<MetricKey, number | null>;

  for (const key of metricKeys) {
    const raters = new Set<string>();
    let sum = 0;
    let n = 0;
    for (const review of reviews) {
      const value = scoreOf(review, key);
      if (value !== null) {
        raters.add(review.reviewerKey);
        sum += value;
        n += 1;
      }
    }
    metricReviewerCounts[key] = raters.size;
    metricMeans[key] = n > 0 ? sum / n : null;
  }

  const overallRaters = new Set(reviews.map((r) => r.reviewerKey));
  const recommendRaters = new Set(
    reviews
      .filter((r) => r.overallRating >= RECOMMEND_MIN_RATING)
      .map((r) => r.reviewerKey),
  );
  const recommendPct =
    overallRaters.size > 0
      ? (recommendRaters.size / overallRaters.size) * 100
      : null;

  return {
    reviewerCount: overallRaters.size,
    metricReviewerCounts,
    metricMeans,
    recommendPct,
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

/**
 * Shapes ONE aggregate slice into a public-safe summary, or undefined when the
 * slice is below the distinct-reviewer threshold. Every emitted number is
 * bucket-aligned per the constants above.
 */
function buildSummary(
  agg: AttendeeReviewAggregates,
): AttendeeReviewSummary | undefined {
  // Overall gate: the whole summary only appears once enough DISTINCT
  // reviewers have contributed an overall rating.
  if (
    !passesThreshold(agg.reviewerCount, MIN_REVIEWERS) ||
    agg.metricMeans.overall === null
  ) {
    return undefined;
  }

  const overallScore = roundScore(agg.metricMeans.overall);
  // overallScore is only undefined when the mean is null, already excluded.
  if (overallScore === undefined) return undefined;

  const summary: AttendeeReviewSummary = {
    reviewCountBand: toCountBand(agg.reviewerCount, REVIEW_COUNT_BANDS),
    overallScore,
  };

  if (agg.recommendPct !== null) {
    summary.recommendPct = roundPercentToStep(agg.recommendPct, PERCENT_STEP);
  }

  // Each facet gates INDEPENDENTLY on the distinct reviewers who rated it — a
  // facet only a handful answered stays absent even when overall clears.
  for (const key of FACET_KEYS) {
    if (
      passesThreshold(agg.metricReviewerCounts[key], MIN_REVIEWERS) &&
      agg.metricMeans[key] !== null
    ) {
      const rounded = roundScore(agg.metricMeans[key]);
      if (rounded !== undefined) {
        summary[`${key}Score` as const] = rounded;
      }
    }
  }

  return summary;
}

/**
 * Shapes raw review rows into the public-safe snapshot (FR-003/FR-004/FR-010).
 *
 * VERIFIED_TICKET and COMMUNITY rows are split and aggregated SEPARATELY, then
 * each is suppressed on its OWN distinct-reviewer count (k per source): a flood
 * of community reviews can never lift the verified headline over its threshold,
 * and vice-versa. For EVENT/OWNER/SERIES subjects the row set is always
 * VERIFIED_TICKET-only (community rows carry a null event/owner/series), so
 * `community` stays absent and `summary` is unchanged from before this split.
 *
 * A subject with no publishable slice yields `{ version: 1 }` — publish
 * nothing, not zeroes.
 */
export function buildAttendeeReviewSnapshot(
  rows: AttendeeReviewAggInput[],
): AttendeeReviewSnapshot {
  const snapshot: AttendeeReviewSnapshot = { version: SNAPSHOT_VERSION };

  const verifiedRows = rows.filter((r) => (r.source ?? "VERIFIED_TICKET") === "VERIFIED_TICKET");
  const communityRows = rows.filter((r) => r.source === "COMMUNITY");

  const summary = buildSummary(computeAttendeeReviewAggregates(verifiedRows));
  if (summary) snapshot.summary = summary;

  const community = buildSummary(computeAttendeeReviewAggregates(communityRows));
  if (community) snapshot.community = community;

  return snapshot;
}

// ---------------------------------------------------------------------------
// Exact aggregate for the OWNER-scoped organizer feedback read (FR-007)
// ---------------------------------------------------------------------------
//
// Organizers may see their OWN event's exact numbers (no k-gate internally) —
// this is the ONLY place raw means leave the policy, and only to an authorized
// event owner via list-event-feedback (never a public surface).

export type ExactEventAggregate = {
  reviewCount: number;
  overallMean: number | null;
  soundQualityMean: number | null;
  venueComfortMean: number | null;
  organizationMean: number | null;
  valueForMoneyMean: number | null;
  recommendPct: number | null;
};

/**
 * Exact per-event aggregate for the organizer surface (FR-007). Rows here are
 * one event's reviews, so each row is a distinct reviewer. Means are unrounded;
 * the caller has already authorized the event owner.
 */
export function computeExactEventAggregate(
  reviews: AttendeeReviewAggInput[],
): ExactEventAggregate {
  const agg = computeAttendeeReviewAggregates(reviews);
  return {
    reviewCount: agg.reviewerCount,
    overallMean: agg.metricMeans.overall,
    soundQualityMean: agg.metricMeans.soundQuality,
    venueComfortMean: agg.metricMeans.venueComfort,
    organizationMean: agg.metricMeans.organization,
    valueForMoneyMean: agg.metricMeans.valueForMoney,
    recommendPct: agg.recommendPct,
  };
}
