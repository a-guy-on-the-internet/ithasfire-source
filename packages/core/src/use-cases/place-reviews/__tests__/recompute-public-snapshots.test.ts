import { afterEach, describe, expect, it, vi } from "vitest";

import { recomputePublicSnapshots } from "../recompute-public-snapshots";
import type { RecomputePublicSnapshotsDeps } from "../recompute-public-snapshots";

// Controllable pass-through mock for buildPublicSnapshot so the write-time
// validation path can be exercised (a policy bug producing an off-schema
// snapshot must fail the place in the JOB, not a week later at serve time).
const policyMock = vi.hoisted(() => ({
  buildPublicSnapshotOverride: null as null | ((agg: unknown) => unknown),
}));
vi.mock("../anonymization-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../anonymization-policy")>();
  return {
    ...actual,
    buildPublicSnapshot: (agg: Parameters<typeof actual.buildPublicSnapshot>[0]) =>
      policyMock.buildPublicSnapshotOverride
        ? policyMock.buildPublicSnapshotOverride(agg)
        : actual.buildPublicSnapshot(agg),
  };
});

afterEach(() => {
  policyMock.buildPublicSnapshotOverride = null;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-14T06:00:00.000Z");
const PLACE_A = "00000000-0000-4000-8000-00000000000a";
const PLACE_B = "00000000-0000-4000-8000-00000000000b";
const EVENT_1 = "00000000-0000-4000-8000-0000000000e1";

const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

function review(overrides: Record<string, unknown> = {}) {
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
    source: "SURVEY",
    eventId: null,
    gigDate: null,
    ...overrides,
  };
}

type DepsOptions = {
  reviewsByPlace: Record<string, unknown[]>;
  /** placeIds already carrying a published snapshot (phase-2 union sweep). */
  publishedSnapshotPlaceIds?: string[];
  eventsById?: Record<string, { startsAt: Date; endsAt: Date | null }>;
  listForStats?: (placeId: string) => Promise<unknown[]>;
  reportError?: RecomputePublicSnapshotsDeps["reportError"];
};

function makeDeps(opts: DepsOptions) {
  const placeIds = Object.keys(opts.reviewsByPlace).sort();
  const listPlaceIdsWithVisibleReviews = vi.fn(
    async ({ limit, afterPlaceId }: { limit: number; afterPlaceId?: string }) =>
      placeIds
        .filter((id) => (afterPlaceId ? id > afterPlaceId : true))
        .slice(0, limit),
  );
  const publishedIds = [...(opts.publishedSnapshotPlaceIds ?? [])].sort();
  const listPlaceIdsWithPublishedSnapshot = vi.fn(
    async ({ limit, afterPlaceId }: { limit: number; afterPlaceId?: string }) =>
      publishedIds
        .filter((id) => (afterPlaceId ? id > afterPlaceId : true))
        .slice(0, limit),
  );
  const listForStats = vi.fn(
    opts.listForStats ??
      (async (placeId: string) => opts.reviewsByPlace[placeId] ?? []),
  );
  const setPublicSnapshot = vi.fn(
    async (_input: {
      placeId: string;
      snapshot: unknown;
      computedAt: Date;
    }) => undefined,
  );
  const getById = vi.fn(async (id: string) => {
    const event = opts.eventsById?.[id];
    return event ? { id, ...event } : null;
  });

  const deps: RecomputePublicSnapshotsDeps = {
    repos: {
      placeReviews: { listPlaceIdsWithVisibleReviews, listForStats },
      placeStats: { setPublicSnapshot, listPlaceIdsWithPublishedSnapshot },
      events: { getById },
    } as any,
    clock: { now: () => NOW } as any,
    reportError: opts.reportError,
  };

  return {
    deps,
    listPlaceIdsWithVisibleReviews,
    listPlaceIdsWithPublishedSnapshot,
    listForStats,
    setPublicSnapshot,
    getById,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("recomputePublicSnapshots", () => {
  it("writes a snapshot for every place with visible reviews", async () => {
    const { deps, setPublicSnapshot } = makeDeps({
      reviewsByPlace: {
        [PLACE_A]: [review(), review(), review()],
        [PLACE_B]: [review()],
      },
    });

    const result = await recomputePublicSnapshots(deps);

    expect(result).toStrictEqual({ placesRecomputed: 2, placesFailed: 0 });
    expect(setPublicSnapshot).toHaveBeenCalledTimes(2);

    const forA = setPublicSnapshot.mock.calls.find(
      ([input]: any[]) => input.placeId === PLACE_A,
    )![0] as any;
    expect(forA.computedAt).toBe(NOW);
    expect(forA.snapshot.headline.reviewCountBand).toBe("3");

    // Below the headline threshold: publish the empty (version-only) snapshot
    const forB = setPublicSnapshot.mock.calls.find(
      ([input]: any[]) => input.placeId === PLACE_B,
    )![0] as any;
    expect(forB.snapshot).toStrictEqual({ version: 1 });
  });

  it("is idempotent: re-running unchanged data writes identical snapshots", async () => {
    const reviewsByPlace = { [PLACE_A]: [review(), review(), review()] };
    const first = makeDeps({ reviewsByPlace });
    const second = makeDeps({ reviewsByPlace });

    await recomputePublicSnapshots(first.deps);
    await recomputePublicSnapshots(second.deps);

    expect(second.setPublicSnapshot.mock.calls).toStrictEqual(
      first.setPublicSnapshot.mock.calls,
    );
  });

  it("paginates the place sweep with the cursor", async () => {
    const { deps, listPlaceIdsWithVisibleReviews, setPublicSnapshot } = makeDeps({
      reviewsByPlace: { [PLACE_A]: [review()], [PLACE_B]: [review()] },
    });

    const result = await recomputePublicSnapshots(deps, { batchSize: 1 });

    expect(result.placesRecomputed).toBe(2);
    expect(setPublicSnapshot).toHaveBeenCalledTimes(2);
    expect(listPlaceIdsWithVisibleReviews).toHaveBeenCalledWith({
      limit: 1,
      afterPlaceId: undefined,
    });
    expect(listPlaceIdsWithVisibleReviews).toHaveBeenCalledWith({
      limit: 1,
      afterPlaceId: PLACE_A,
    });
  });

  it("does not stop on a short page — sweeps until an EMPTY page", async () => {
    const { deps, listPlaceIdsWithVisibleReviews, setPublicSnapshot } =
      makeDeps({
        reviewsByPlace: { [PLACE_A]: [review()], [PLACE_B]: [review()] },
      });
    // A page shorter than batchSize followed by another non-empty page: the
    // old `length < batchSize` early break would have dropped PLACE_B.
    listPlaceIdsWithVisibleReviews
      .mockReset()
      .mockResolvedValueOnce([PLACE_A])
      .mockResolvedValueOnce([PLACE_B])
      .mockResolvedValue([]);

    const result = await recomputePublicSnapshots(deps, { batchSize: 5 });

    expect(result.placesRecomputed).toBe(2);
    expect(setPublicSnapshot.mock.calls.map(([i]: any[]) => i.placeId)).toEqual(
      [PLACE_A, PLACE_B],
    );
  });

  describe("union sweep: published snapshots without visible reviews", () => {
    it("overwrites the stale snapshot of a fully-hidden place with the empty one", async () => {
      const { deps, setPublicSnapshot, listForStats } = makeDeps({
        reviewsByPlace: { [PLACE_A]: [review(), review(), review()] },
        // PLACE_B published a snapshot last week; since then moderation hid
        // every review, so it no longer appears in the visible-review sweep.
        publishedSnapshotPlaceIds: [PLACE_B],
      });

      const result = await recomputePublicSnapshots(deps);

      expect(result).toStrictEqual({ placesRecomputed: 2, placesFailed: 0 });
      expect(listForStats).toHaveBeenCalledWith(PLACE_B);
      const forB = setPublicSnapshot.mock.calls.find(
        ([input]: any[]) => input.placeId === PLACE_B,
      )![0] as any;
      expect(forB.snapshot).toStrictEqual({ version: 1 });
    });

    it("does not recompute a place twice when it appears in both sweeps", async () => {
      const { deps, setPublicSnapshot } = makeDeps({
        reviewsByPlace: { [PLACE_A]: [review(), review(), review()] },
        publishedSnapshotPlaceIds: [PLACE_A],
      });

      const result = await recomputePublicSnapshots(deps);

      expect(result).toStrictEqual({ placesRecomputed: 1, placesFailed: 0 });
      expect(setPublicSnapshot).toHaveBeenCalledTimes(1);
    });

    it("paginates the published-snapshot sweep with the cursor", async () => {
      const { deps, listPlaceIdsWithPublishedSnapshot, setPublicSnapshot } =
        makeDeps({
          reviewsByPlace: {},
          publishedSnapshotPlaceIds: [PLACE_A, PLACE_B],
        });

      const result = await recomputePublicSnapshots(deps, { batchSize: 1 });

      expect(result.placesRecomputed).toBe(2);
      expect(setPublicSnapshot).toHaveBeenCalledTimes(2);
      expect(listPlaceIdsWithPublishedSnapshot).toHaveBeenCalledWith({
        limit: 1,
        afterPlaceId: undefined,
      });
      expect(listPlaceIdsWithPublishedSnapshot).toHaveBeenCalledWith({
        limit: 1,
        afterPlaceId: PLACE_A,
      });
    });
  });

  describe("write-time snapshot validation", () => {
    it("an off-schema build fails that place, reports it, and the sweep continues", async () => {
      const reportError = vi.fn();
      // PLACE_A has 1 review, PLACE_B has 2 — corrupt only the 1-review build.
      policyMock.buildPublicSnapshotOverride = (agg: any) =>
        agg.reviewCount === 1
          ? { version: 1, bogus: true } // .strict() schema rejects this
          : { version: 1 };
      const { deps, setPublicSnapshot } = makeDeps({
        reviewsByPlace: {
          [PLACE_A]: [review()],
          [PLACE_B]: [review(), review()],
        },
        reportError,
      });

      const result = await recomputePublicSnapshots(deps);

      expect(result).toStrictEqual({ placesRecomputed: 1, placesFailed: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError.mock.calls[0]![1]).toStrictEqual({
        tags: { useCase: "recomputePublicSnapshots", placeId: PLACE_A },
      });
      // The invalid snapshot is never persisted; the valid place still is.
      expect(setPublicSnapshot).toHaveBeenCalledTimes(1);
      expect((setPublicSnapshot.mock.calls[0]![0] as any).placeId).toBe(
        PLACE_B,
      );
    });
  });

  describe("PLATFORM embargo (FR-005)", () => {
    it("excludes a PLATFORM review whose event ended 3 days ago", async () => {
      const { deps, setPublicSnapshot, getById } = makeDeps({
        reviewsByPlace: {
          [PLACE_A]: [
            review(),
            review(),
            review(),
            review({ source: "PLATFORM", eventId: EVENT_1 }),
          ],
        },
        eventsById: {
          [EVENT_1]: { startsAt: daysAgo(3.2), endsAt: daysAgo(3) },
        },
      });

      await recomputePublicSnapshots(deps);

      expect(getById).toHaveBeenCalledWith(EVENT_1);
      const [input] = setPublicSnapshot.mock.calls[0]! as any[];
      expect(input.snapshot.headline.reviewCountBand).toBe("3"); // not 4
    });

    it("includes a PLATFORM review once its event is 14+ days past", async () => {
      const { deps, setPublicSnapshot } = makeDeps({
        reviewsByPlace: {
          [PLACE_A]: [
            review(),
            review(),
            review(),
            review({ source: "PLATFORM", eventId: EVENT_1 }),
          ],
        },
        eventsById: {
          [EVENT_1]: { startsAt: daysAgo(15), endsAt: daysAgo(14.5) },
        },
      });

      await recomputePublicSnapshots(deps);

      const [input] = setPublicSnapshot.mock.calls[0]! as any[];
      expect(input.snapshot.headline.reviewCountBand).toBe("4");
    });

    it("falls back to gigDate when the event row is missing", async () => {
      const { deps, setPublicSnapshot } = makeDeps({
        reviewsByPlace: {
          [PLACE_A]: [
            review(),
            review(),
            review(),
            review({
              source: "PLATFORM",
              eventId: EVENT_1, // getById returns null
              gigDate: daysAgo(2),
            }),
          ],
        },
      });

      await recomputePublicSnapshots(deps);

      const [input] = setPublicSnapshot.mock.calls[0]! as any[];
      expect(input.snapshot.headline.reviewCountBand).toBe("3"); // embargoed via gigDate
    });
  });

  describe("per-place failure isolation (NFR-002)", () => {
    it("reports the failure, keeps the stale snapshot, and continues", async () => {
      const boom = new Error("db exploded");
      const reportError = vi.fn();
      const { deps, setPublicSnapshot } = makeDeps({
        reviewsByPlace: { [PLACE_A]: [review()], [PLACE_B]: [review()] },
        listForStats: async (placeId: string) => {
          if (placeId === PLACE_A) throw boom;
          return [review()];
        },
        reportError,
      });

      const result = await recomputePublicSnapshots(deps);

      expect(result).toStrictEqual({ placesRecomputed: 1, placesFailed: 1 });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(boom, {
        tags: { useCase: "recomputePublicSnapshots", placeId: PLACE_A },
      });
      // The failed place's snapshot is never overwritten — stale keeps serving
      expect(setPublicSnapshot).toHaveBeenCalledTimes(1);
      expect((setPublicSnapshot.mock.calls[0]![0] as any).placeId).toBe(PLACE_B);
    });

    it("continues even when reportError is not wired", async () => {
      const { deps } = makeDeps({
        reviewsByPlace: { [PLACE_A]: [review()], [PLACE_B]: [review()] },
        listForStats: async (placeId: string) => {
          if (placeId === PLACE_A) throw new Error("db exploded");
          return [review()];
        },
      });

      await expect(recomputePublicSnapshots(deps)).resolves.toStrictEqual({
        placesRecomputed: 1,
        placesFailed: 1,
      });
    });

    it("a throwing reporter never breaks the sweep", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { deps } = makeDeps({
        reviewsByPlace: { [PLACE_A]: [review()], [PLACE_B]: [review()] },
        listForStats: async (placeId: string) => {
          if (placeId === PLACE_A) throw new Error("db exploded");
          return [review()];
        },
        reportError,
      });

      await expect(recomputePublicSnapshots(deps)).resolves.toStrictEqual({
        placesRecomputed: 1,
        placesFailed: 1,
      });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError when every place succeeds", async () => {
      const reportError = vi.fn();
      const { deps } = makeDeps({
        reviewsByPlace: { [PLACE_A]: [review()] },
        reportError,
      });

      await recomputePublicSnapshots(deps);

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("rejects an invalid batch size", async () => {
    const { deps } = makeDeps({ reviewsByPlace: {} });

    await expect(
      recomputePublicSnapshots(deps, { batchSize: 0 }),
    ).rejects.toBeDefined();
  });
});
