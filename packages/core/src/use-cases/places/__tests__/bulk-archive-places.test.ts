import { describe, expect, it, vi } from "vitest";

import { bulkArchivePlaces } from "../bulk-archive-places";
import * as updateStatusModule from "../update-place-status";
import type { BulkArchivePlacesDeps } from "../bulk-archive-places";
import type { Repos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-02-01T00:00:00.000Z");
const DEFAULT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function buildDeps(): BulkArchivePlacesDeps {
  return {
    repos: {} as unknown as Repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => BASE_DATE) },
    logger: createTestLogger(),
  };
}

describe("bulkArchivePlaces", () => {
  it("archives all places and returns per-item results", async () => {
    const deps = buildDeps();
    const spy = vi
      .spyOn(updateStatusModule, "updatePlaceStatus")
      .mockResolvedValueOnce({ placeId: PLACE_A, status: "ARCHIVED" })
      .mockResolvedValueOnce({ placeId: PLACE_B, status: "ARCHIVED" });

    const result = await bulkArchivePlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      placeIds: [PLACE_A, PLACE_B],
    });

    expect(result.total).toBe(2);
    expect(result.archived).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.results).toEqual([
      { placeId: PLACE_A, ok: true },
      { placeId: PLACE_B, ok: true },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      placeId: PLACE_A,
      status: "ARCHIVED",
      clientKey: `${DEFAULT_ACTOR_ID}:archive:${PLACE_A}`,
    });

    spy.mockRestore();
  });

  it("continues on partial failure", async () => {
    const deps = buildDeps();
    const spy = vi
      .spyOn(updateStatusModule, "updatePlaceStatus")
      .mockResolvedValueOnce({ placeId: PLACE_A, status: "ARCHIVED" })
      .mockRejectedValueOnce({ code: "not_found", message: "place_not_found" })
      .mockResolvedValueOnce({ placeId: PLACE_C, status: "ARCHIVED" });

    const result = await bulkArchivePlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      placeIds: [PLACE_A, PLACE_B, PLACE_C],
    });

    expect(result.total).toBe(3);
    expect(result.archived).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toEqual({ placeId: PLACE_A, ok: true });
    expect(result.results[1]).toEqual({
      placeId: PLACE_B,
      ok: false,
      error: "not_found",
    });
    expect(result.results[2]).toEqual({ placeId: PLACE_C, ok: true });

    spy.mockRestore();
  });

  it("rejects when placeIds exceeds max of 100", async () => {
    const deps = buildDeps();
    const placeIds = Array.from(
      { length: 101 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );

    await expect(
      bulkArchivePlaces(deps, { actorHumanId: DEFAULT_ACTOR_ID, placeIds }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects empty placeIds array", async () => {
    const deps = buildDeps();

    await expect(
      bulkArchivePlaces(deps, { actorHumanId: DEFAULT_ACTOR_ID, placeIds: [] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns internal_error for unexpected exceptions", async () => {
    const deps = buildDeps();
    const spy = vi
      .spyOn(updateStatusModule, "updatePlaceStatus")
      .mockRejectedValueOnce(new Error("connection refused"));

    const result = await bulkArchivePlaces(deps, {
      actorHumanId: DEFAULT_ACTOR_ID,
      placeIds: [PLACE_A],
    });

    expect(result.skipped).toBe(1);
    expect(result.results[0]).toEqual({
      placeId: PLACE_A,
      ok: false,
      error: "internal_error",
    });

    spy.mockRestore();
  });
});
