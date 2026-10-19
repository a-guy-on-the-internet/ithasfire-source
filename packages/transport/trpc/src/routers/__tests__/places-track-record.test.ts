import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

import * as placesUseCases from "@th/core/use-cases/places";

import { createCaller } from "./test-helpers";
import { placesRouter } from "../places";

// ---------------------------------------------------------------------------
// venue-track-record-and-review-switch (docs/specs/2026-09-24) — Step 7.
//
// These run the REAL router with the REAL zod schemas. Only the switch
// mutation spies on its use case (its authz is core's, tested there); the two
// public reads drive the real use cases through fake repos so the wire shape
// asserted here is the wire shape the web layer gets.
// ---------------------------------------------------------------------------

const PLACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR = "11111111-1111-4111-8111-111111111111";

function statsRow(overrides: Record<string, unknown> = {}) {
  return {
    placeId: PLACE_A,
    reviewCountPublic: 0,
    payoutMeanCents: null,
    wouldPlayAgainPct: null,
    totalEventCount: 12,
    avgAttendance: 55,
    showsHosted: 12,
    firstShowAt: new Date("2023-01-10T04:00:00.000Z"),
    lastShowAt: new Date("2023-12-20T04:00:00.000Z"),
    scannedEventCount: 10,
    checkedInTotal: 400,
    checkedInAvg: 40,
    publicSnapshot: null,
    publicSnapshotAt: null,
    lastCalculatedAt: new Date("2023-12-31T00:00:00.000Z"),
    ...overrides,
  };
}

