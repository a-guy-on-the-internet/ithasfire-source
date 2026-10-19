import { describe, expect, it, vi } from "vitest";

import { listPlatformPlaces } from "../list-platform-places";
import type { ListPlatformPlacesDeps } from "../list-platform-places";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const STAFF_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_PLACE_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_PLACE_ID = "55555555-5555-4555-8555-555555555555";

function buildPlaceRecord(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: overrides.id ?? DEFAULT_PLACE_ID,
    name: overrides.name ?? "Nomad Warehouse",
    slug: "test-place",
    formattedAddress: overrides.formattedAddress ?? "123 Main St",
    addressLine1: overrides.addressLine1 ?? "123 Main St",
    addressLine2: overrides.addressLine2 ?? null,
    city: overrides.city ?? "Los Angeles",
    region: overrides.region ?? "CA",
    postalCode: overrides.postalCode ?? "90001",
    countryCode: overrides.countryCode ?? "US",
    capacity: overrides.capacity ?? 1200,
    lat: overrides.lat ?? 34.0447,
    lng: overrides.lng ?? -118.2519,
    status: overrides.status ?? "ACTIVE",
    verificationStatus: overrides.verificationStatus ?? "PENDING",
    orgIdsWithAccess: overrides.orgIdsWithAccess ?? ["org-1"],
    humanIdsWithAccess: overrides.humanIdsWithAccess ?? [],
  } satisfies PlaceRecord;
}

function buildDeps(
  overrides: {
    staffAllowed?: boolean;
    places?: PlaceRecord[];
    total?: number;
    pages?: Array<Pick<EntityPageRecord, "ownerId" | "slug" | "visibility">>;
  } = {},
): ListPlatformPlacesDeps {
  const staffAllowed = overrides.staffAllowed ?? true;
  const places = overrides.places ?? [buildPlaceRecord()];
  const total = overrides.total ?? places.length;
  const pages = (overrides.pages ?? []).map((page) => ({
    ownerType: "PLACE",
    ...page,
  }));

  return {
    repos: {
      places: {
        listAll: vi.fn(async () => ({
          items: places,
          pageInfo: {
            total,
            limit: 25,
            offset: 0,
            hasMore: total > places.length,
          },
        })),
      },
      entityPages: {
        getByOwners: vi.fn(async (_type: string, ownerIds: string[]) =>
          pages.filter((page) => ownerIds.includes(page.ownerId)),
        ),
      },
    } as unknown as ListPlatformPlacesDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: staffAllowed })),
    },
    logger: createTestLogger(),
  };
}

