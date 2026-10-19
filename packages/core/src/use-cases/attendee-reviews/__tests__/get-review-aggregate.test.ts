import { describe, expect, it, vi } from "vitest";

import { getReviewAggregate } from "../get-review-aggregate";
import type { GetReviewAggregateDeps } from "../get-review-aggregate";

const PLACE_ID = "cccccccc-1111-4111-8111-cccccccccccc";
const COMPUTED_AT = new Date("2026-07-16T07:00:00.000Z");

const publishedSnapshot = {
  version: 1,
  summary: { reviewCountBand: "5", overallScore: 4.5, recommendPct: 80 },
};

function makeDeps(opts: {
  row?: { snapshot: unknown; computedAt: Date } | null;
  reportError?: GetReviewAggregateDeps["reportError"];
  /** Place.attendeeReviewsPublic for the PLACE opt-in gate (default true). */
  attendeeReviewsPublic?: boolean;
  /** When true, places.getById resolves null (place missing). */
  placeMissing?: boolean;
}) {
  const getBySubject = vi.fn(async () =>
    opts.row === undefined ? null : opts.row,
  );
  const getById = vi.fn(async () =>
    opts.placeMissing
      ? null
      : { attendeeReviewsPublic: opts.attendeeReviewsPublic ?? true },
  );
  const deps: GetReviewAggregateDeps = {
    repos: { reviewAggregates: { getBySubject }, places: { getById } } as any,
    reportError: opts.reportError,
  };
  return { deps, getBySubject, getById };
}

describe("getReviewAggregate", () => {
  const input = { subjectType: "PLACE" as const, subjectId: PLACE_ID };

  it("serves a published snapshot verbatim", async () => {
    const { deps } = makeDeps({
      row: { snapshot: publishedSnapshot, computedAt: COMPUTED_AT },
    });

    const result = await getReviewAggregate(deps, input);

    expect(result).toStrictEqual({
      subjectType: "PLACE",
      subjectId: PLACE_ID,
      snapshot: publishedSnapshot,
      computedAt: COMPUTED_AT,
    });
  });

  it("returns null when no aggregate is published", async () => {
    const { deps } = makeDeps({ row: null });

    const result = await getReviewAggregate(deps, input);

    expect(result.snapshot).toBeNull();
    expect(result.computedAt).toBeNull();
  });

  it("returns null for a below-threshold { version: 1 } (no summary)", async () => {
    const { deps } = makeDeps({
      row: { snapshot: { version: 1 }, computedAt: COMPUTED_AT },
    });

    const result = await getReviewAggregate(deps, input);

    // Fail closed: an empty aggregate exposes nothing, not a shell.
    expect(result.snapshot).toBeNull();
    expect(result.computedAt).toBeNull();
  });

  it("fails closed AND reports when the stored snapshot is corrupt", async () => {
    const reportError = vi.fn();
    const { deps } = makeDeps({
      row: {
        // Off-schema (extra key) — .strict() rejects; must never serve raw.
        snapshot: { version: 1, summary: { reviewCountBand: "5", overallScore: 4.5 }, bogus: true },
        computedAt: COMPUTED_AT,
      },
      reportError,
    });

    const result = await getReviewAggregate(deps, input);

    expect(result.snapshot).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toStrictEqual({
      tags: { useCase: "getReviewAggregate", subjectType: "PLACE" },
      extra: { subjectId: PLACE_ID },
    });
  });

  it("a throwing reporter never changes the (null) result", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps } = makeDeps({
      row: { snapshot: { version: 2 }, computedAt: COMPUTED_AT },
      reportError,
    });

    const result = await getReviewAggregate(deps, input);

    expect(result.snapshot).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid subjectType", async () => {
    const { deps } = makeDeps({ row: null });
    await expect(
      getReviewAggregate(deps, { subjectType: "VENUE", subjectId: PLACE_ID }),
    ).rejects.toBeDefined();
  });

  // ── FR-005 PLACE opt-in gate ───────────────────────────────────────────────

  it("hides the PLACE aggregate when attendeeReviewsPublic is false", async () => {
    const { deps, getBySubject, getById } = makeDeps({
      row: { snapshot: publishedSnapshot, computedAt: COMPUTED_AT },
      attendeeReviewsPublic: false,
    });

    const result = await getReviewAggregate(deps, input);

    // Gate fires BEFORE the snapshot is even read — the toggle is instant.
    expect(result.snapshot).toBeNull();
    expect(result.computedAt).toBeNull();
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getBySubject).not.toHaveBeenCalled();
  });

  it("serves the PLACE aggregate when attendeeReviewsPublic is true", async () => {
    const { deps, getById } = makeDeps({
      row: { snapshot: publishedSnapshot, computedAt: COMPUTED_AT },
      attendeeReviewsPublic: true,
    });

    const result = await getReviewAggregate(deps, input);

    expect(result.snapshot).toStrictEqual(publishedSnapshot);
    expect(result.computedAt).toStrictEqual(COMPUTED_AT);
    expect(getById).toHaveBeenCalledTimes(1);
  });

  it("hides the PLACE aggregate when the place is missing (fail closed)", async () => {
    const { deps } = makeDeps({
      row: { snapshot: publishedSnapshot, computedAt: COMPUTED_AT },
      placeMissing: true,
    });

    const result = await getReviewAggregate(deps, input);

    expect(result.snapshot).toBeNull();
  });

  it("does NOT gate EVENT/OWNER/SERIES subjects on attendeeReviewsPublic (FR-007)", async () => {
    for (const subjectType of ["EVENT", "OWNER", "SERIES"] as const) {
      const { deps, getById } = makeDeps({
        row: { snapshot: publishedSnapshot, computedAt: COMPUTED_AT },
        // Even with the flag off, non-PLACE subjects serve — they never read it.
        attendeeReviewsPublic: false,
      });

      const result = await getReviewAggregate(deps, {
        subjectType,
        subjectId: PLACE_ID,
      });

      expect(result.snapshot).toStrictEqual(publishedSnapshot);
      // The place flag is never consulted for these subjects.
      expect(getById).not.toHaveBeenCalled();
    }
  });
});
