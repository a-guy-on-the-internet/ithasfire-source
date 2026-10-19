import { describe, expect, it, vi } from "vitest";

import { getPlaceLayout } from "../get-place-layout";
import type { GetPlaceLayoutDeps } from "../get-place-layout";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-01-02T00:00:00.000Z");

const ACTOR_HUMAN_ID = "d5a53346-56ea-4803-b13c-7f2367514b6d";
const PLACE_ID = "15324f4d-ec0e-46d5-9ae3-27f1150cf802";
const ORG_ID = "abcdef12-3456-7890-abcd-ef1234567890";

function buildPlace(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    name: "Main Stage",
    slug: "main-stage",
    formattedAddress: "123 Test St",
    addressLine1: "123 Test St",
    addressLine2: null,
    city: "Testville",
    region: "TS",
    postalCode: "12345",
    countryCode: "US",
    capacity: 1000,
    lat: 40.0,
    lng: -74.0,
    status: "ACTIVE" as const,
    verificationStatus: "VERIFIED" as const,
    orgIdsWithAccess: [] as string[],
    humanIdsWithAccess: [ACTOR_HUMAN_ID],
    ...overrides,
  };
}

function buildLayout() {
  return {
    id: "layout-1",
    name: "default",
    placeId: PLACE_ID,
    checksum: "abc123",
    seatCount: 50,
    sectionCount: 2,
    seatIndexBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    sections: [
      {
        sectionId: "sec-1",
        label: "Orchestra",
        color: "#FF0000",
        capacity: 30,
      },
      {
        sectionId: "sec-2",
        label: "Balcony",
        color: "#0000FF",
        capacity: 20,
      },
    ],
    stage: {
      kind: "rectangle" as const,
      label: "Main Stage",
      bounds: { minX: 40, minY: 0, maxX: 60, maxY: 10 },
    },
    updatedAt: BASE_DATE,
    seatIds: ["seat-1", "seat-2"],
    createdByHumanId: ACTOR_HUMAN_ID,
  };
}

function buildDeps(
  overrides: Partial<GetPlaceLayoutDeps> = {},
): GetPlaceLayoutDeps {
  const placesRepo = {
    getById: vi.fn(async () => buildPlace()),
  };

  const placeLayoutsRepo = {
    getByPlace: vi.fn(async () => buildLayout()),
  };

  const placeLayoutBlobsRepo = {
    getGlyphUrl: vi.fn(async () => ({
      url: "https://storage.example.com/signed-url",
    })),
  };

  const authzRepo = {
    getOrgMemberships: vi.fn(async () => []),
  };

  const repos = {
    places: placesRepo,
    placeLayouts: placeLayoutsRepo,
    placeLayoutBlobs: placeLayoutBlobsRepo,
    authz: authzRepo,
  } as unknown as GetPlaceLayoutDeps["repos"];

  const logger = createTestLogger();

  return {
    repos,
    logger,
    ...overrides,
  };
}

