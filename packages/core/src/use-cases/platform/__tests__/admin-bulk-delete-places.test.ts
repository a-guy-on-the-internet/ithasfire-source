import { describe, expect, it, vi } from "vitest";

import { adminBulkDeletePlaces } from "../admin-bulk-delete-places";
import type { AdminBulkDeletePlacesDeps } from "../admin-bulk-delete-places";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makePlaceRecord(id: string, name = "Test Place") {
  return { id, name, slug: "test-place", status: "ACTIVE" as const };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDeps(
  overrides: {
    allowed?: boolean;
    getById?: (id: string) => unknown;
    deletePlaceError?: (id: string) => Error | undefined;
  } = {},
): AdminBulkDeletePlacesDeps {
  const allowed = overrides.allowed ?? true;
  const getById = overrides.getById ?? ((id: string) => makePlaceRecord(id));

  const places = {
    getById: vi.fn(async (id: string) => getById(id)),
    deletePlace: vi.fn(async (id: string) => {
      const err = overrides.deletePlaceError?.(id);
      if (err) throw err;
    }),
  };

  const audit = { log: vi.fn() };

  const tx = vi.fn(async (fn: (txRepos: unknown) => Promise<unknown>) =>
    fn({ places, audit }),
  );

  return {
    repos: {
      places,
      audit,
      tx,
    } as unknown as AdminBulkDeletePlacesDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as AdminBulkDeletePlacesDeps["authz"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("adminBulkDeletePlaces", () => {
  it("deletes all places and returns per-item results", async () => {
    const deps = buildDeps();
    const result = await adminBulkDeletePlaces(deps, {
      actorHumanId: ACTOR_ID,
      placeIds: [PLACE_A, PLACE_B],
    });

    expect(result.total).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([
      { placeId: PLACE_A, ok: true },
      { placeId: PLACE_B, ok: true },
    ]);

    // Audit log called BEFORE deletion for each place
    expect(deps.repos.audit.log).toHaveBeenCalledTimes(2);
    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "Place",
        entityId: PLACE_A,
        action: "admin.deletePlace",
        data: expect.objectContaining({ actorHumanId: ACTOR_ID }),
      }),
    );
  });

  it("continues on partial failure", async () => {
    const deps = buildDeps({
      deletePlaceError: (id) =>
        id === PLACE_B
          ? Object.assign(new Error("boom"), { code: "db_error" })
          : undefined,
    });

    const result = await adminBulkDeletePlaces(deps, {
      actorHumanId: ACTOR_ID,
      placeIds: [PLACE_A, PLACE_B, PLACE_C],
    });

    expect(result.total).toBe(3);
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[1]).toEqual({
      placeId: PLACE_B,
      ok: false,
      error: "db_error",
    });
  });

  it("reports not_found for missing places", async () => {
    const deps = buildDeps({
      getById: (id) => (id === PLACE_B ? null : makePlaceRecord(id)),
    });

    const result = await adminBulkDeletePlaces(deps, {
      actorHumanId: ACTOR_ID,
      placeIds: [PLACE_A, PLACE_B],
    });

    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[1]).toEqual({
      placeId: PLACE_B,
      ok: false,
      error: "not_found",
    });

    // Should not have attempted to delete the missing place
    const deletePlace = (
      deps.repos as unknown as {
        places: { deletePlace: ReturnType<typeof vi.fn> };
      }
    ).places.deletePlace;
    expect(deletePlace).toHaveBeenCalledTimes(1);
    expect(deletePlace).toHaveBeenCalledWith(PLACE_A);
  });

  it("rejects when placeIds exceeds max of 100", async () => {
    const deps = buildDeps();
    const tooMany = Array.from(
      { length: 101 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );

    await expect(
      adminBulkDeletePlaces(deps, {
        actorHumanId: ACTOR_ID,
        placeIds: tooMany,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects empty placeIds array", async () => {
    const deps = buildDeps();

    await expect(
      adminBulkDeletePlaces(deps, {
        actorHumanId: ACTOR_ID,
        placeIds: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects non-ADMIN staff", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      adminBulkDeletePlaces(deps, {
        actorHumanId: ACTOR_ID,
        placeIds: [PLACE_A],
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});
