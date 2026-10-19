import { describe, expect, it } from "vitest";

import {
  MIN_REVIEWERS,
  PERCENT_STEP,
  SCORE_STEP,
  SNAPSHOT_VERSION,
  attendeeReviewSnapshotSchema,
  buildAttendeeReviewSnapshot,
  computeExactEventAggregate,
  type AttendeeReviewAggInput,
} from "../aggregation-policy";

// ── Helpers ──────────────────────────────────────────────────────────────────

let counter = 0;
/** A review from a DISTINCT reviewer (fresh reviewerKey) unless one is supplied. */
function review(
  overrides: Partial<AttendeeReviewAggInput> = {},
): AttendeeReviewAggInput {
  counter += 1;
  return {
    reviewerKey: `human-${counter}`,
    overallRating: 5,
    soundQuality: null,
    venueComfort: null,
    organization: null,
    valueForMoney: null,
    ...overrides,
  };
}

function snapshotFrom(reviews: AttendeeReviewAggInput[]) {
  return buildAttendeeReviewSnapshot(reviews);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("attendee-review aggregation policy", () => {
  it("MIN_REVIEWERS is 5 — stricter than place reviews' k=3", () => {
    // Attendee identity is known internally; a small-event n=3 correlates to
    // "the people who came" (spec FR-003). This constant is load-bearing.
    expect(MIN_REVIEWERS).toBe(5);
  });

  describe("presence at the k boundary (NFR-001)", () => {
    it("suppresses the whole summary at n=4 (k-1)", () => {
      const snapshot = snapshotFrom([review(), review(), review(), review()]);
      expect(snapshot).toStrictEqual({ version: SNAPSHOT_VERSION });
      expect(snapshot.summary).toBeUndefined();
    });

    it("publishes the summary at exactly n=5 (k)", () => {
      const snapshot = snapshotFrom([
        review(),
        review(),
        review(),
        review(),
        review(),
      ]);
      expect(snapshot.summary).toBeDefined();
      expect(snapshot.summary?.reviewCountBand).toBe("5");
    });

    it("counts DISTINCT reviewers, not rows — 5 rows from 4 humans stays absent", () => {
      // One human reviewed two different events at the same venue; that is 5
      // rows but only 4 distinct reviewers, so nothing publishes.
      const repeat = "same-human";
      const snapshot = snapshotFrom([
        review({ reviewerKey: repeat }),
        review({ reviewerKey: repeat }),
        review(),
        review(),
        review(),
      ]);
      expect(snapshot.summary).toBeUndefined();
    });
  });

  describe("per-facet independent gating", () => {
    it("omits a facet only a subset rated, even when overall clears", () => {
      // 5 distinct reviewers (overall clears); only 2 rated soundQuality (below
      // MIN_REVIEWERS) — that facet must stay absent (it'd leak ~2 raw scores).
      const snapshot = snapshotFrom([
        review({ soundQuality: 5 }),
        review({ soundQuality: 4 }),
        review(),
        review(),
        review(),
      ]);
      expect(snapshot.summary?.overallScore).toBeDefined();
      expect(snapshot.summary?.soundQualityScore).toBeUndefined();
    });

    it("includes a facet once ≥ MIN_REVIEWERS distinct reviewers rated it", () => {
      const snapshot = snapshotFrom([
        review({ soundQuality: 5 }),
        review({ soundQuality: 5 }),
        review({ soundQuality: 4 }),
        review({ soundQuality: 4 }),
        review({ soundQuality: 5 }),
      ]);
      expect(snapshot.summary?.soundQualityScore).toBeDefined();
    });
  });

  describe("bucket alignment on every emitted number (NFR-001)", () => {
    it("rounds scores to 0.5 steps and percentages to 5% steps", () => {
      // overall: [5,4,4,3,4] mean = 4.0; recommend (>=4): 4/5 = 80%.
      const snapshot = snapshotFrom([
        review({ overallRating: 5, soundQuality: 5 }),
        review({ overallRating: 4, soundQuality: 4 }),
        review({ overallRating: 4, soundQuality: 4 }),
        review({ overallRating: 3, soundQuality: 3 }),
        review({ overallRating: 4, soundQuality: 5 }),
      ]);
      const s = snapshot.summary!;
      // Every score is a multiple of SCORE_STEP (0.5).
      for (const value of [
        s.overallScore,
        s.soundQualityScore,
      ]) {
        expect(value).toBeDefined();
        expect(Math.round((value! / SCORE_STEP) as number)).toBeCloseTo(
          value! / SCORE_STEP,
        );
      }
      expect(s.overallScore).toBe(4);
      // recommendPct is a multiple of PERCENT_STEP (5).
      expect(s.recommendPct! % PERCENT_STEP).toBe(0);
      expect(s.recommendPct).toBe(80);
    });

    it("rounds a 4.2 overall mean down to 4.0 (0.5-step lossiness)", () => {
      // means: [5,4,4,4,4] = 4.2 → 4.0
      const snapshot = snapshotFrom([
        review({ overallRating: 5 }),
        review({ overallRating: 4 }),
        review({ overallRating: 4 }),
        review({ overallRating: 4 }),
        review({ overallRating: 4 }),
      ]);
      expect(snapshot.summary?.overallScore).toBe(4);
    });

    it("rounds a 4.3 overall mean up to 4.5", () => {
      // means: [5,5,4,4,3.5? no ints] use [5,5,4,4,4] = 4.4 → 4.5
      const snapshot = snapshotFrom([
        review({ overallRating: 5 }),
        review({ overallRating: 5 }),
        review({ overallRating: 4 }),
        review({ overallRating: 4 }),
        review({ overallRating: 4 }),
      ]);
      expect(snapshot.summary?.overallScore).toBe(4.5);
    });
  });

  describe("count bands", () => {
    it("shows exact below 20 then 20+ / 50+", () => {
      const many = (n: number) =>
        snapshotFrom(Array.from({ length: n }, () => review()));
      expect(many(19).summary?.reviewCountBand).toBe("19");
      expect(many(20).summary?.reviewCountBand).toBe("20+");
      expect(many(50).summary?.reviewCountBand).toBe("50+");
    });
  });

  it("always emits a schema-valid snapshot (write-time contract)", () => {
    for (const n of [0, 4, 5, 21]) {
      const snapshot = snapshotFrom(
        Array.from({ length: n }, () =>
          review({ soundQuality: 4, venueComfort: 5, organization: 3, valueForMoney: 4 }),
        ),
      );
      expect(attendeeReviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
  });

  describe("verified/community source split (FR-010)", () => {
    const verified = (o: Partial<AttendeeReviewAggInput> = {}) =>
      review({ source: "VERIFIED_TICKET", ...o });
    const community = (o: Partial<AttendeeReviewAggInput> = {}) =>
      review({ source: "COMMUNITY", ...o });

    it("a verified-only set (EVENT/OWNER/SERIES shape) NEVER emits a community line", () => {
      // EVENT/OWNER/SERIES subjects only ever receive verified rows (community
      // rows carry null event/owner/series), so `community` must stay absent.
      const snapshot = buildAttendeeReviewSnapshot([
        verified(),
        verified(),
        verified(),
        verified(),
        verified(),
      ]);
      expect(snapshot.summary).toBeDefined();
      expect(snapshot.community).toBeUndefined();
    });

    it("suppresses each source INDEPENDENTLY on its own k (5 verified + 3 community)", () => {
      // Verified clears k=5 → headline publishes. Community is only 3 (below
      // MIN_REVIEWERS) → community line stays absent. Community volume never
      // lifts, and never leaks into, the verified figure.
      const snapshot = buildAttendeeReviewSnapshot([
        verified(),
        verified(),
        verified(),
        verified(),
        verified(),
        community(),
        community(),
        community(),
      ]);
      expect(snapshot.summary).toBeDefined();
      expect(snapshot.summary?.reviewCountBand).toBe("5");
      expect(snapshot.community).toBeUndefined();
    });

    it("publishes a community line ONLY when community itself clears k (3 verified + 5 community)", () => {
      // The inverse: community clears its own k=5 while verified (3) is below.
      // Community publishes; the verified headline stays absent — community can
      // never masquerade as verified.
      const snapshot = buildAttendeeReviewSnapshot([
        verified(),
        verified(),
        verified(),
        community(),
        community(),
        community(),
        community(),
        community(),
      ]);
      expect(snapshot.summary).toBeUndefined();
      expect(snapshot.community).toBeDefined();
      expect(snapshot.community?.reviewCountBand).toBe("5");
    });

    it("emits BOTH lines with independent counts when each clears k", () => {
      const snapshot = buildAttendeeReviewSnapshot([
        ...Array.from({ length: 6 }, () => verified()),
        ...Array.from({ length: 5 }, () => community()),
      ]);
      expect(snapshot.summary?.reviewCountBand).toBe("6");
      expect(snapshot.community?.reviewCountBand).toBe("5");
      // The verified headline counts VERIFIED_TICKET only — not the 11 total.
      expect(snapshot.summary?.reviewCountBand).not.toBe("11");
    });

    it("stays schema-valid with both slices present", () => {
      const snapshot = buildAttendeeReviewSnapshot([
        ...Array.from({ length: 6 }, () =>
          verified({ soundQuality: 4, venueComfort: 5 }),
        ),
        ...Array.from({ length: 6 }, () =>
          community({ soundQuality: 3, organization: 4 }),
        ),
      ]);
      expect(attendeeReviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    });
  });

  describe("computeExactEventAggregate (FR-007 — organizer's own numbers)", () => {
    it("returns UNROUNDED means with no k-gate", () => {
      // 3 reviewers only (below MIN_REVIEWERS) — organizers still see exact.
      const agg = computeExactEventAggregate([
        review({ overallRating: 5, soundQuality: 4 }),
        review({ overallRating: 4, soundQuality: 3 }),
        review({ overallRating: 3, soundQuality: null }),
      ]);
      expect(agg.reviewCount).toBe(3);
      expect(agg.overallMean).toBeCloseTo(4);
      // soundQuality mean over the 2 who answered = 3.5 (unrounded).
      expect(agg.soundQualityMean).toBeCloseTo(3.5);
      expect(agg.valueForMoneyMean).toBeNull();
    });
  });
});