describe("placesRouter — venue track record + performer-review switch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── setCommunityReviewsEnabled ───────────────────────────────────────────

  describe("setCommunityReviewsEnabled", () => {
    it("rejects an unauthenticated caller before touching the use case", async () => {
      const spy = vi
        .spyOn(placesUseCases, "setPlaceCommunityReviewsEnabled")
        .mockResolvedValue({ placeId: PLACE_A, communityReviewsEnabled: false });

      const { caller } = createCaller(placesRouter, {
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.setCommunityReviewsEnabled({ placeId: PLACE_A, enabled: false }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("injects actorHumanId from ctx, forwards the input, returns the use case output", async () => {
      const spy = vi
        .spyOn(placesUseCases, "setPlaceCommunityReviewsEnabled")
        .mockResolvedValue({ placeId: PLACE_A, communityReviewsEnabled: false });

      const { caller, ctx } = createCaller(placesRouter, { actorHumanId: ACTOR });

      const result = await caller.setCommunityReviewsEnabled({
        placeId: PLACE_A,
        enabled: false,
      });

      expect(result).toStrictEqual({
        placeId: PLACE_A,
        communityReviewsEnabled: false,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [depsArg, inputArg] = spy.mock.calls[0]!;
      expect(depsArg.repos).toBe(ctx.repos);
      expect(depsArg.clock).toBe(ctx.clock);
      expect(inputArg).toStrictEqual({
        placeId: PLACE_A,
        enabled: false,
        actorHumanId: ACTOR,
      });
    });

    it("does not let the client supply actorHumanId (strict input)", async () => {
      const spy = vi
        .spyOn(placesUseCases, "setPlaceCommunityReviewsEnabled")
        .mockResolvedValue({ placeId: PLACE_A, communityReviewsEnabled: true });

      const { caller } = createCaller(placesRouter, { actorHumanId: ACTOR });

      await expect(
        caller.setCommunityReviewsEnabled({
          placeId: PLACE_A,
          enabled: true,
          actorHumanId: "22222222-2222-4222-8222-222222222222",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("maps NOT_RESOURCE_OWNER from the use case to FORBIDDEN", async () => {
      vi.spyOn(placesUseCases, "setPlaceCommunityReviewsEnabled").mockRejectedValue(
        new AppError("NOT_RESOURCE_OWNER", { meta: { entity: "place" } }),
      );

      const { caller } = createCaller(placesRouter, { actorHumanId: ACTOR });

      await expect(
        caller.setCommunityReviewsEnabled({ placeId: PLACE_A, enabled: false }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "NOT_RESOURCE_OWNER",
      });
    });

    it("maps PLACE_NOT_FOUND from the use case to NOT_FOUND", async () => {
      vi.spyOn(placesUseCases, "setPlaceCommunityReviewsEnabled").mockRejectedValue(
        new AppError("PLACE_NOT_FOUND"),
      );

      const { caller } = createCaller(placesRouter, { actorHumanId: ACTOR });

      await expect(
        caller.setCommunityReviewsEnabled({ placeId: PLACE_A, enabled: false }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "PLACE_NOT_FOUND" });
    });
  });

  // ── getTrackRecord ───────────────────────────────────────────────────────

  describe("getTrackRecord (public)", () => {
    const activePlace = {
      id: PLACE_A,
      name: "Fishbowl House",
      status: "ACTIVE",
      communityReviewsEnabled: true,
    };

    function callerWithStats(
      row: unknown,
      place: Record<string, unknown> | null = activePlace,
    ) {
      const getByPlaceId = vi.fn(async () => row);
      const { caller } = createCaller(placesRouter, {
        actorHumanId: null,
        auth: null,
        authToken: null,
        repos: {
          placeStats: { getByPlaceId },
          places: { getById: vi.fn(async () => place) },
        } as any,
      });
      return { caller, getByPlaceId };
    }

    it("NFR-004: the serialised output has exactly placeId + attendanceBand — never the raw figures", async () => {
      const { caller } = callerWithStats(statsRow());

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      const wire = JSON.parse(JSON.stringify(result));
      expect(Object.keys(wire)).toEqual(["placeId", "attendanceBand"]);
      expect(wire).not.toHaveProperty("checkedInAvg");
      expect(wire).not.toHaveProperty("checkedInTotal");
      expect(wire).not.toHaveProperty("scannedEventCount");
    });

    it("derives the band from checkedInAvg (40 → 25_to_100)", async () => {
      const { caller, getByPlaceId } = callerWithStats(statsRow({ checkedInAvg: 40 }));

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: "25_to_100" });
      expect(getByPlaceId).toHaveBeenCalledWith(PLACE_A);
    });

    it("answers null when there is no PlaceStats row (unknown placeId does not throw — as getPublicStats)", async () => {
      const { caller } = callerWithStats(null);

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: null });
    });

    it("answers null when no show has a scan", async () => {
      const { caller } = callerWithStats(
        statsRow({ checkedInAvg: null, checkedInTotal: 0, scannedEventCount: 0 }),
      );

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      expect(result.attendanceBand).toBeNull();
    });

    it("answers the same null for an unknown place without reading stats (no existence oracle)", async () => {
      const { caller, getByPlaceId } = callerWithStats(statsRow(), null);

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: null });
      expect(getByPlaceId).not.toHaveBeenCalled();
    });

    it("answers the same null for an ARCHIVED place without reading stats — not a thrown PLACE_ARCHIVED", async () => {
      const { caller, getByPlaceId } = callerWithStats(statsRow(), {
        ...activePlace,
        status: "ARCHIVED",
      });

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: null });
      expect(getByPlaceId).not.toHaveBeenCalled();
    });

    it("R4: communityReviewsEnabled=false never hides the band — door data, not performer data", async () => {
      const { caller } = callerWithStats(statsRow({ checkedInAvg: 40 }), {
        ...activePlace,
        communityReviewsEnabled: false,
      });

      const result = await caller.getTrackRecord({ placeId: PLACE_A });

      expect(result).toStrictEqual({ placeId: PLACE_A, attendanceBand: "25_to_100" });
    });

    it("rejects a non-uuid placeId at the boundary", async () => {
      const { caller, getByPlaceId } = callerWithStats(statsRow());

      await expect(caller.getTrackRecord({ placeId: "nope" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(getByPlaceId).not.toHaveBeenCalled();
    });
  });

  // ── getLineupHistory ─────────────────────────────────────────────────────

  describe("getLineupHistory (public)", () => {
    const place = {
      id: PLACE_A,
      name: "Fishbowl House",
      status: "ACTIVE",
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      acceptsCommunityListings: false,
    };

    // Clock in the base ctx is 2024-01-01; every act below played before it.
    // Already grouped, as the adapter returns them since spec FU-006.
    const acts = [
      {
        humanId: null,
        externalName: "The Sundowners",
        name: "The Sundowners",
        profileSlug: null,
        timesPlayed: 2,
        lastPlayedAt: new Date("2023-12-15T02:00:00.000Z"),
      },
      {
        humanId: "33333333-3333-4333-8333-333333333333",
        externalName: null,
        name: "Ada Lovelace",
        profileSlug: "ada",
        timesPlayed: 1,
        lastPlayedAt: new Date("2023-10-01T02:00:00.000Z"),
      },
    ];

    function callerWithLineup() {
      // Honours `limit` the way the SQL does: a bounded page + the total.
      const listActsByPlace = vi.fn(async (input: { limit: number | null }) => ({
        acts: input.limit === null ? acts : acts.slice(0, input.limit),
        totalActs: acts.length,
      }));
      const { caller } = createCaller(placesRouter, {
        actorHumanId: null,
        auth: null,
        authToken: null,
        repos: {
          places: { getById: vi.fn(async () => place) },
          eventHumans: { listActsByPlace },
        } as any,
      });
      return { caller, listActsByPlace };
    }

    it("recentLimit: null returns every act in both recent and all", async () => {
      const { caller, listActsByPlace } = callerWithLineup();

      const result = await caller.getLineupHistory({
        placeId: PLACE_A,
        recentLimit: null,
      });

      expect(result.allActsCount).toBe(2);
      expect(result.recent).toEqual(result.all);
      expect(result.all).toEqual([
        {
          // The output schema carries core's opaque act key (React key).
          key: "n:the sundowners",
          name: "The Sundowners",
          profileUrl: null,
          timesPlayed: 2,
          lastPlayedAt: new Date("2023-12-15T02:00:00.000Z"),
        },
        {
          key: expect.stringMatching(/^h:[0-9a-f]{12}$/),
          name: "Ada Lovelace",
          profileUrl: "/humans/ada",
          timesPlayed: 1,
          lastPlayedAt: new Date("2023-10-01T02:00:00.000Z"),
        },
      ]);
      // The linked act's raw humanId never crosses the wire.
      expect(JSON.stringify(result)).not.toContain(
        "33333333-3333-4333-8333-333333333333",
      );
      // The clock the use case saw is the server's, never the client's.
      expect(listActsByPlace).toHaveBeenCalledTimes(1);
      const arg = listActsByPlace.mock.calls[0]![0] as unknown as { now: Date };
      expect(arg.now).toEqual(new Date("2024-01-01T00:00:00.000Z"));
    });

    it("recentLimit: 1 reads ONE act (limit pushed to the adapter); allActsCount is still the total", async () => {
      const { caller, listActsByPlace } = callerWithLineup();

      const result = await caller.getLineupHistory({
        placeId: PLACE_A,
        recentLimit: 1,
      });

      expect(listActsByPlace).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1 }),
      );
      expect(result.recent).toHaveLength(1);
      expect(result.recent[0]!.name).toBe("The Sundowners");
      expect(result.all).toEqual(result.recent);
      expect(result.allActsCount).toBe(2);
    });

    it("rejects a client-supplied `now` (test seam, strict schema)", async () => {
      const { caller, listActsByPlace } = callerWithLineup();

      await expect(
        caller.getLineupHistory({
          placeId: PLACE_A,
          recentLimit: null,
          now: new Date("2030-01-01T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(listActsByPlace).not.toHaveBeenCalled();
    });

    it("rejects recentLimit: 0", async () => {
      const { caller, listActsByPlace } = callerWithLineup();

      await expect(
        caller.getLineupHistory({ placeId: PLACE_A, recentLimit: 0 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(listActsByPlace).not.toHaveBeenCalled();
    });

    it("rejects recentLimit: 501", async () => {
      const { caller, listActsByPlace } = callerWithLineup();

      await expect(
        caller.getLineupHistory({ placeId: PLACE_A, recentLimit: 501 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(listActsByPlace).not.toHaveBeenCalled();
    });

    it("maps PLACE_NOT_FOUND from the use case to NOT_FOUND", async () => {
      const { caller } = createCaller(placesRouter, {
        actorHumanId: null,
        auth: null,
        authToken: null,
        repos: {
          places: { getById: vi.fn(async () => null) },
          eventHumans: { listActsByPlace: vi.fn() },
        } as any,
      });

      await expect(
        caller.getLineupHistory({ placeId: PLACE_A, recentLimit: null }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "PLACE_NOT_FOUND" });
    });

    it("maps PLACE_ARCHIVED from the use case to NOT_FOUND (a page read says why there is no page)", async () => {
      const listActsByPlace = vi.fn();
      const { caller } = createCaller(placesRouter, {
        actorHumanId: null,
        auth: null,
        authToken: null,
        repos: {
          places: { getById: vi.fn(async () => ({ ...place, status: "ARCHIVED" })) },
          eventHumans: { listActsByPlace },
        } as any,
      });

      await expect(
        caller.getLineupHistory({ placeId: PLACE_A, recentLimit: null }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "PLACE_ARCHIVED" });
      expect(listActsByPlace).not.toHaveBeenCalled();
    });
  });
});