describe("getPlaceLayout", () => {
  it("returns layout metadata + signed glyph URL for direct owner", async () => {
    const deps = buildDeps();

    const result = await getPlaceLayout(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    expect(result.layout).toMatchObject({
      id: "layout-1",
      name: "default",
      placeId: PLACE_ID,
      checksum: "abc123",
      seatCount: 50,
      sectionCount: 2,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      glyphBlobUrl: "https://storage.example.com/signed-url",
      createdByHumanId: ACTOR_HUMAN_ID,
    });
    expect(result.layout.sections).toHaveLength(2);
    expect(result.layout.stage).toMatchObject({
      kind: "rectangle",
      bounds: { minX: 40, minY: 0, maxX: 60, maxY: 10 },
    });
    expect(deps.repos.places.getById).toHaveBeenCalledWith(PLACE_ID);
    expect(deps.repos.placeLayouts.getByPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(deps.repos.placeLayoutBlobs.getGlyphUrl).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      checksum: "abc123",
    });
  });

  it("allows access via org membership", async () => {
    const placesRepo = {
      getById: vi.fn(async () =>
        buildPlace({
          humanIdsWithAccess: [],
          orgIdsWithAccess: [ORG_ID],
        }),
      ),
    };

    const authzRepo = {
      getOrgMemberships: vi.fn(async () => [
        {
          orgId: ORG_ID,
          humanId: ACTOR_HUMAN_ID,
          role: "admin",
        },
      ]),
    };

    const deps = buildDeps({
      repos: {
        places: placesRepo,
        placeLayouts: {
          getByPlace: vi.fn(async () => buildLayout()),
        },
        placeLayoutBlobs: {
          getGlyphUrl: vi.fn(async () => ({
            url: "https://storage.example.com/signed-url",
          })),
        },
        authz: authzRepo,
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    const result = await getPlaceLayout(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    expect(result.layout.id).toBe("layout-1");
    expect(authzRepo.getOrgMemberships).toHaveBeenCalledWith({
      orgIds: [ORG_ID],
      humanId: ACTOR_HUMAN_ID,
    });
  });

  it("throws not_found when place does not exist", async () => {
    const deps = buildDeps({
      repos: {
        places: { getById: vi.fn(async () => null) },
        placeLayouts: { getByPlace: vi.fn() },
        placeLayoutBlobs: { getGlyphUrl: vi.fn() },
        authz: { getOrgMemberships: vi.fn() },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    await expect(
      getPlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("throws forbidden when actor is not an owner", async () => {
    const deps = buildDeps({
      repos: {
        places: {
          getById: vi.fn(async () =>
            buildPlace({
              humanIdsWithAccess: ["other-human"],
              orgIdsWithAccess: [],
            }),
          ),
        },
        placeLayouts: { getByPlace: vi.fn() },
        placeLayoutBlobs: { getGlyphUrl: vi.fn() },
        authz: { getOrgMemberships: vi.fn() },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    await expect(
      getPlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws forbidden when org membership check fails", async () => {
    const deps = buildDeps({
      repos: {
        places: {
          getById: vi.fn(async () =>
            buildPlace({
              humanIdsWithAccess: [],
              orgIdsWithAccess: [ORG_ID],
            }),
          ),
        },
        placeLayouts: { getByPlace: vi.fn() },
        placeLayoutBlobs: { getGlyphUrl: vi.fn() },
        authz: {
          getOrgMemberships: vi.fn(async () => []),
        },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    await expect(
      getPlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found when layout does not exist", async () => {
    const deps = buildDeps({
      repos: {
        places: { getById: vi.fn(async () => buildPlace()) },
        placeLayouts: { getByPlace: vi.fn(async () => null) },
        placeLayoutBlobs: { getGlyphUrl: vi.fn() },
        authz: { getOrgMemberships: vi.fn() },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    await expect(
      getPlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: ACTOR_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "PLACE_LAYOUT_NOT_FOUND" });
  });

  it("returns null glyphBlobUrl when blob not found", async () => {
    const deps = buildDeps({
      repos: {
        places: { getById: vi.fn(async () => buildPlace()) },
        placeLayouts: { getByPlace: vi.fn(async () => buildLayout()) },
        placeLayoutBlobs: { getGlyphUrl: vi.fn(async () => null) },
        authz: { getOrgMemberships: vi.fn() },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    const result = await getPlaceLayout(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    expect(result.layout.glyphBlobUrl).toBeNull();
  });

  it("returns null glyphBlobUrl when blob fetch throws", async () => {
    const deps = buildDeps({
      repos: {
        places: { getById: vi.fn(async () => buildPlace()) },
        placeLayouts: { getByPlace: vi.fn(async () => buildLayout()) },
        placeLayoutBlobs: {
          getGlyphUrl: vi.fn(async () => {
            throw new Error("storage timeout");
          }),
        },
        authz: { getOrgMemberships: vi.fn() },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    const result = await getPlaceLayout(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    expect(result.layout.glyphBlobUrl).toBeNull();
    // Layout metadata is still returned despite blob error
    expect(result.layout.id).toBe("layout-1");
    expect(result.layout.seatCount).toBe(50);
  });

  it("rejects invalid input (bad placeId)", async () => {
    const deps = buildDeps();

    await expect(
      getPlaceLayout(deps, {
        placeId: "not-a-uuid",
        actorHumanId: ACTOR_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns layout without stage when stage is null", async () => {
    const layoutWithoutStage = { ...buildLayout(), stage: null };
    const deps = buildDeps({
      repos: {
        places: { getById: vi.fn(async () => buildPlace()) },
        placeLayouts: { getByPlace: vi.fn(async () => layoutWithoutStage) },
        placeLayoutBlobs: {
          getGlyphUrl: vi.fn(async () => ({
            url: "https://storage.example.com/signed",
          })),
        },
        authz: { getOrgMemberships: vi.fn() },
      } as unknown as GetPlaceLayoutDeps["repos"],
    });

    const result = await getPlaceLayout(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_HUMAN_ID,
    });

    expect(result.layout.stage).toBeNull();
    expect(result.layout.seatCount).toBe(50);
  });
});
