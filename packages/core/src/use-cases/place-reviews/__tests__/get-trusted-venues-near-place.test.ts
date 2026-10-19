import { describe, it, expect, vi } from "vitest";
import { getTrustedVenuesNearPlace } from "../get-trusted-venues-near-place";

const PLACE_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Candidate = {
  placeId: string;
  placeName: string;
  publicSnapshot: unknown;
  // Deliberately allow extra (live-looking) props to sneak in — the use case
  // must never let them reach the output.
  [key: string]: unknown;
};

function makeDeps(
  opts: { city?: string | null; candidates?: Candidate[] } = {},
) {
  return {
    repos: {
      places: {
        getById: vi
          .fn()
          .mockResolvedValue(
            opts.city !== undefined
              ? {
                  id: PLACE_ID,
                  name: "Test Venue",
                  city: opts.city,
                  region: "TN",
                }
              : null,
          ),
      },
      placeStats: {
        listPublishedSnapshotsByCity: vi
          .fn()
          .mockResolvedValue(opts.candidates ?? []),
      },
    },
  } as any;
}

function snapshotWithHeadline(
  reviewCountBand: string,
  wouldPlayAgainPct?: number,
) {
  return {
    version: 1,
    headline: {
      reviewCountBand,
      ...(wouldPlayAgainPct !== undefined ? { wouldPlayAgainPct } : {}),
    },
  };
}

describe("getTrustedVenuesNearPlace", () => {
  it("serves coarsened values from the published snapshot only", async () => {
    const candidates: Candidate[] = [
      {
        placeId: "v1",
        placeName: "Venue A",
        publicSnapshot: snapshotWithHeadline("20+", 85),
        // Live-looking columns that must NOT surface (and would not even be
        // selected by the real adapter):
        wouldPlayAgainPct: 0.87345,
        reviewCountPublic: 23,
      },
      {
        placeId: "v2",
        placeName: "Venue B",
        publicSnapshot: snapshotWithHeadline("7", 70),
        wouldPlayAgainPct: 0.71429,
        reviewCountPublic: 7,
      },
    ];
    const deps = makeDeps({ city: "Nashville", candidates });

    const result = await getTrustedVenuesNearPlace(deps, { placeId: PLACE_ID });

    expect(result.city).toBe("Nashville");
    expect(result.venues).toStrictEqual([
      {
        placeId: "v1",
        name: "Venue A",
        reviewCountBand: "20+",
        wouldPlayAgainPct: 85,
      },
      {
        placeId: "v2",
        name: "Venue B",
        reviewCountBand: "7",
        wouldPlayAgainPct: 70,
      },
    ]);

    // Exact live figures never appear anywhere in the output.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("0.87345");
    expect(serialized).not.toContain("0.71429");
    expect(serialized).not.toContain("23");
    expect(
      result.venues.some(
        (v) => "reviewCountPublic" in v || "totalReviews" in v,
      ),
    ).toBe(false);

    expect(
      deps.repos.placeStats.listPublishedSnapshotsByCity,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        city: "Nashville",
        excludePlaceId: PLACE_ID,
      }),
    );
  });

  it("excludes a place whose snapshot has no published headline", async () => {
    const candidates: Candidate[] = [
      {
        placeId: "v1",
        placeName: "Below Threshold",
        publicSnapshot: { version: 1 }, // published, but headline suppressed
      },
      {
        placeId: "v2",
        placeName: "Venue B",
        publicSnapshot: snapshotWithHeadline("5", 80),
      },
    ];
    const deps = makeDeps({ city: "Nashville", candidates });

    const result = await getTrustedVenuesNearPlace(deps, { placeId: PLACE_ID });

    expect(result.venues.map((v) => v.placeId)).toStrictEqual(["v2"]);
  });

  it("excludes a place whose stored snapshot is invalid (fail closed)", async () => {
    const candidates: Candidate[] = [
      {
        placeId: "v1",
        placeName: "Corrupt",
        publicSnapshot: { version: 99, headline: { reviewCountBand: 12 } },
      },
    ];
    const deps = makeDeps({ city: "Nashville", candidates });

    const result = await getTrustedVenuesNearPlace(deps, { placeId: PLACE_ID });

    expect(result.venues).toHaveLength(0);
  });

  it("ranks by coarsened wouldPlayAgainPct (nulls last) and applies the limit", async () => {
    const candidates: Candidate[] = [
      {
        placeId: "v1",
        placeName: "No Pct",
        publicSnapshot: snapshotWithHeadline("4"),
      },
      {
        placeId: "v2",
        placeName: "Low",
        publicSnapshot: snapshotWithHeadline("6", 60),
      },
      {
        placeId: "v3",
        placeName: "High",
        publicSnapshot: snapshotWithHeadline("20+", 95),
      },
    ];
    const deps = makeDeps({ city: "Nashville", candidates });

    const result = await getTrustedVenuesNearPlace(deps, {
      placeId: PLACE_ID,
      limit: 2,
    });

    expect(result.venues.map((v) => v.placeId)).toStrictEqual(["v3", "v2"]);
  });

  it("returns empty when place has no city", async () => {
    const deps = makeDeps({ city: null });
    const result = await getTrustedVenuesNearPlace(deps, { placeId: PLACE_ID });

    expect(result.venues).toHaveLength(0);
    expect(result.city).toBeNull();
    expect(
      deps.repos.placeStats.listPublishedSnapshotsByCity,
    ).not.toHaveBeenCalled();
  });

  it("throws not_found when place does not exist", async () => {
    const deps = makeDeps({ city: undefined }); // getById returns null
    await expect(
      getTrustedVenuesNearPlace(deps, { placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });
});
