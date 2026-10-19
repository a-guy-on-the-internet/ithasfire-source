import { describe, expect, it, vi } from "vitest";

import { getPublicPlaceLayout } from "../get-public-place-layout";
import type { GetPublicPlaceLayoutDeps } from "../get-public-place-layout";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const LAYOUT_ID = "a1a1a1a1-b2b2-4c3c-9d4d-e5e5e5e5e5e5";
const PLACE_ID = "15324f4d-ec0e-46d5-9ae3-27f1150cf802";

function buildLayout() {
  return {
    id: LAYOUT_ID,
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
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    seatIds: ["seat-1", "seat-2"],
    createdByHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
  };
}

function buildDeps(
  overrides: Partial<GetPublicPlaceLayoutDeps> = {},
): GetPublicPlaceLayoutDeps {
  const placeLayoutsRepo = {
    getById: vi.fn(async () => buildLayout()),
  };

  const placeLayoutBlobsRepo = {
    getGlyphUrl: vi.fn(async () => ({
      url: "https://cdn.example.com/glyphs/abc123.json",
    })),
  };

  const repos = {
    placeLayouts: placeLayoutsRepo,
    placeLayoutBlobs: placeLayoutBlobsRepo,
  } as unknown as GetPublicPlaceLayoutDeps["repos"];

  const logger = createTestLogger();

  return {
    repos,
    logger,
    ...overrides,
  };
}

describe("getPublicPlaceLayout", () => {
  it("returns layout sections and geometry without admin fields", async () => {
    const deps = buildDeps();

    const result = await getPublicPlaceLayout(deps, {
      placeLayoutId: LAYOUT_ID,
    });

    expect(result.layout).toMatchObject({
      id: LAYOUT_ID,
      name: "default",
      seatCount: 50,
      sectionCount: 2,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    });

    expect(result.layout.sections).toHaveLength(2);
    expect(result.layout.sections[0]).toMatchObject({
      sectionId: "sec-1",
      label: "Orchestra",
      color: "#FF0000",
      capacity: 30,
    });
    expect(result.layout.stage).toMatchObject({
      kind: "rectangle",
      label: "Main Stage",
    });

    // Sensitive admin fields must not be present
    expect(result.layout).not.toHaveProperty("placeId");
    expect(result.layout).not.toHaveProperty("checksum");
    expect(result.layout).not.toHaveProperty("createdByHumanId");
    // glyphBlobUrl is null when includeGlyphs is not set
    expect(result.layout.glyphBlobUrl).toBeNull();
  });

  it("does not require ownership — no auth check", async () => {
    const deps = buildDeps();

    // No actorHumanId needed: the public use case skips ownership checks.
    const result = await getPublicPlaceLayout(deps, {
      placeLayoutId: LAYOUT_ID,
    });

    expect(result.layout.id).toBe(LAYOUT_ID);
    // repos.places should never be called
    expect(deps.repos).not.toHaveProperty("places");
  });

  it("throws not_found when layout does not exist", async () => {
    const deps = buildDeps({
      repos: {
        placeLayouts: {
          getById: vi.fn(async () => null),
        },
      } as unknown as GetPublicPlaceLayoutDeps["repos"],
    });

    await expect(
      getPublicPlaceLayout(deps, { placeLayoutId: LAYOUT_ID }),
    ).rejects.toMatchObject({ code: "PLACE_LAYOUT_NOT_FOUND" });
  });

  it("throws invalid_input for missing placeLayoutId", async () => {
    const deps = buildDeps();

    await expect(getPublicPlaceLayout(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("returns null stage when layout has no stage", async () => {
    const layout = buildLayout();
    layout.stage = null;

    const deps = buildDeps({
      repos: {
        placeLayouts: {
          getById: vi.fn(async () => layout),
        },
      } as unknown as GetPublicPlaceLayoutDeps["repos"],
    });

    const result = await getPublicPlaceLayout(deps, {
      placeLayoutId: LAYOUT_ID,
    });

    expect(result.layout.stage).toBeNull();
  });

  it("returns glyphBlobUrl when includeGlyphs is true", async () => {
    const deps = buildDeps();

    const result = await getPublicPlaceLayout(deps, {
      placeLayoutId: LAYOUT_ID,
      includeGlyphs: true,
    });

    expect(result.layout.glyphBlobUrl).toBe(
      "https://cdn.example.com/glyphs/abc123.json",
    );
    expect(deps.repos.placeLayoutBlobs.getGlyphUrl).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      checksum: "abc123",
    });
  });

  it("returns null glyphBlobUrl when blob fetch fails", async () => {
    const deps = buildDeps({
      repos: {
        placeLayouts: { getById: vi.fn(async () => buildLayout()) },
        placeLayoutBlobs: {
          getGlyphUrl: vi.fn(async () => {
            throw new Error("storage unavailable");
          }),
        },
      } as unknown as GetPublicPlaceLayoutDeps["repos"],
    });

    const result = await getPublicPlaceLayout(deps, {
      placeLayoutId: LAYOUT_ID,
      includeGlyphs: true,
    });

    expect(result.layout.glyphBlobUrl).toBeNull();
  });

  it("does not call placeLayoutBlobs when includeGlyphs is omitted", async () => {
    const deps = buildDeps();

    await getPublicPlaceLayout(deps, { placeLayoutId: LAYOUT_ID });

    expect(deps.repos.placeLayoutBlobs.getGlyphUrl).not.toHaveBeenCalled();
  });
});
