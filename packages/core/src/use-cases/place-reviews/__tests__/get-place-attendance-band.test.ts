import { describe, expect, it, vi } from "vitest";

import {
  getPlaceAttendanceBand,
  type GetPlaceAttendanceBandDeps,
} from "../get-place-attendance-band";

const PLACE_A = "00000000-0000-4000-8000-00000000000a";

function statsRow(overrides: Record<string, unknown> = {}) {
  return {
    placeId: PLACE_A,
    showsHosted: 12,
    firstShowAt: new Date("2025-01-10T04:00:00.000Z"),
    lastShowAt: new Date("2026-09-20T04:00:00.000Z"),
    scannedEventCount: 10,
    checkedInTotal: 400,
    checkedInAvg: 40,
    publicSnapshot: null,
    publicSnapshotAt: null,
    lastCalculatedAt: new Date("2026-09-24T00:00:00.000Z"),
    ...overrides,
  };
}

const activePlace = {
  id: PLACE_A,
  name: "Venue A",
  status: "ACTIVE",
  communityReviewsEnabled: true,
};

function makeDeps(
  row: unknown,
  place: Record<string, unknown> | null = activePlace,
): GetPlaceAttendanceBandDeps & {
  getByPlaceId: ReturnType<typeof vi.fn>;
} {
  const getByPlaceId = vi.fn(async () => row);
  return {
    repos: {
      placeStats: { getByPlaceId },
      places: { getById: vi.fn(async () => place) },
    } as unknown as GetPlaceAttendanceBandDeps["repos"],
    getByPlaceId,
  };
}

describe("getPlaceAttendanceBand", () => {
  it("derives the band from checkedInAvg (40 → 25_to_100)", async () => {
    const result = await getPlaceAttendanceBand(makeDeps(statsRow()), {
      placeId: PLACE_A,
    });
    expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: "25_to_100" });
  });

  it("answers null when there is no PlaceStats row", async () => {
    const result = await getPlaceAttendanceBand(makeDeps(null), {
      placeId: PLACE_A,
    });
    expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: null });
  });

  it("answers the same null for an unknown place, without reading stats", async () => {
    const deps = makeDeps(statsRow(), null);
    const result = await getPlaceAttendanceBand(deps, { placeId: PLACE_A });
    expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: null });
    expect(deps.getByPlaceId).not.toHaveBeenCalled();
  });

  it("answers the same null for an ARCHIVED place, without reading stats (no existence oracle)", async () => {
    const deps = makeDeps(statsRow(), { ...activePlace, status: "ARCHIVED" });
    const result = await getPlaceAttendanceBand(deps, { placeId: PLACE_A });
    expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: null });
    expect(deps.getByPlaceId).not.toHaveBeenCalled();
  });

  it("R4: the performer-review switch never hides the band (door data)", async () => {
    const deps = makeDeps(statsRow({ checkedInAvg: 40 }), {
      ...activePlace,
      communityReviewsEnabled: false,
    });
    const result = await getPlaceAttendanceBand(deps, { placeId: PLACE_A });
    expect(result.attendanceBand).toBe("25_to_100");
  });

  it("answers null when no show has a scan (checkedInAvg null)", async () => {
    const result = await getPlaceAttendanceBand(
      makeDeps(statsRow({ checkedInAvg: null, checkedInTotal: 0, scannedEventCount: 0 })),
      { placeId: PLACE_A },
    );
    expect(result.attendanceBand).toBeNull();
  });

  it("NFR-004: the serialised output carries exactly placeId + attendanceBand", async () => {
    const result = await getPlaceAttendanceBand(makeDeps(statsRow()), {
      placeId: PLACE_A,
    });
    expect(Object.keys(JSON.parse(JSON.stringify(result)))).toEqual([
      "placeId",
      "attendanceBand",
    ]);
  });

  it("rejects an unknown input key at the boundary", async () => {
    await expect(
      getPlaceAttendanceBand(makeDeps(statsRow()), {
        placeId: PLACE_A,
        checkedInAvg: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
