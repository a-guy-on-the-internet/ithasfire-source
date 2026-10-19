import { afterEach, describe, expect, it, vi } from "vitest";

import { recomputeReviewAggregates } from "../recompute-review-aggregates";
import type { RecomputeReviewAggregatesDeps } from "../recompute-review-aggregates";
import type { ReviewAggregateSubjectType } from "@th/ports/repos/review-aggregates";

// Controllable pass-through mock for buildAttendeeReviewSnapshot so the
// write-time validation path can be exercised (a policy bug producing an
// off-schema snapshot must fail the SUBJECT in the job, not a week later at
// serve time).
const policyMock = vi.hoisted(() => ({
  buildOverride: null as null | ((agg: unknown) => unknown),
}));
vi.mock("../aggregation-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../aggregation-policy")>();
  return {
    ...actual,
    buildAttendeeReviewSnapshot: (
      rows: Parameters<typeof actual.buildAttendeeReviewSnapshot>[0],
    ) =>
      policyMock.buildOverride
        ? policyMock.buildOverride(rows)
        : actual.buildAttendeeReviewSnapshot(rows),
  };
});

afterEach(() => {
  policyMock.buildOverride = null;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-16T07:00:00.000Z");

let counter = 0;
function aggRow(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    reviewerKey: `human-${counter}`,
    source: "VERIFIED_TICKET" as const,
    overallRating: 5,
    soundQuality: null,
    venueComfort: null,
    organization: null,
    valueForMoney: null,
    ...overrides,
  };
}

/** Five distinct-reviewer rows — clears MIN_REVIEWERS so a summary publishes. */
function fiveReviews() {
  return [aggRow(), aggRow(), aggRow(), aggRow(), aggRow()];
}

const key = (t: string, id: string) => `${t}:${id}`;

type DepsOptions = {
  /** subjectIds carrying non-hidden reviews, per subject type. */
  subjectIdsByType?: Partial<Record<ReviewAggregateSubjectType, string[]>>;
  /** agg rows per `${type}:${id}`. */
  rowsBySubject?: Record<string, ReturnType<typeof aggRow>[]>;
  /** subjectIds already carrying an aggregate, per type (phase-2 union). */
  aggregatesByType?: Partial<Record<ReviewAggregateSubjectType, string[]>>;
  listAggRows?: (input: {
    subjectType: ReviewAggregateSubjectType;
    subjectId: string;
  }) => Promise<ReturnType<typeof aggRow>[]>;
  reportError?: RecomputeReviewAggregatesDeps["reportError"];
};

function makeDeps(opts: DepsOptions) {
  const listSubjectIdsWithReviews = vi.fn(
    async ({
      subjectType,
      limit,
      afterSubjectId,
    }: {
      subjectType: ReviewAggregateSubjectType;
      limit: number;
      afterSubjectId?: string;
    }) => {
      const ids = [...(opts.subjectIdsByType?.[subjectType] ?? [])].sort();
      return ids
        .filter((id) => (afterSubjectId ? id > afterSubjectId : true))
        .slice(0, limit);
    },
  );

  const listAggRowsForSubject = vi.fn(
    opts.listAggRows ??
      (async ({
        subjectType,
        subjectId,
      }: {
        subjectType: ReviewAggregateSubjectType;
        subjectId: string;
      }) => opts.rowsBySubject?.[key(subjectType, subjectId)] ?? []),
  );

  const listSubjectIdsWithAggregate = vi.fn(
    async ({
      subjectType,
      limit,
      afterSubjectId,
    }: {
      subjectType: ReviewAggregateSubjectType;
      limit: number;
      afterSubjectId?: string;
    }) => {
      const ids = [...(opts.aggregatesByType?.[subjectType] ?? [])].sort();
      return ids
        .filter((id) => (afterSubjectId ? id > afterSubjectId : true))
        .slice(0, limit);
    },
  );

  const setSnapshot = vi.fn(async () => undefined);

  const deps: RecomputeReviewAggregatesDeps = {
    repos: {
      attendeeReviews: {
        listSubjectIdsWithReviews,
        listAggRowsForSubject,
      },
      reviewAggregates: { setSnapshot, listSubjectIdsWithAggregate },
    } as any,
    clock: { now: () => NOW } as any,
    reportError: opts.reportError,
  };

  return {
    deps,
    listSubjectIdsWithReviews,
    listAggRowsForSubject,
    listSubjectIdsWithAggregate,
    setSnapshot,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("recomputeReviewAggregates", () => {
  it("rolls ONE review's four denormalized targets into four aggregates", () => {
    return (async () => {
      const rows = fiveReviews();
      const { deps, setSnapshot } = makeDeps({
        subjectIdsByType: {
          EVENT: ["E1"],
          PLACE: ["P1"],
          OWNER: ["O1"],
          SERIES: ["S1"],
        },
        rowsBySubject: {
          [key("EVENT", "E1")]: rows,
          [key("PLACE", "P1")]: rows,
          [key("OWNER", "O1")]: rows,
          [key("SERIES", "S1")]: rows,
        },
      });

      const result = await recomputeReviewAggregates(deps);

      expect(result).toStrictEqual({ subjectsRecomputed: 4, subjectsFailed: 0 });
      const written = setSnapshot.mock.calls.map(([i]: any[]) => ({
        subjectType: i.subjectType,
        subjectId: i.subjectId,
        hasSummary: i.snapshot.summary !== undefined,
        computedAt: i.computedAt,
      }));
      expect(written).toStrictEqual([
        { subjectType: "EVENT", subjectId: "E1", hasSummary: true, computedAt: NOW },
        { subjectType: "PLACE", subjectId: "P1", hasSummary: true, computedAt: NOW },
        { subjectType: "OWNER", subjectId: "O1", hasSummary: true, computedAt: NOW },
        { subjectType: "SERIES", subjectId: "S1", hasSummary: true, computedAt: NOW },
      ]);
    })();
  });

  describe("verified/community source split (FR-010)", () => {
    it("a PLACE with mixed sources publishes verified + community lines independently", async () => {
      const verified = Array.from({ length: 5 }, () =>
        aggRow({ source: "VERIFIED_TICKET" }),
      );
      const community = Array.from({ length: 5 }, () =>
        aggRow({ source: "COMMUNITY" }),
      );
      const { deps, setSnapshot } = makeDeps({
        subjectIdsByType: { PLACE: ["P1"] },
        rowsBySubject: { [key("PLACE", "P1")]: [...verified, ...community] },
      });

      await recomputeReviewAggregates(deps);

      const snap = setSnapshot.mock.calls[0]![0].snapshot;
      expect(snap.summary).toBeDefined();
      expect(snap.summary.reviewCountBand).toBe("5");
      expect(snap.community).toBeDefined();
      expect(snap.community.reviewCountBand).toBe("5");
    });

    it("EVENT/OWNER/SERIES subjects (verified-only rows) never emit a community line", async () => {
      // The adapter only ever hands these subjects verified rows (community
      // rows carry null event/owner/series). Assert the resulting snapshot has
      // no community leak.
      const { deps, setSnapshot } = makeDeps({
        subjectIdsByType: { EVENT: ["E1"], OWNER: ["O1"], SERIES: ["S1"] },
        rowsBySubject: {
          [key("EVENT", "E1")]: fiveReviews(),
          [key("OWNER", "O1")]: fiveReviews(),
          [key("SERIES", "S1")]: fiveReviews(),
        },
      });

      await recomputeReviewAggregates(deps);

      for (const [{ snapshot }] of setSnapshot.mock.calls as any[]) {
        expect(snapshot.summary).toBeDefined();
        expect(snapshot.community).toBeUndefined();
      }
    });
  });

  it("writes the empty { version: 1 } snapshot below threshold", async () => {
    const { deps, setSnapshot } = makeDeps({
      subjectIdsByType: { EVENT: ["E1"] },
      rowsBySubject: { [key("EVENT", "E1")]: [aggRow(), aggRow()] }, // n=2
    });

    const result = await recomputeReviewAggregates(deps);

    expect(result).toStrictEqual({ subjectsRecomputed: 1, subjectsFailed: 0 });
    expect(setSnapshot.mock.calls[0]![0].snapshot).toStrictEqual({ version: 1 });
  });

  it("is idempotent: re-running unchanged data writes identical snapshots", async () => {
    const rows = fiveReviews();
    const opts: DepsOptions = {
      subjectIdsByType: { EVENT: ["E1"] },
      rowsBySubject: { [key("EVENT", "E1")]: rows },
    };
    const first = makeDeps(opts);
    const second = makeDeps(opts);

    await recomputeReviewAggregates(first.deps);
    await recomputeReviewAggregates(second.deps);

    expect(second.setSnapshot.mock.calls).toStrictEqual(
      first.setSnapshot.mock.calls,
    );
  });

  it("paginates each subject sweep with the cursor", async () => {
    const { deps, listSubjectIdsWithReviews, setSnapshot } = makeDeps({
      subjectIdsByType: { EVENT: ["E1", "E2"] },
      rowsBySubject: {
        [key("EVENT", "E1")]: [aggRow()],
        [key("EVENT", "E2")]: [aggRow()],
      },
    });

    const result = await recomputeReviewAggregates(deps, { batchSize: 1 });

    expect(result.subjectsRecomputed).toBe(2);
    expect(setSnapshot).toHaveBeenCalledTimes(2);
    expect(listSubjectIdsWithReviews).toHaveBeenCalledWith({
      subjectType: "EVENT",
      limit: 1,
      afterSubjectId: undefined,
    });
    expect(listSubjectIdsWithReviews).toHaveBeenCalledWith({
      subjectType: "EVENT",
      limit: 1,
      afterSubjectId: "E1",
    });
  });

  describe("union sweep: aggregates without visible reviews (retraction)", () => {
    it("overwrites a fully-hidden subject's stale aggregate with the empty one", async () => {
      const { deps, setSnapshot, listAggRowsForSubject } = makeDeps({
        subjectIdsByType: { EVENT: ["E1"] },
        rowsBySubject: { [key("EVENT", "E1")]: fiveReviews() },
        // E2 published an aggregate last week; since then every review was
        // hidden so it no longer appears in the has-reviews sweep.
        aggregatesByType: { EVENT: ["E2"] },
      });

      const result = await recomputeReviewAggregates(deps);

      expect(result).toStrictEqual({ subjectsRecomputed: 2, subjectsFailed: 0 });
      expect(listAggRowsForSubject).toHaveBeenCalledWith({
        subjectType: "EVENT",
        subjectId: "E2",
      });
      const forE2 = setSnapshot.mock.calls.find(
        ([i]: any[]) => i.subjectId === "E2",
      )![0];
      expect(forE2.snapshot).toStrictEqual({ version: 1 });
    });

    it("does not recompute a subject twice when it is in both sweeps", async () => {
      const { deps, setSnapshot } = makeDeps({
        subjectIdsByType: { EVENT: ["E1"] },
        rowsBySubject: { [key("EVENT", "E1")]: fiveReviews() },
        aggregatesByType: { EVENT: ["E1"] },
      });

      const result = await recomputeReviewAggregates(deps);

      expect(result).toStrictEqual({ subjectsRecomputed: 1, subjectsFailed: 0 });
      expect(setSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  describe("write-time snapshot validation", () => {
    it("an off-schema build fails that subject, reports it, sweep continues", async () => {
      const reportError = vi.fn();
      policyMock.buildOverride = (rows: any) =>
        rows.length === 1
          ? { version: 1, bogus: true } // .strict() schema rejects this
          : { version: 1 };
      const { deps, setSnapshot } = makeDeps({
        subjectIdsByType: { EVENT: ["E1", "E2"] },
        rowsBySubject: {
          [key("EVENT", "E1")]: [aggRow()], // one row → corrupt
          [key("EVENT", "E2")]: [aggRow(), aggRow()],
        },
        reportError,
      });

      const result = await recomputeReviewAggregates(deps);

      expect(result).toStrictEqual({ subjectsRecomputed: 1, subjectsFailed: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toStrictEqual({
        tags: { useCase: "recomputeReviewAggregates", subjectType: "EVENT" },
        extra: { subjectId: "E1" },
      });
      // The invalid snapshot is never persisted; the valid subject still is.
      expect(setSnapshot).toHaveBeenCalledTimes(1);
      expect(setSnapshot.mock.calls[0]![0].subjectId).toBe("E2");
    });
  });

  describe("per-subject failure isolation + reportError (NFR-003)", () => {
    it("reports the failure, keeps the stale snapshot, and continues", async () => {
      const boom = new Error("db exploded");
      const reportError = vi.fn();
      const { deps, setSnapshot } = makeDeps({
        subjectIdsByType: { EVENT: ["E1", "E2"] },
        listAggRows: async ({ subjectId }) => {
          if (subjectId === "E1") throw boom;
          return [aggRow()];
        },
        reportError,
      });

      const result = await recomputeReviewAggregates(deps);

      expect(result).toStrictEqual({ subjectsRecomputed: 1, subjectsFailed: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(boom, {
        tags: { useCase: "recomputeReviewAggregates", subjectType: "EVENT" },
        extra: { subjectId: "E1" },
      });
      expect(setSnapshot).toHaveBeenCalledTimes(1);
      expect(setSnapshot.mock.calls[0]![0].subjectId).toBe("E2");
    });

    it("continues even when reportError is not wired", async () => {
      const { deps } = makeDeps({
        subjectIdsByType: { EVENT: ["E1", "E2"] },
        listAggRows: async ({ subjectId }) => {
          if (subjectId === "E1") throw new Error("boom");
          return [aggRow()];
        },
      });

      await expect(recomputeReviewAggregates(deps)).resolves.toStrictEqual({
        subjectsRecomputed: 1,
        subjectsFailed: 1,
      });
    });

    it("a throwing reporter never breaks the sweep", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { deps } = makeDeps({
        subjectIdsByType: { EVENT: ["E1", "E2"] },
        listAggRows: async ({ subjectId }) => {
          if (subjectId === "E1") throw new Error("boom");
          return [aggRow()];
        },
        reportError,
      });

      await expect(recomputeReviewAggregates(deps)).resolves.toStrictEqual({
        subjectsRecomputed: 1,
        subjectsFailed: 1,
      });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError when every subject succeeds", async () => {
      const reportError = vi.fn();
      const { deps } = makeDeps({
        subjectIdsByType: { EVENT: ["E1"] },
        rowsBySubject: { [key("EVENT", "E1")]: [aggRow()] },
        reportError,
      });

      await recomputeReviewAggregates(deps);

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("rejects an invalid batch size", async () => {
    const { deps } = makeDeps({});
    await expect(
      recomputeReviewAggregates(deps, { batchSize: 0 }),
    ).rejects.toBeDefined();
  });
});