describe("listPlatformPlaces", () => {
  it("returns places for a staff user", async () => {
    const deps = buildDeps({
      places: [
        buildPlaceRecord({ id: DEFAULT_PLACE_ID, name: "Place A" }),
        buildPlaceRecord({
          id: SECOND_PLACE_ID,
          name: "Place B",
          city: "Austin",
          verificationStatus: "VERIFIED",
        }),
      ],
    });

    const result = await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      limit: 25,
      offset: 0,
    });

    expect(result.places).toHaveLength(2);
    expect(result.places[0].placeId).toBe(DEFAULT_PLACE_ID);
    expect(result.places[0].name).toBe("Place A");
    expect(result.places[1].placeId).toBe(SECOND_PLACE_ID);
    expect(result.pageInfo.total).toBe(2);
  });

  it("rejects non-staff users with forbidden", async () => {
    const deps = buildDeps({ staffAllowed: false });

    await expect(
      listPlatformPlaces(deps, {
        actorHumanId: STAFF_HUMAN_ID,
        limit: 25,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("passes verification status filter to the repo", async () => {
    const deps = buildDeps();

    await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      limit: 25,
      offset: 0,
      verificationStatus: ["PENDING"],
    });

    const listAllMock = deps.repos.places.listAll as ReturnType<typeof vi.fn>;
    expect(listAllMock).toHaveBeenCalledWith(
      expect.objectContaining({ verificationStatus: ["PENDING"] }),
    );
  });

  it("passes query filter to the repo", async () => {
    const deps = buildDeps();

    await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      limit: 10,
      offset: 0,
      query: "Warehouse",
    });

    const listAllMock = deps.repos.places.listAll as ReturnType<typeof vi.fn>;
    expect(listAllMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Warehouse", limit: 10 }),
    );
  });

  it("calculates ownerCount from org + human access arrays", async () => {
    const deps = buildDeps({
      places: [
        buildPlaceRecord({
          orgIdsWithAccess: ["org-1", "org-2"],
          humanIdsWithAccess: ["human-1"],
        }),
      ],
    });

    const result = await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      limit: 25,
      offset: 0,
    });

    expect(result.places[0].ownerCount).toBe(3);
  });

  it("validates input and rejects invalid actorHumanId", async () => {
    const deps = buildDeps();

    await expect(
      listPlatformPlaces(deps, {
        actorHumanId: "not-a-uuid",
        limit: 25,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns empty list when no places exist", async () => {
    const deps = buildDeps({ places: [], total: 0 });

    const result = await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      limit: 25,
      offset: 0,
    });

    expect(result.places).toHaveLength(0);
    expect(result.pageInfo.total).toBe(0);
  });

  it("passes the status filter to the repo (the Active / Archived chips)", async () => {
    const deps = buildDeps();
    const listAllMock = deps.repos.places.listAll as ReturnType<typeof vi.fn>;

    await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      status: ["ACTIVE", "SUSPENDED"],
    });
    expect(listAllMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: ["ACTIVE", "SUSPENDED"] }),
    );

    await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      status: ["ARCHIVED"],
    });
    expect(listAllMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: ["ARCHIVED"] }),
    );

    // "All": no status key, so the repo applies no status filter.
    await listPlatformPlaces(deps, { actorHumanId: STAFF_HUMAN_ID });
    expect(listAllMock.mock.lastCall?.[0]?.status).toBeUndefined();
  });

  it("passes the exact id filter to the repo, with no status or query added", async () => {
    const deps = buildDeps({
      places: [buildPlaceRecord({ id: SECOND_PLACE_ID, status: "ARCHIVED" })],
    });
    const listAllMock = deps.repos.places.listAll as ReturnType<typeof vi.fn>;

    const result = await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
      placeIds: [SECOND_PLACE_ID],
    });

    const call = listAllMock.mock.lastCall?.[0];
    expect(call?.placeIds).toEqual([SECOND_PLACE_ID]);
    expect(call?.status).toBeUndefined();
    expect(call?.query).toBeUndefined();
    expect(result.places).toEqual([
      expect.objectContaining({ placeId: SECOND_PLACE_ID, status: "ARCHIVED" }),
    ]);

    // No id filter: the repo gets none.
    await listPlatformPlaces(deps, { actorHumanId: STAFF_HUMAN_ID });
    expect(listAllMock.mock.lastCall?.[0]?.placeIds).toBeUndefined();
  });

  it("rejects an id filter that is empty, not a uuid, or over 50 ids", async () => {
    const deps = buildDeps();
    const tooMany = Array.from(
      { length: 51 },
      (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
    );

    for (const placeIds of [[], ["not-a-uuid"], tooMany]) {
      await expect(
        listPlatformPlaces(deps, { actorHumanId: STAFF_HUMAN_ID, placeIds }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(deps.repos.places.listAll).not.toHaveBeenCalled();
  });

  it("rejects an unknown status value", async () => {
    const deps = buildDeps();

    await expect(
      listPlatformPlaces(deps, {
        actorHumanId: STAFF_HUMAN_ID,
        status: ["DELETED"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("maps each place's public page path from one batched page read", async () => {
    const THIRD_PLACE_ID = "66666666-6666-4666-8666-666666666666";
    const FOURTH_PLACE_ID = "77777777-7777-4777-8777-777777777777";
    const deps = buildDeps({
      places: [
        buildPlaceRecord({ id: DEFAULT_PLACE_ID }),
        buildPlaceRecord({ id: SECOND_PLACE_ID }),
        buildPlaceRecord({ id: THIRD_PLACE_ID }),
        buildPlaceRecord({ id: FOURTH_PLACE_ID, status: "ARCHIVED" }),
      ],
      pages: [
        { ownerId: DEFAULT_PLACE_ID, slug: "nomad-warehouse", visibility: "PUBLIC" },
        { ownerId: SECOND_PLACE_ID, slug: "quiet-room", visibility: "UNLISTED" },
        { ownerId: THIRD_PLACE_ID, slug: "hidden-room", visibility: "PRIVATE" },
        { ownerId: FOURTH_PLACE_ID, slug: "old-hall", visibility: "PUBLIC" },
      ],
    });

    const result = await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
    });

    expect(result.places.map((p) => p.publicPath)).toEqual([
      "/places/nomad-warehouse",
      "/places/quiet-room",
      null, // PRIVATE pages 404 publicly
      "/places/old-hall", // an archived place's page still renders
    ]);
    const getByOwners = deps.repos.entityPages.getByOwners as ReturnType<
      typeof vi.fn
    >;
    expect(getByOwners).toHaveBeenCalledTimes(1);
    expect(getByOwners).toHaveBeenCalledWith("PLACE", [
      DEFAULT_PLACE_ID,
      SECOND_PLACE_ID,
      THIRD_PLACE_ID,
      FOURTH_PLACE_ID,
    ]);
  });

  it("publicPath is null for a place with no page", async () => {
    const deps = buildDeps({ pages: [] });

    const result = await listPlatformPlaces(deps, {
      actorHumanId: STAFF_HUMAN_ID,
    });

    expect(result.places[0].publicPath).toBeNull();
  });

  it("skips the page read when the list is empty", async () => {
    const deps = buildDeps({ places: [], total: 0 });

    await listPlatformPlaces(deps, { actorHumanId: STAFF_HUMAN_ID });

    expect(deps.repos.entityPages.getByOwners).not.toHaveBeenCalled();
  });

  it("a failed page read fails the list (dependency_failed), never a silent null publicPath", async () => {
    const deps = buildDeps();
    (
      deps.repos.entityPages.getByOwners as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("pages down"));

    await expect(
      listPlatformPlaces(deps, { actorHumanId: STAFF_HUMAN_ID }),
    ).rejects.toMatchObject({
      code: "dependency_failed",
      message: "repos.entityPages.getByOwners",
    });
  });
});
