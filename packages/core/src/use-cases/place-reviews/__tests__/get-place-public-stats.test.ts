import { describe, expect, it, vi } from "vitest";

import { getPlacePublicStats } from "../get-place-public-stats";
import type { GetPlacePublicStatsDeps } from "../get-place-public-stats";
import type { PlacePublicSnapshot } from "../anonymization-policy";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PLACE_A = "00000000-0000-4000-8000-00000000000a";
const SNAPSHOT_AT = new Date("2026-07-13T06:00:00.000Z");

const publishedSnapshot: PlacePublicSnapshot = {
  version: 1,
  headline: {
    reviewCountBand: "20+",
    wouldPlayAgainPct: 75,
    soundScore: 3.5,
  },
  payout: {
    sampleSizeBand: "5",
    medianCents: 22500,
    minCents: 10000,
    maxCents: 50000,
  },
};

function statsRow(overrides: Record<string, unknown> = {}) {
  return {
    placeId: PLACE_A,
    // Live-stats fields exist on the row but must never be served
    reviewCountPublic: 8,
    payoutMeanCents: 23456,
    wouldPlayAgainPct: 73,
    publicSnapshot: publishedSnapshot,
    publicSnapshotAt: SNAPSHOT_AT,
    ...overrides,
  };
}

function makeDeps(
  row: unknown,
  reportError?: GetPlacePublicStatsDeps["reportError"],
  place: Record<string, unknown> | null = {
    id: PLACE_A,
    name: "Venue A",
    communityReviewsEnabled: true,
  },
): GetPlacePublicStatsDeps {
  return {
    repos: {
      placeStats: {
        getByPlaceId: vi.fn(async () => row),
      },
      places: {
        getById: vi.fn(async () => place),
      },
    } as any,
    reportError,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getPlacePublicStats (snapshot-only)", () => {
  it("returns null snapshot when no stats row exists", async () => {
    const deps = makeDeps(null);

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    expect(result).toStrictEqual({
      placeId: PLACE_A,
      snapshot: null,
      snapshotAt: null,
    });
  });

  it("returns null snapshot when no snapshot has been published yet", async () => {
    const deps = makeDeps(
      statsRow({ publicSnapshot: null, publicSnapshotAt: null }),
    );

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    expect(result.snapshot).toBeNull();
    expect(result.snapshotAt).toBeNull();
  });

  it("serves the persisted snapshot verbatim with its timestamp", async () => {
    const deps = makeDeps(statsRow());

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    expect(result.snapshot).toStrictEqual(publishedSnapshot);
    expect(result.snapshotAt).toBe(SNAPSHOT_AT);
  });

  it("never leaks live-stats fields — output is exactly placeId/snapshot/snapshotAt", async () => {
    const deps = makeDeps(statsRow());

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    expect(Object.keys(result).sort()).toEqual([
      "placeId",
      "snapshot",
      "snapshotAt",
    ]);
    expect(JSON.stringify(result)).not.toContain("23456"); // live payoutMeanCents
  });

  describe("corrupt-snapshot swallow branch", () => {
    const corrupt = { version: 999, exactPayoutCents: 12345 };

    it("fails closed (null) and reports via reportError", async () => {
      const reportError = vi.fn();
      const deps = makeDeps(statsRow({ publicSnapshot: corrupt }), reportError);

      const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

      expect(result.snapshot).toBeNull();
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.anything(), {
        tags: { useCase: "getPlacePublicStats", placeId: PLACE_A },
      });
    });

    it("still fails closed when reportError is not wired", async () => {
      const deps = makeDeps(statsRow({ publicSnapshot: corrupt }));

      const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

      expect(result.snapshot).toBeNull();
    });

    it("a throwing reporter never breaks the null fallback", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const deps = makeDeps(statsRow({ publicSnapshot: corrupt }), reportError);

      await expect(
        getPlacePublicStats(deps, { placeId: PLACE_A }),
      ).resolves.toMatchObject({ snapshot: null });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const reportError = vi.fn();
      const deps = makeDeps(statsRow(), reportError);

      await getPlacePublicStats(deps, { placeId: PLACE_A });

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it("rejects invalid placeId format", async () => {
    const deps = makeDeps(null);

    await expect(
      getPlacePublicStats(deps, { placeId: "not-a-uuid" }),
    ).rejects.toBeDefined();
  });
});

// ── The performer-review switch (venue-track-record-and-review-switch FR-003) ─

describe("getPlacePublicStats — Place.communityReviewsEnabled", () => {
  it("serves { snapshot: null, snapshotAt: null } when the switch is off, and never reads the stats row", async () => {
    const deps = makeDeps(statsRow(), undefined, {
      id: PLACE_A,
      name: "Fishbowl House",
      communityReviewsEnabled: false,
    });

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    // Same shape as "nothing published yet" — a caller cannot tell them apart.
    expect(result).toStrictEqual({
      placeId: PLACE_A,
      snapshot: null,
      snapshotAt: null,
    });
    expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
  });

  it("serves nothing for a place that no longer exists (closed, not thrown)", async () => {
    const deps = makeDeps(statsRow(), undefined, null);

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    expect(result.snapshot).toBeNull();
    expect(deps.repos.placeStats.getByPlaceId).not.toHaveBeenCalled();
  });

  it("serves the snapshot when the switch is on, whatever the ATTENDEE flag says (FR-001)", async () => {
    const deps = makeDeps(statsRow(), undefined, {
      id: PLACE_A,
      name: "Venue A",
      attendeeReviewsPublic: false,
      communityReviewsEnabled: true,
    });

    const result = await getPlacePublicStats(deps, { placeId: PLACE_A });

    expect(result.snapshot).toStrictEqual(publishedSnapshot);
    expect(result.snapshotAt).toEqual(SNAPSHOT_AT);
  });
});
